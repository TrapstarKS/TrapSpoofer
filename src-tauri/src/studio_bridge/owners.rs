use super::messages::AssetServerStateData;
use futures::{stream, StreamExt};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

const OWNER_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, PartialEq)]
struct PlaceOwner {
    creator_type: String,
    creator_id: String,
}

type OwnerCache = dashmap::DashMap<String, (Instant, Option<PlaceOwner>)>;

fn numeric_id(value: &Value) -> Option<String> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse::<u64>().ok())
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
}

fn parse_owner(response: &Value, universe_id: &str) -> Option<PlaceOwner> {
    let game = response
        .get("data")?
        .as_array()?
        .iter()
        .find(|game| game.get("id").and_then(numeric_id).as_deref() == Some(universe_id))?;
    let creator = game.get("creator")?;
    let creator_type = match creator.get("type")?.as_str()?.to_ascii_lowercase().as_str() {
        "user" => "User",
        "group" => "Group",
        _ => return None,
    };
    Some(PlaceOwner {
        creator_type: creator_type.into(),
        creator_id: numeric_id(creator.get("id")?)?,
    })
}

async fn lookup_owner(place_id: &str) -> Option<PlaceOwner> {
    let client = crate::utils::get_http_client();
    let universe: Value = client
        .get(format!("https://apis.roblox.com/universes/v1/places/{place_id}/universe"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    let universe_id = numeric_id(universe.get("universeId")?)?;
    let games: Value = client
        .get(format!("https://games.roblox.com/v1/games?universeIds={universe_id}"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    parse_owner(&games, &universe_id)
}

async fn cached_owner(place_id: String) -> (String, Instant, Option<PlaceOwner>) {
    static CACHE: OnceLock<OwnerCache> = OnceLock::new();
    let cache = CACHE.get_or_init(dashmap::DashMap::new);
    if let Some(cached) = cache.get(&place_id) {
        if cached.value().0.elapsed() < OWNER_CACHE_TTL {
            return (place_id, cached.value().0, cached.value().1.clone());
        }
    }
    let owner =
        tokio::time::timeout(Duration::from_secs(8), lookup_owner(&place_id)).await.ok().flatten();
    let resolved_at = Instant::now();
    cache.retain(|_, value| value.0.elapsed() < OWNER_CACHE_TTL);
    cache.insert(place_id.clone(), (resolved_at, owner.clone()));
    (place_id, resolved_at, owner)
}

pub async fn refresh_missing_owners(sessions: &[(String, Arc<RwLock<AssetServerStateData>>)]) {
    let mut places = BTreeSet::new();
    for (_, data) in sessions {
        let guard = data.read().await;
        let expired =
            guard.studio_creator_resolved_at.is_some_and(|at| at.elapsed() >= OWNER_CACHE_TTL);
        if guard.studio_creator_type.is_some() && guard.studio_creator_id.is_some() && !expired {
            continue;
        }
        if let Some(id) = guard
            .studio_place_id
            .as_deref()
            .and_then(|id| id.parse::<u64>().ok())
            .filter(|id| *id > 0)
        {
            places.insert(id.to_string());
        }
    }
    let refresh = async {
        let mut lookups = stream::iter(places.into_iter().map(cached_owner)).buffer_unordered(3);
        while let Some((place_id, resolved_at, owner)) = lookups.next().await {
            let Some(owner) = owner else { continue };
            for (_, data) in sessions {
                let mut guard = data.write().await;
                if guard.studio_place_id.as_deref() == Some(place_id.as_str())
                    && (guard.studio_creator_type.is_none()
                        || guard.studio_creator_id.is_none()
                        || guard.studio_creator_resolved_at.is_some())
                {
                    guard.studio_creator_type = Some(owner.creator_type.clone());
                    guard.studio_creator_id = Some(owner.creator_id.clone());
                    guard.studio_creator_resolved_at = Some(resolved_at);
                }
            }
        }
    };
    let _ = tokio::time::timeout(Duration::from_secs(10), refresh).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_only_valid_creators_for_the_requested_universe() {
        let response = json!({"data": [
            {"id": 123, "creator": {"id": 456, "type": "Group"}},
            {"id": "789", "creator": {"id": "987", "type": "user"}}
        ]});
        assert_eq!(
            parse_owner(&response, "123"),
            Some(PlaceOwner { creator_type: "Group".into(), creator_id: "456".into() })
        );
        assert_eq!(
            parse_owner(&response, "789"),
            Some(PlaceOwner { creator_type: "User".into(), creator_id: "987".into() })
        );
        assert!(parse_owner(&response, "999").is_none());
        assert!(parse_owner(
            &json!({"data": [{"id": 123, "creator": {"id": 0, "type": "Group"}}]}),
            "123"
        )
        .is_none());
        assert!(parse_owner(
            &json!({"data": [{"id": 123, "creator": {"id": 456, "type": "Unknown"}}]}),
            "123"
        )
        .is_none());
    }
}
