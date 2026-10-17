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
            if origin == "tauri://localhost" || origin == "http://tauri.localhost" {
                return true;
            }
            reqwest::Url::parse(origin).ok().is_some_and(|url| {
                url.scheme() == "http"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
                    && url.path() == "/"
                    && url.query().is_none()
                    && url.fragment().is_none()
            })
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
                    "instructions": "TrapSpoofer uses one shared job pipeline for spoofing existing assets, publishing local files, and granting Use permissions. First get_status and compare the upload profile/group with the target Studio game owner. get_settings/update_settings read and patch the UI settings; omitted fields stay unchanged. Example update_settings: {\"grantPermissions\":{\"enabled\":true,\"subjectType\":\"Group\",\"ids\":[\"764544807\"]}}. spoof_assets accepts per-call grantPermissions/skipOwned/keepNameAndDescription and dry_run. scan_studio lists local references and resolved disk paths. Example publish_assets: {\"files\":[{\"path\":\"/absolute/texture.png\"},{\"path\":\"/absolute/body.mesh\"}],\"pushToStudio\":true,\"studioPathMap\":{\"/absolute/texture.png\":\"rbxasset://textures/example.png\"}}. publish_folder accepts dir, recursive and glob. Mesh uploads create Model assets: use returned meshId in the game, not the model assetId. get_job(jobId,waitSeconds) returns only that job assets, a queued/running/finished/failed status and done flag. Waits cap at 100 seconds and return partial progress with done:false on timeout. summary:true returns counts and failures; includeMappings:true adds job-scoped mappings. get_history supports jobId and summary with compact entries. Mesh results include Roblox-space bounds and axisConversion; publish_assets/publish_folder accept normalizeCenter:true. apply_mesh_to_studio(meshId,instancePath,meshPartName?) creates or updates a MeshPart in the selected Edit Studio. lookup_ids reads local IDs; check_access checks Use permissions/ownership; recheck_moderation queries only tracked pending uploads without reuploading. Results include moderation approved/pending/rejected, cacheHit, per-asset permission granted/failed/not_requested, and pathMappings. Identical SHA256+profile/group resumes the cached asset/operation without a duplicate upload. Example grant_permissions: {\"assetIds\":[\"123456789\"],\"subjectType\":\"Group\",\"ids\":[\"764544807\"]}. get_permissions reads recipients. retry_failed(jobId) retries failed operations. dry_run:true on spoof_assets/publish_assets/publish_folder/grant_permissions inspects counts/types/destination/quota estimates without writes. Local replacements use the selected or explicit studioSessionId and the existing plugin; save the place after applying. Roblox moderation may remain pending after the bounded wait. Credentials stay inside the app and must never be requested or exposed.",
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

fn sanitized_payload(payload: &Value) -> Value {
    match payload {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter_map(|(key, value)| {
                    let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                    if matches!(
                        normalized.as_str(),
                        "cookie"
                            | "cookies"
                            | "fallbackcookies"
                            | "apikey"
                            | "groupapikey"
                            | "xapikey"
                            | "authorization"
                            | ".roblosecurity"
                    ) {
                        None
                    } else {
                        Some((key.clone(), sanitized_payload(value)))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sanitized_payload).collect()),
        other => other.clone(),
    }
}

fn tool_text(is_error: bool, payload: &Value) -> Value {
    let payload = sanitized_payload(payload);
    let text = match &payload {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prevents_cross_origin_localhost_prefix_bypasses() {
        for origin in ["http://localhost:5173", "http://127.0.0.1:14380", "tauri://localhost"] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", origin.parse().expect("header"));
            assert!(origin_allowed(&headers));
        }
        for origin in [
            "http://localhost.evil.example",
            "http://127.0.0.1.evil.example",
            "http://localhost@evil.example",
            "https://example.com",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", origin.parse().expect("header"));
            assert!(!origin_allowed(&headers));
        }
    }

    #[test]
    fn removes_nested_secrets_from_text_and_structured_responses() {
        let response = tool_text(
            false,
            &json!({"hasCookie":true,"cookie":"hidden-cookie","nested":[{"api_key":"hidden-key","path":"/Users/example/file.mesh"}]}),
        );
        let text = response.to_string();
        assert!(!text.contains("hidden-cookie"));
        assert!(!text.contains("hidden-key"));
        assert_eq!(response["structuredContent"]["hasCookie"], true);
        assert_eq!(response["structuredContent"]["nested"][0]["path"], "/Users/example/file.mesh");
    }
}
