//! `TrapSpoofer --mcp`: newline-delimited JSON-RPC over stdio, forwarded to the
//! HTTP MCP server of the running app. Starts the app if it isn't running.

use super::{MCP_PORT_END, MCP_PORT_START};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

async fn find_port(client: &reqwest::Client) -> Option<u16> {
    for port in MCP_PORT_START..=MCP_PORT_END {
        let url = format!("http://127.0.0.1:{port}/mcp-health");
        let Ok(resp) = client.get(&url).timeout(Duration::from_millis(400)).send().await else {
            continue;
        };
        if let Ok(body) = resp.json::<Value>().await {
            if body.get("app").and_then(Value::as_str) == Some("TrapSpoofer") {
                return Some(port);
            }
        }
    }
    None
}

async fn ensure_app(client: &reqwest::Client) -> Option<u16> {
    if let Some(port) = find_port(client).await {
        return Some(port);
    }
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).spawn();
    }
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(port) = find_port(client).await {
            return Some(port);
        }
    }
    None
}

fn error_reply(message: &Value, text: &str) -> Option<Value> {
    let id = message.get("id")?.clone();
    Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": text } }))
}

pub fn run() {
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread().enable_all().build() else {
        return;
    };
    runtime.block_on(async {
        let client = reqwest::Client::builder().no_proxy().build().unwrap_or_default();
        let mut port: Option<u16> = None;
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let mut stdout = tokio::io::stdout();

        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(line) else {
                continue;
            };

            if port.is_none() {
                port = ensure_app(&client).await;
            }
            let reply = match port {
                None => {
                    error_reply(&message, "TrapSpoofer is not running and could not be started.")
                }
                Some(p) => {
                    let url = format!("http://127.0.0.1:{p}/mcp");
                    match client
                        .post(&url)
                        .header("content-type", "application/json")
                        .header("accept", "application/json, text/event-stream")
                        .body(line.to_string())
                        .timeout(Duration::from_secs(1000))
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status() == reqwest::StatusCode::ACCEPTED => None,
                        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
                        Ok(resp) => {
                            let status = resp.status();
                            let text = resp.text().await.unwrap_or_default();
                            error_reply(&message, &format!("TrapSpoofer returned {status}: {text}"))
                        }
                        Err(err) => {
                            port = None;
                            error_reply(&message, &format!("Lost connection to TrapSpoofer: {err}"))
                        }
                    }
                }
            };

            if let Some(reply) = reply {
                let mut out = serde_json::to_string(&reply).unwrap_or_default();
                out.push('\n');
                if stdout.write_all(out.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        }
    });
}
