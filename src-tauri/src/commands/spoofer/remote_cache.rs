//! Local (in-process) cache of asset -> place discoveries.
//!
//! TrapSpoofer never sends discoveries to any third-party server. The cache is
//! purely local: it is filled as downloads succeed and optionally seeded from a
//! `local_remote_cache.json` file in the app data directory.

use dashmap::DashMap;
use std::sync::OnceLock;

const MAX_LOCAL_ENTRIES: usize = 50_000;
const EVICT_BATCH: usize = 10_000;

#[derive(Clone, Debug)]
pub struct CachedContext {
    pub place_id: String,
    pub is_invalidated: bool,
}

static LOCAL_CACHE: OnceLock<DashMap<String, CachedContext>> = OnceLock::new();

fn get_local_cache() -> &'static DashMap<String, CachedContext> {
    LOCAL_CACHE.get_or_init(DashMap::new)
}

pub fn get_local_context(asset_id: &str) -> Option<String> {
    let cache = get_local_cache();
    if let Some(entry) = cache.get(asset_id) {
        if !entry.is_invalidated {
            return Some(entry.place_id.clone());
        }
    }
    None
}

pub fn invalidate_context(asset_id: &str) {
    let cache = get_local_cache();
    if let Some(mut entry) = cache.get_mut(asset_id) {
        entry.is_invalidated = true;
    }
}

fn is_numeric_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

fn insert_local(asset_id: String, place_id: String) {
    let cache = get_local_cache();
    cache.insert(asset_id, CachedContext { place_id, is_invalidated: false });

    if cache.len() > MAX_LOCAL_ENTRIES {
        let to_remove: Vec<String> =
            cache.iter().take(EVICT_BATCH).map(|e| e.key().clone()).collect();
        for key in to_remove {
            cache.remove(&key);
        }
    }
}

/// Records a successful asset -> place discovery in the local cache only.
/// Nothing is sent over the network.
pub async fn push_discovery(asset_id: String, place_id: String) -> Result<(), String> {
    if is_numeric_id(&asset_id) && is_numeric_id(&place_id) {
        insert_local(asset_id, place_id);
    }
    Ok(())
}

/// Kept for frontend compatibility. `push_url` is ignored: TrapSpoofer has no
/// community cache and never uploads discoveries anywhere. If a legacy
/// `local_remote_cache.json` exists, its entries are loaded into the local cache.
#[tauri::command]
#[specta::specta]
pub async fn initialize_remote_cache(
    app: tauri::AppHandle,
    push_url: Option<String>,
) -> Result<(), String> {
    if push_url.as_deref().is_some_and(|url| !url.trim().is_empty()) {
        log::info!("initialize_remote_cache: push URL ignored (community cache is disabled)");
    }

    use tauri::Manager;
    if let Ok(app_dir) = app.path().app_data_dir() {
        let cache_path = app_dir.join("local_remote_cache.json");
        if let Ok(content) = tokio::fs::read_to_string(&cache_path).await {
            load_local_entries(&content);
        }
    }

    Ok(())
}

fn load_local_entries(content: &str) -> usize {
    let Ok(existing) = serde_json::from_str::<std::collections::HashMap<String, String>>(content)
    else {
        return 0;
    };
    let mut loaded = 0;
    for (asset_id, place_id) in existing {
        if is_numeric_id(&asset_id) && is_numeric_id(&place_id) {
            insert_local(asset_id, place_id);
            loaded += 1;
        }
    }
    loaded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn push_discovery_is_local_only() {
        push_discovery("9900112233".to_string(), "4455667788".to_string())
            .await
            .expect("local push never fails");
        assert_eq!(get_local_context("9900112233").as_deref(), Some("4455667788"));

        invalidate_context("9900112233");
        assert_eq!(get_local_context("9900112233"), None);
    }

    #[test]
    fn load_local_entries_skips_invalid_ids() {
        let loaded = load_local_entries(r#"{"1122334455":"5544332211","abc":"1","7":"x"}"#);
        assert_eq!(loaded, 1);
        assert_eq!(get_local_context("1122334455").as_deref(), Some("5544332211"));
        assert_eq!(load_local_entries("not json"), 0);
    }
}
