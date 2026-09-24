//! Local MCP (Model Context Protocol) server.
//!
//! Speaks JSON-RPC 2.0 over the "Streamable HTTP" transport on
//! `http://127.0.0.1:<port>/mcp` (plain JSON responses, no SSE). Tool calls are
//! relayed to the frontend through the `mcp://request` event and answered with
//! the `mcp_respond` command, so AI agents drive exactly the same code paths as
//! the UI (profiles, credentials, scan state, job pipeline).
//!
//! `TrapSpoofer.exe --mcp` runs [`stdio::run`], a stdio <-> HTTP proxy for
//! clients that only support stdio servers (Claude Desktop, Cursor...).

pub mod stdio;
pub mod tools;

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub const MCP_PORT_START: u16 = 14380;
pub const MCP_PORT_END: u16 = 14389;
const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

static ENABLED: AtomicBool = AtomicBool::new(true);
static FRONTEND_READY: AtomicBool = AtomicBool::new(false);
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

type Pending = DashMap<String, oneshot::Sender<ToolReply>>;

struct ToolReply {
    is_error: bool,
    payload: Value,
}

fn pending() -> &'static Pending {
    static PENDING: OnceLock<Pending> = OnceLock::new();
    PENDING.get_or_init(DashMap::new)
}

#[derive(Clone)]
struct McpState {
    app: AppHandle,
}

pub async fn start_server(app: AppHandle) {
    let mut listener = None;
    for port in MCP_PORT_START..=MCP_PORT_END {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        if let Ok(bound) = tokio::net::TcpListener::bind(addr).await {
            listener = Some((bound, port));
            break;
        }
    }
    let Some((listener, port)) = listener else {
        log::error!("MCP server: ports {MCP_PORT_START}-{MCP_PORT_END} are all in use");
        return;
    };
    BOUND_PORT.store(port, Ordering::SeqCst);

    let router = Router::new()
        .route("/mcp", post(handle_post).get(handle_get).delete(handle_delete))
        .route(
            "/mcp-health",
            get(|| async {
                Json(json!({
                    "app": "TrapSpoofer",
                    "mcp": true,
                    "enabled": ENABLED.load(Ordering::SeqCst),
                    "version": env!("CARGO_PKG_VERSION"),
                }))
            }),
        )
        .with_state(McpState { app });

    log::info!("MCP server listening on http://127.0.0.1:{port}/mcp");
    if let Err(err) = axum::serve(listener, router).await {
        log::error!("MCP server stopped: {err}");
    }
    BOUND_PORT.store(0, Ordering::SeqCst);
}

/// Browsers always attach `Origin` to cross-site requests; local MCP clients
/// don't. Rejecting any foreign origin blocks drive-by requests from web pages
/// (DNS rebinding / CSRF against localhost).
fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get(axum::http::header::ORIGIN).and_then(|v| v.to_str().ok()) {
        None => true,
        Some(origin) => {
            origin.starts_with("http://localhost")
                || origin.starts_with("http://127.0.0.1")
                || origin == "tauri://localhost"
                || origin == "http://tauri.localhost"
        }
    }
}

async fn handle_get() -> impl IntoResponse {
    // No server-initiated stream: tell the client to use plain POST responses.
    (StatusCode::METHOD_NOT_ALLOWED, "SSE stream not supported; use POST")
}

async fn handle_delete() -> impl IntoResponse {
    StatusCode::OK
}

