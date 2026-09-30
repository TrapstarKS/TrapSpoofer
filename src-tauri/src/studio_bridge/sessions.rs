use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use tokio::sync::RwLock;

use super::messages::AssetServerStateData;
use super::AppState;

type SessionData = Arc<RwLock<AssetServerStateData>>;

#[derive(Default)]
pub struct SessionRegistry {
    entries: RwLock<HashMap<String, SessionData>>,
}

impl SessionRegistry {
    pub async fn register(&self, id: &str) -> Result<SessionData, String> {
        if id.is_empty()
            || id.len() > 80
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid Studio session ID".into());
        }
        let mut entries = self.entries.write().await;
        if let Some(data) = entries.get(id) {
            let mut guard = data.write().await;
            if !connected(&guard) {
                let batch_size = guard.batch_size;
                let skip_owned_check = guard.skip_owned_check;
                *guard = AssetServerStateData::default();
                guard.batch_size = batch_size;
                guard.skip_owned_check = skip_owned_check;
                guard.last_plugin_poll_time = Some(Instant::now());
            }
            return Ok(Arc::clone(data));
        }
        entries.retain(|_, data| {
            data.try_read().map_or(true, |guard| {
                guard
                    .last_plugin_poll_time
                    .is_some_and(|time| time.elapsed() < Duration::from_secs(300))
            })
        });
        if entries.len() >= 64 {
            return Err("Too many Studio sessions".into());
        }
        let mut data = AssetServerStateData::default();
        if let Some(defaults) = super::bridge_data() {
            let defaults = defaults.read().await;
            data.batch_size = defaults.batch_size;
            data.skip_owned_check = defaults.skip_owned_check;
        }
        data.last_plugin_poll_time = Some(Instant::now());
        let data = Arc::new(RwLock::new(data));
        entries.insert(id.to_string(), Arc::clone(&data));
        Ok(data)
    }

    pub async fn snapshots(&self) -> Vec<(String, SessionData)> {
        self.entries.read().await.iter().map(|(id, data)| (id.clone(), Arc::clone(data))).collect()
    }

    pub async fn resolve(
        &self,
        id: Option<&str>,
        require_connected: bool,
    ) -> Result<(String, SessionData), String> {
        let snapshots = self.snapshots().await;
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            let entry =
                snapshots.into_iter().find(|(candidate, _)| candidate == id).ok_or_else(|| {
                    "The selected Studio window is no longer available. Select a connected window."
                        .to_string()
                })?;
            if require_connected && !connected(&*entry.1.read().await) {
                return Err(
                    "The selected Studio window disconnected. Reconnect it before continuing."
                        .into(),
                );
            }
            return Ok(entry);
        }
        let mut candidates = Vec::new();
        for entry in snapshots {
            if connected(&*entry.1.read().await) {
                candidates.push(entry);
            }
        }
        if candidates.len() != 1 {
            return Err(if candidates.is_empty() {
                "No Studio plugin is connected. Open Studio with the TrapSpoofer plugin."
            } else {
                "Several Studio windows are connected. Select the target window before continuing."
            }
            .into());
        }
        candidates.pop().ok_or_else(|| "No Studio session available".into())
    }
}

pub fn connected(data: &AssetServerStateData) -> bool {
    data.last_plugin_poll_time.is_some_and(|time| time.elapsed() < Duration::from_secs(30))
}

pub fn registry() -> &'static SessionRegistry {
    static REGISTRY: OnceLock<SessionRegistry> = OnceLock::new();
    REGISTRY.get_or_init(SessionRegistry::default)
}

pub struct StudioSession(pub AppState);

#[axum::async_trait]
impl FromRequestParts<AppState> for StudioSession {
    type Rejection = (StatusCode, String);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let id = parts.headers.get("x-trapspoofer-session").and_then(|value| value.to_str().ok());
        let is_poll = parts.uri.path().starts_with("/poll");
        let result = if is_poll {
            let id = id.unwrap_or("legacy");
            registry().register(id).await.map(|data| (id.to_string(), data))
        } else {
            registry().resolve(id, true).await
        };
        let (session_id, data) = result.map_err(|error| (StatusCode::CONFLICT, error))?;
        let mut scoped = state.clone();
        scoped.data = data;
        scoped.session_id = session_id;
        scoped.scan_id = parts
            .headers
            .get("x-trapspoofer-scan")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if parts.uri.path().starts_with("/scan-") && scoped.session_id != "legacy" {
            let Some(scan_id) =
                scoped.scan_id.as_deref().filter(|id| uuid::Uuid::parse_str(id).is_ok())
            else {
                return Err((StatusCode::BAD_REQUEST, "Missing scan ID".into()));
            };
            if parts.uri.path() != "/scan-start" {
                let guard = scoped.data.read().await;
                if guard.active_scan_id.as_deref() != Some(scan_id)
                    && !(parts.uri.path() == "/scan-complete"
                        && guard.completed_scan_id.as_deref() == Some(scan_id))
                {
                    return Err((StatusCode::CONFLICT, "This scan is no longer active".into()));
                }
            }
        }
        Ok(Self(scoped))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn isolates_two_windows_with_the_same_place_and_rejects_ambiguous_targets() {
        let registry = SessionRegistry::default();
        let first = registry.register("window-a").await.expect("first");
        let second = registry.register("window-b").await.expect("second");
        first.write().await.studio_place_id = Some("123".into());
        second.write().await.studio_place_id = Some("123".into());
        first
            .write()
            .await
            .stored_mappings
            .push(serde_json::json!({"originalId": "1", "newId": "2"}));
        assert!(second.read().await.stored_mappings.is_empty());
        assert!(registry.resolve(None, true).await.is_err());
        let (_, resolved) =
            registry.resolve(Some("window-a"), true).await.expect("explicit target");
        assert!(Arc::ptr_eq(&first, &resolved));
    }

    #[tokio::test]
    async fn never_redirects_a_disconnected_target_to_another_window() {
        let registry = SessionRegistry::default();
        let first = registry.register("first").await.expect("first");
        registry.register("second").await.expect("second");
        first.write().await.last_plugin_poll_time = Some(Instant::now() - Duration::from_secs(31));
        assert!(registry.resolve(Some("first"), true).await.is_err());
        assert!(registry.resolve(Some("missing"), true).await.is_err());
        assert_eq!(registry.resolve(None, true).await.expect("sole live session").0, "second");
    }
}
