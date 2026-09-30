use super::roblox_api::ResolverAsset;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

const OWNER_TTL_SECS: i64 = 7 * 24 * 60 * 60;
const MAX_OWNER_ENTRIES: i64 = 50_000;

pub struct OwnerCache {
    connection: Connection,
}

impl OwnerCache {
    fn new(connection: Connection) -> rusqlite::Result<Self> {
        connection.busy_timeout(std::time::Duration::from_secs(2))?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS asset_owners (
                asset_id TEXT PRIMARY KEY,
                creator_id TEXT NOT NULL,
                creator_type TEXT NOT NULL,
                creator_name TEXT,
                asset_name TEXT,
                checked_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS asset_owners_checked_at ON asset_owners(checked_at);",
        )?;
        Ok(Self { connection })
    }

    fn get(&self, asset_id: &str, now: i64) -> rusqlite::Result<Option<ResolverAsset>> {
        self.connection
            .query_row(
                "SELECT creator_id, creator_type, creator_name, asset_name FROM asset_owners
                 WHERE asset_id = ?1 AND checked_at > ?2 AND checked_at <= ?3",
                params![asset_id, now - OWNER_TTL_SECS, now],
                |row| {
                    Ok(ResolverAsset {
                        asset_id: asset_id.to_string(),
                        creator_id: Some(row.get(0)?),
                        creator_type: Some(row.get(1)?),
                        creator: row.get(2)?,
                        name: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    fn put(&mut self, asset: &ResolverAsset, now: i64) -> rusqlite::Result<()> {
        let Some((creator_type, creator_id)) = valid_creator(asset) else {
            return Ok(());
        };
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO asset_owners (asset_id, creator_id, creator_type, creator_name, asset_name, checked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(asset_id) DO UPDATE SET
                creator_id = excluded.creator_id,
                creator_type = excluded.creator_type,
                creator_name = COALESCE(excluded.creator_name, asset_owners.creator_name),
                asset_name = COALESCE(excluded.asset_name, asset_owners.asset_name),
                checked_at = excluded.checked_at",
            params![asset.asset_id, creator_id, creator_type, asset.creator, asset.name, now],
        )?;
        transaction
            .execute("DELETE FROM asset_owners WHERE checked_at <= ?1", [now - OWNER_TTL_SECS])?;
        transaction.execute(
            "DELETE FROM asset_owners WHERE asset_id IN (
                SELECT asset_id FROM asset_owners ORDER BY checked_at DESC, asset_id DESC LIMIT -1 OFFSET ?1
            )",
            [MAX_OWNER_ENTRIES],
        )?;
        transaction.commit()
    }

    fn clear(&self) -> rusqlite::Result<()> {
        self.connection.execute("DELETE FROM asset_owners", [])?;
        Ok(())
    }
}

fn valid_creator(asset: &ResolverAsset) -> Option<(&'static str, &str)> {
    let creator_id = asset.creator_id.as_deref()?;
    if !valid_id(&asset.asset_id) || !valid_id(creator_id) {
        return None;
    }
    let creator_type = asset.creator_type.as_deref()?;
    if creator_type.eq_ignore_ascii_case("user") {
        Some(("User", creator_id))
    } else if creator_type.eq_ignore_ascii_case("group") {
        Some(("Group", creator_id))
    } else {
        None
    }
}

fn valid_id(value: &str) -> bool {
    value.parse::<u64>().is_ok_and(|id| id > 0) && value.bytes().all(|b| b.is_ascii_digit())
}

static CACHE: OnceLock<Mutex<OwnerCache>> = OnceLock::new();
static LOOKUP_LOCKS: OnceLock<Vec<Arc<AsyncMutex<()>>>> = OnceLock::new();

pub fn initialize(cache_dir: &Path) -> crate::error::Result<()> {
    if CACHE.get().is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(cache_dir)?;
    let connection = Connection::open(cache_dir.join("asset_owners.sqlite3"))
        .map_err(|error| crate::error::AppError::Custom(error.to_string()))?;
    let cache = OwnerCache::new(connection)
        .map_err(|error| crate::error::AppError::Custom(error.to_string()))?;
    let _ = CACHE.set(Mutex::new(cache));
    Ok(())
}

pub async fn lookup_lock(asset_id: &str) -> OwnedMutexGuard<()> {
    let locks =
        LOOKUP_LOCKS.get_or_init(|| (0..128).map(|_| Arc::new(AsyncMutex::new(()))).collect());
    let index =
        asset_id.bytes().fold(0usize, |hash, byte| (hash * 31 + usize::from(byte)) % locks.len());
    Arc::clone(&locks[index]).lock_owned().await
}

pub fn get(asset_id: &str) -> Option<ResolverAsset> {
    CACHE.get()?.lock().ok()?.get(asset_id, chrono::Utc::now().timestamp()).ok().flatten()
}

pub fn put(asset: &ResolverAsset) {
    if let Some(cache) = CACHE.get() {
        if let Ok(mut cache) = cache.lock() {
            if let Err(error) = cache.put(asset, chrono::Utc::now().timestamp()) {
                log::warn!("Could not cache asset owner: {error}");
            }
        }
    }
}

pub fn remember(asset_id: &str, creator_type: &str, creator_id: &str, name: Option<String>) {
    put(&ResolverAsset {
        asset_id: asset_id.to_string(),
        creator_id: Some(creator_id.to_string()),
        creator_type: Some(creator_type.to_string()),
        creator: Some(creator_id.to_string()),
        name,
    });
}

pub fn clear() -> crate::error::Result<()> {
    if let Some(cache) = CACHE.get() {
        let cache =
            cache.lock().map_err(|error| crate::error::AppError::Custom(error.to_string()))?;
        cache.clear().map_err(|error| crate::error::AppError::Custom(error.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> ResolverAsset {
        ResolverAsset {
            asset_id: "123456".into(),
            creator_id: Some("999".into()),
            creator_type: Some("group".into()),
            creator: Some("Group name".into()),
            name: Some("Animation".into()),
        }
    }

    #[test]
    fn expires_and_rejects_unknown_owners() {
        let mut cache =
            OwnerCache::new(Connection::open_in_memory().expect("database")).expect("cache");
        let mut asset = owner();
        cache.put(&asset, 100).expect("write");
        assert_eq!(
            cache.get("123456", 101).expect("read").expect("owner").creator_type.as_deref(),
            Some("Group")
        );
        assert!(cache.get("123456", 100 + OWNER_TTL_SECS).expect("read").is_none());
        asset.asset_id = "777".into();
        asset.creator_id = None;
        cache.put(&asset, 100).expect("unknown ignored");
        assert!(cache.get("777", 101).expect("read").is_none());
        cache.clear().expect("clear");
        assert!(cache.get("123456", 101).expect("read").is_none());
    }

    #[test]
    fn persists_and_updates_creator_without_losing_name() {
        let path = std::env::temp_dir()
            .join(format!("trapspoofer-owners-{}.sqlite3", uuid::Uuid::new_v4()));
        {
            let mut cache =
                OwnerCache::new(Connection::open(&path).expect("database")).expect("cache");
            cache.put(&owner(), 100).expect("write");
        }
        {
            let mut cache =
                OwnerCache::new(Connection::open(&path).expect("database")).expect("cache");
            let mut asset = owner();
            asset.creator_type = Some("User".into());
            asset.creator_id = Some("888".into());
            asset.name = None;
            cache.put(&asset, 102).expect("update");
            let saved = cache.get("123456", 103).expect("read").expect("owner");
            assert_eq!(saved.creator_id.as_deref(), Some("888"));
            assert_eq!(saved.creator_type.as_deref(), Some("User"));
            assert_eq!(saved.name.as_deref(), Some("Animation"));
        }
        std::fs::remove_file(path).expect("cleanup");
    }
}