async fn handle_post(State(state): State<McpState>, headers: HeaderMap, body: Bytes) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }
    if !ENABLED.load(Ordering::SeqCst) {
        return (StatusCode::SERVICE_UNAVAILABLE, "MCP is disabled in TrapSpoofer settings")
            .into_response();
    }
    let parsed: Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            return Json(rpc_error(Value::Null, -32700, &format!("Parse error: {err}")))
                .into_response();
        }
    };

    if let Value::Array(batch) = parsed {
        let mut replies = Vec::new();
        for message in batch {
            if let Some(reply) = dispatch(&state, message).await {
                replies.push(reply);
            }
        }
        if replies.is_empty() {
            return StatusCode::ACCEPTED.into_response();
        }
        return Json(Value::Array(replies)).into_response();
    }

    match dispatch(&state, parsed).await {
        Some(reply) => {
            let mut response = Json(reply).into_response();
            if let Ok(value) = "trapspoofer".parse() {
                response.headers_mut().insert("mcp-session-id", value);
            }
            response
        }
        None => StatusCode::ACCEPTED.into_response(),
    }
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Returns `None` for notifications (no `id`).
async fn dispatch(state: &McpState, message: Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
    let id = message.get("id").cloned();
    let params = message.get("params").cloned().unwrap_or(Value::Null);

    let Some(id) = id else {
        // notifications/initialized, notifications/cancelled, ...
        return None;
    };

    let reply = match method.as_str() {
        "initialize" => {
            let requested =
                params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL_VERSION);
            let version =
                if SUPPORTED_PROTOCOLS.contains(&requested) { requested } else { PROTOCOL_VERSION };
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "trapspoofer", "title": "TrapSpoofer", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": "TrapSpoofer re-uploads (spoofs) Roblox assets to the user's own account or group and patches the new ids into Roblox Studio. Typical flow: get_status -> scan_studio (or scan_file) -> list_assets -> spoof_assets -> get_job (waitSeconds) -> push_to_studio (or write_spoofed_file). Always confirm with the user before spoofing large batches.",
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": tools::list_json() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
            let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match tools::find(name) {
                None => rpc_error(id, -32602, &format!("Unknown tool: {name}")),
                Some(tool) => {
                    let result = call_frontend(&state.app, tool, arguments).await;
                    rpc_result(id, result)
                }
            }
        }
        "resources/list" => rpc_result(id, json!({ "resources": [] })),
        "prompts/list" => rpc_result(id, json!({ "prompts": [] })),
        other => rpc_error(id, -32601, &format!("Method not found: {other}")),
    };
    Some(reply)
}

fn tool_text(is_error: bool, payload: &Value) -> Value {
    let text = match payload {
        Value::String(s) => s.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let mut result = json!({ "content": [{ "type": "text", "text": text }], "isError": is_error });
    if !is_error && payload.is_object() {
        result["structuredContent"] = payload.clone();
    }
    result
}

async fn call_frontend(app: &AppHandle, tool: &tools::ToolDef, arguments: Value) -> Value {
    if !FRONTEND_READY.load(Ordering::SeqCst) {
        return tool_text(
            true,
            &Value::String(
                "TrapSpoofer is still starting. Open the app window and try again.".into(),
            ),
        );
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    pending().insert(request_id.clone(), tx);

    let emitted = app.emit(
        "mcp://request",
        json!({ "requestId": request_id, "tool": tool.name, "arguments": arguments }),
    );
    if let Err(err) = emitted {
        pending().remove(&request_id);
        return tool_text(true, &Value::String(format!("Could not reach the app UI: {err}")));
    }

    match tokio::time::timeout(Duration::from_secs(tool.timeout_secs), rx).await {
        Ok(Ok(reply)) => tool_text(reply.is_error, &reply.payload),
        Ok(Err(_)) => tool_text(true, &Value::String("The app dropped the request.".into())),
        Err(_) => {
            pending().remove(&request_id);
            tool_text(
                true,
                &Value::String(format!(
                    "Timed out after {}s waiting for TrapSpoofer.",
                    tool.timeout_secs
                )),
            )
        }
    }
}

/// Frontend answer to an `mcp://request` event. `payload` is a JSON string.
#[tauri::command]
#[specta::specta]
pub fn mcp_respond(request_id: String, is_error: bool, payload: String) -> bool {
    let Some((_, sender)) = pending().remove(&request_id) else {
        return false;
    };
    let payload = serde_json::from_str(&payload).unwrap_or(Value::String(payload));
    sender.send(ToolReply { is_error, payload }).is_ok()
}

/// Called by the frontend once its `mcp://request` listener is registered.
#[tauri::command]
#[specta::specta]
pub fn mcp_set_frontend_ready(ready: bool) {
    FRONTEND_READY.store(ready, Ordering::SeqCst);
}

#[tauri::command]
#[specta::specta]
pub fn mcp_set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub enabled: bool,
    pub port: Option<u16>,
    pub url: Option<String>,
    pub executable: String,
    pub tools: Vec<String>,
}

#[tauri::command]
#[specta::specta]
#[must_use]
pub fn mcp_get_info() -> McpInfo {
    let port = match BOUND_PORT.load(Ordering::SeqCst) {
        0 => None,
        port => Some(port),
    };
    McpInfo {
        enabled: ENABLED.load(Ordering::SeqCst),
        port,
        url: port.map(|p| format!("http://127.0.0.1:{p}/mcp")),
        executable: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        tools: tools::TOOLS.iter().map(|tool| tool.name.to_string()).collect(),
    }
}
