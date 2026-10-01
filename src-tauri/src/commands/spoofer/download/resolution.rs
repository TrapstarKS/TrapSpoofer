use super::is_valid_numeric_id;

#[path = "discovery_cache.rs"]
mod discovery_cache;

use discovery_cache::{collect_discoveries, DiscoveryCache, DiscoveryKey};
use reqwest::header::{COOKIE, USER_AGENT};
use std::collections::HashSet;
use std::sync::OnceLock;
use tauri::AppHandle;

const MAX_GROUP_CRAWL_LIMIT: usize = 5;
const MAX_GROUP_FRIEND_CRAWL_LIMIT: usize = 8;
const MAX_FRIEND_CRAWL_LIMIT: usize = 15;

type AuthUserCache = dashmap::DashMap<String, u64>;
type UserGroupsCache = DiscoveryCache<Vec<(u64, Option<u64>)>>;
type UserFriendsCache = DiscoveryCache<Vec<u64>>;
type CreatorGamesCache = DiscoveryCache<Vec<String>>;
type SocialGraphCache = DiscoveryCache<Vec<String>>;

type GroupOwnerCache = DiscoveryCache<Option<u64>>;

static AUTH_USER_ID_CACHE: OnceLock<AuthUserCache> = OnceLock::new();
static USER_GROUPS_CACHE: OnceLock<UserGroupsCache> = OnceLock::new();
static USER_FRIENDS_CACHE: OnceLock<UserFriendsCache> = OnceLock::new();
static CREATOR_GAMES_CACHE: OnceLock<CreatorGamesCache> = OnceLock::new();
static SOCIAL_GRAPH_CACHE: OnceLock<SocialGraphCache> = OnceLock::new();
static GROUP_OWNER_CACHE: OnceLock<GroupOwnerCache> = OnceLock::new();
static DISCOVERY_REQUESTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(8);

fn auth_user_id_cache() -> &'static AuthUserCache {
    AUTH_USER_ID_CACHE.get_or_init(dashmap::DashMap::new)
}
fn user_groups_cache() -> &'static UserGroupsCache {
    USER_GROUPS_CACHE.get_or_init(DiscoveryCache::new)
}
fn user_friends_cache() -> &'static UserFriendsCache {
    USER_FRIENDS_CACHE.get_or_init(DiscoveryCache::new)
}
fn creator_games_cache() -> &'static CreatorGamesCache {
    CREATOR_GAMES_CACHE.get_or_init(DiscoveryCache::new)
}
fn social_graph_cache() -> &'static SocialGraphCache {
    SOCIAL_GRAPH_CACHE.get_or_init(DiscoveryCache::new)
}
fn group_owner_cache() -> &'static GroupOwnerCache {
    GROUP_OWNER_CACHE.get_or_init(DiscoveryCache::new)
}

pub fn prewarm_creator_info_cache<I>(entries: I)
where
    I: IntoIterator<Item = (String, (String, u64))>,
{
    for (asset_id, (creator_type, creator_id)) in entries {
        if creator_id == 0 || creator_type.is_empty() {
            continue;
        }
        crate::domain::asset_owners::remember(
            &asset_id,
            &creator_type,
            &creator_id.to_string(),
            None,
        );
    }
}

pub async fn resolve_asset_id_location(
    app: &AppHandle,
    _client: &reqwest::Client,
    asset_id: &str,
    cookie_header: &str,
    place_id: Option<&str>,
) -> crate::error::Result<Option<String>> {
    let resolve_client = crate::utils::get_http_client();
    let asset_url = format!("https://assetdelivery.roblox.com/v1/assetId/{asset_id}");
    let mut req = resolve_client
        .get(&asset_url)
        .header(COOKIE, cookie_header)
        .header(USER_AGENT, "RobloxStudio/WinInet");
    req = crate::commands::spoofer::apply_roblox_game_context(req, place_id, None);

    let resp = req.send().await?;
    crate::utils::check_for_roblosecurity_update(app, &resp, cookie_header);

    if !resp.status().is_success() {
        return Ok(None);
    }

    if let Ok(data) = resp.json::<serde_json::Value>().await {
        Ok(data
            .get("locations")
            .and_then(|l| l.as_array())
            .and_then(|l| l.first())
            .and_then(|l| l.get("location"))
            .and_then(|l| l.as_str())
            .map(std::string::ToString::to_string)
            .or_else(|| {
                data.get("location").and_then(|l| l.as_str()).map(std::string::ToString::to_string)
            }))
    } else {
        Ok(None)
    }
}

pub async fn resolve_asset_economy_urls(asset_id: &str, cookie_header: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let client = crate::utils::get_http_client();
    let url = format!("https://economy.roblox.com/v2/assets/{asset_id}/details");
    let resp = client
        .get(&url)
        .header(COOKIE, cookie_header)
        .header(USER_AGENT, "RobloxStudio/WinInet")
        .send()
        .await;
    let Ok(resp) = resp else {
        return urls;
    };
    if !resp.status().is_success() {
        return urls;
    }
    let Ok(data) = resp.json::<serde_json::Value>().await else {
        return urls;
    };

    if let Some(hash) = data.get("AssetHash").and_then(|h| h.as_str()).filter(|h| !h.is_empty()) {
        urls.push(format!("https://assetdelivery.roblox.com/v1/assetHash/{hash}"));
        for shard in 1u8..=8 {
            urls.push(format!("https://t{shard}.rbxcdn.com/{hash}"));
        }
        urls.push(format!("https://setup.rbxcdn.com/{hash}"));
    }

    if let Some(version_id) = data.get("AssetVersionId").and_then(serde_json::Value::as_u64) {
        urls.push(format!(
            "https://assetdelivery.roblox.com/v1/assetversion?assetVersionId={version_id}"
        ));
    }

    urls
}

pub async fn build_cdn_fallback_urls(asset_id: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let client = crate::utils::get_http_client();
    let hash_url = format!("https://assetdelivery.roblox.com/v1/assetId/{asset_id}");
    let resp = client.get(&hash_url).header(USER_AGENT, "RobloxStudio/WinInet").send().await;
    if let Ok(resp) = resp {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                if let Some(location) = data
                    .get("locations")
                    .and_then(|l| l.as_array())
                    .and_then(|l| l.first())
                    .and_then(|l| l.get("location"))
                    .and_then(|l| l.as_str())
                {
                    if location.contains("rbxcdn.com") || location.contains("roblox.com") {
                        urls.push(location.to_string());
                    }
                }
            }
        }
    }
    urls
}

#[must_use]
pub fn build_direct_asset_download_urls(
    asset_id: &str,
    asset_type: Option<&str>,
    place_ids: &[String],
) -> Vec<String> {
    let mut urls = Vec::new();
    let expected = expected_asset_type(asset_type);

    for pid in place_ids {
        push_unique_url(
            &mut urls,
            build_asset_download_url(asset_id, false, Some(pid), None, expected, false),
        );
        push_unique_url(
            &mut urls,
            build_asset_download_url(asset_id, false, Some(pid), Some(pid), expected, true),
        );
    }

    if place_ids.is_empty() {
        push_unique_url(
            &mut urls,
            build_asset_download_url(asset_id, false, None, None, expected, false),
        );
    }

    urls
}

#[must_use]
pub fn build_asset_download_url(
    asset_id: &str,
    trailing_slash: bool,
    place_id: Option<&str>,
    server_place_id: Option<&str>,
    expected: Option<&str>,
    client_insert: bool,
) -> String {
    let mut url = format!(
        "https://assetdelivery.roblox.com/v1/asset{}?id={}",
        if trailing_slash { "/" } else { "" },
        asset_id
    );
    if let Some(pid) = place_id {
        url.push_str("&placeId=");
        url.push_str(pid);
    }
    if let Some(spid) = server_place_id {
        url.push_str("&serverplaceid=");
        url.push_str(spid);
    }
    if let Some(asset_type) = expected {
        url.push_str("&expectedAssetType=");
        url.push_str(asset_type);
    }
    if client_insert {
        url.push_str("&clientInsert=1");
    }
    url
}

pub async fn build_saved_versions_urls(asset_id: &str, cookie_header: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let client = crate::utils::get_http_client();
    let url = format!("https://develop.roblox.com/v1/assets/{asset_id}/saved-versions");

    let resp = client
        .get(&url)
        .header(reqwest::header::COOKIE, cookie_header)
        .header(reqwest::header::USER_AGENT, "RobloxStudio/WinInet")
        .send()
        .await;

    if let Ok(resp) = resp {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                if let Some(versions) = data.get("data").and_then(|d| d.as_array()) {
                    for version in versions.iter().rev() {
                        if let Some(version_id) =
                            version.get("assetVersionId").and_then(serde_json::Value::as_u64)
                        {
                            urls.push(format!(
                                "https://assetdelivery.roblox.com/v1/assetversion?assetVersionId={version_id}"
                            ));
                        }
                    }
                }
            }
        }
    }
    urls
}

pub async fn attempt_asset_usage_place_id_discovery(
    asset_id: &str,
    cookie_header: &str,
) -> Vec<String> {
    if !is_valid_numeric_id(asset_id) {
        return Vec::new();
    }

    let client = crate::utils::get_http_client();
    let usage_url =
        format!("https://games.roblox.com/v1/games/asset-to-universe?assetId={asset_id}");
    let Ok(resp) = client
        .get(&usage_url)
        .header(COOKIE, cookie_header)
        .header(USER_AGENT, "RobloxStudio/WinInet")
        .send()
        .await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(data) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };

    let mut universe_ids = Vec::new();
    let mut seen_universe_ids = HashSet::new();
    let mut push_universe_id = |value: &serde_json::Value| {
        if let Some(id) = json_numeric_id(value) {
            if seen_universe_ids.insert(id.clone()) {
                universe_ids.push(id);
            }
        }
    };

    if let Some(values) = data.get("universeIds").and_then(serde_json::Value::as_array) {
        for value in values {
            push_universe_id(value);
        }
    }
    if let Some(values) = data.get("data").and_then(serde_json::Value::as_array) {
        for value in values {
            if let Some(universe_id) = value.get("universeId").or_else(|| value.get("id")) {
                push_universe_id(universe_id);
            } else {
                push_universe_id(value);
            }
        }
    }
    if let Some(value) = data.get("universeId") {
        push_universe_id(value);
    }

    if universe_ids.is_empty() {
        return Vec::new();
    }

    let mut place_ids = Vec::new();
    let mut seen_place_ids = HashSet::new();
    for chunk in universe_ids.chunks(50) {
        let games_url =
            format!("https://games.roblox.com/v1/games?universeIds={}", chunk.join(","));
        let Ok(resp) = client
            .get(&games_url)
            .header(COOKIE, cookie_header)
            .header(USER_AGENT, "RobloxStudio/WinInet")
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(games) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(entries) = games.get("data").and_then(serde_json::Value::as_array) else {
            continue;
        };
        for game in entries {
            let root_place_id = game
                .get("rootPlaceId")
                .and_then(json_numeric_id)
                .or_else(|| {
                    game.get("rootPlace")
                        .and_then(|place| place.get("id"))
                        .and_then(json_numeric_id)
                })
                .or_else(|| game.get("placeId").and_then(json_numeric_id));
            if let Some(place_id) = root_place_id {
                if seen_place_ids.insert(place_id.clone()) {
                    place_ids.push(place_id);
                    if place_ids.len() >= 50 {
                        return place_ids;
                    }
                }
            }
        }
    }

    place_ids
}

async fn discovery_json(url: &str, cookie_header: &str) -> Option<serde_json::Value> {
    let _permit = DISCOVERY_REQUESTS.acquire().await.ok()?;
    let client = crate::utils::get_http_client();
    client
        .get(url)
        .header(COOKIE, cookie_header)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()
}

pub async fn get_groups_for_user(user_id: u64, cookie_header: &str) -> Vec<(u64, Option<u64>)> {
    let Some(key) = DiscoveryKey::new("user", user_id, cookie_header) else {
        return Vec::new();
    };
    user_groups_cache()
        .get_or_fetch(
            key,
            async {
                let url = format!("https://groups.roblox.com/v1/users/{user_id}/groups/roles");
                let mut results = Vec::new();
                let Some(data) = discovery_json(&url, cookie_header).await else {
                    return results;
                };
                if let Some(groups) = data.get("data").and_then(serde_json::Value::as_array) {
                    for group in groups.iter().filter_map(|entry| entry.get("group")) {
                        if let Some(group_id) =
                            group.get("id").and_then(serde_json::Value::as_u64).filter(|id| *id > 0)
                        {
                            let owner_id = group
                                .get("owner")
                                .and_then(|owner| owner.get("userId"))
                                .and_then(serde_json::Value::as_u64)
                                .filter(|id| *id > 0);
                            results.push((group_id, owner_id));
                        }
                    }
                }
                results
            },
            |results| !results.is_empty(),
        )
        .await
}

pub async fn get_group_owner(group_id: u64, cookie_header: &str) -> Option<u64> {
    let key = DiscoveryKey::new("group", group_id, cookie_header)?;
    group_owner_cache()
        .get_or_fetch(
            key,
            async {
                let url = format!("https://groups.roblox.com/v1/groups/{group_id}");
                discovery_json(&url, cookie_header)
                    .await?
                    .get("owner")
                    .and_then(|owner| owner.get("userId"))
                    .and_then(serde_json::Value::as_u64)
                    .filter(|id| *id > 0)
            },
            Option::is_some,
        )
        .await
}

pub async fn get_friends_for_user(user_id: u64, cookie_header: &str) -> Vec<u64> {
    let Some(key) = DiscoveryKey::new("user", user_id, cookie_header) else {
        return Vec::new();
    };
    user_friends_cache()
        .get_or_fetch(
            key,
            async {
                let url = format!("https://friends.roblox.com/v1/users/{user_id}/friends");
                let mut results = Vec::new();
                let Some(data) = discovery_json(&url, cookie_header).await else {
                    return results;
                };
                if let Some(friends) = data.get("data").and_then(serde_json::Value::as_array) {
                    for friend in friends {
                        if let Some(friend_id) = friend
                            .get("id")
                            .and_then(serde_json::Value::as_u64)
                            .filter(|id| *id > 0)
                        {
                            results.push(friend_id);
                        }
                    }
                }
                results
            },
            |results| !results.is_empty(),
        )
        .await
}

pub async fn get_games_for_creator(
    creator_type: &str,
    creator_id: u64,
    cookie_header: &str,
) -> Vec<String> {
    let Some(key) = DiscoveryKey::new(creator_type, creator_id, cookie_header) else {
        return Vec::new();
    };
    creator_games_cache()
        .get_or_fetch(
            key,
            async {
                let mut results = Vec::new();
                let namespace =
                    if creator_type.trim().eq_ignore_ascii_case("user") { "users" } else { "groups" };
                for filter in [2, 1] {
                    let url = format!("https://games.roblox.com/v2/{namespace}/{creator_id}/games?accessFilter={filter}&limit=50");
                    let Some(data) = discovery_json(&url, cookie_header).await else {
                        continue;
                    };
                    if let Some(games) = data.get("data").and_then(serde_json::Value::as_array) {
                        for game in games {
                            if let Some(root_place_id) = game
                                .get("rootPlace")
                                .and_then(|place| place.get("id"))
                                .and_then(serde_json::Value::as_u64)
                                .filter(|id| *id > 0)
                            {
                                let place_id = root_place_id.to_string();
                                if !results.contains(&place_id) {
                                    results.push(place_id);
                                }
                            }
                        }
                    }
                    if !results.is_empty() {
                        break;
                    }
                }
                results
            },
            |results| !results.is_empty(),
        )
        .await
}

pub async fn attempt_social_graph_place_id_discovery(
    asset_id: &str,
    cookie_header: &str,
) -> Vec<String> {
    let client = crate::utils::get_http_client();

    let auth_key = cookie_header.to_string();
    let mut auth_user_id = auth_user_id_cache().get(&auth_key).map(|v| *v);
    if auth_user_id.is_none() {
        if let Ok(resp) = client
            .get("https://users.roblox.com/v1/users/authenticated")
            .header(reqwest::header::COOKIE, cookie_header)
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<serde_json::Value>().await {
                    auth_user_id = data.get("id").and_then(serde_json::Value::as_u64);
                    if let Some(uid) = auth_user_id {
                        auth_user_id_cache().insert(auth_key, uid);
                    }
                }
            }
        }
    }

    let owner = crate::domain::roblox_api::resolve_asset_creators(
        vec![crate::domain::roblox_api::ResolverAsset {
            asset_id: asset_id.to_string(),
            name: None,
            creator: None,
            creator_id: None,
            creator_type: None,
        }],
        cookie_header.to_string(),
        |_| {},
        |_, _| {},
    )
    .await
    .ok()
    .and_then(|assets| assets.into_iter().next());
    let Some(owner) = owner else {
        return Vec::new();
    };
    let creator_type = owner.creator_type.unwrap_or_default().trim().to_ascii_lowercase();
    let creator_id = owner.creator_id.and_then(|id| id.parse::<u64>().ok()).unwrap_or_default();

    let Some(key) = DiscoveryKey::new(&creator_type, creator_id, cookie_header) else {
        return Vec::new();
    };
    social_graph_cache()
        .get_or_fetch(
            key,
            discover_social_graph_places(&creator_type, creator_id, auth_user_id, cookie_header),
            |places| !places.is_empty(),
        )
        .await
}

async fn discover_social_graph_places(
    creator_type: &str,
    creator_id: u64,
    auth_user_id: Option<u64>,
    cookie_header: &str,
) -> Vec<String> {
    let mut tasks = vec![];
    let mut seen_creators = HashSet::from([(creator_type.to_string(), creator_id)]);

    let mut queue_games_fetch = |c_type: &str, c_id: u64| {
        let creator = (c_type.trim().to_ascii_lowercase(), c_id);
        if c_id > 0 && seen_creators.insert(creator.clone()) {
            tasks.push(creator);
        }
    };

    if let Some(uid) = auth_user_id {
        queue_games_fetch("User", uid);
        let groups = get_groups_for_user(uid, cookie_header).await;
        for (gid, _) in groups.into_iter().take(MAX_GROUP_CRAWL_LIMIT) {
            queue_games_fetch("Group", gid);
        }
    }

    if creator_type.eq_ignore_ascii_case("user") && creator_id != 1 {
        let groups = get_groups_for_user(creator_id, cookie_header).await;
        let mut seen_owners = HashSet::new();
        if let Some(uid) = auth_user_id {
            seen_owners.insert(uid);
        }
        seen_owners.insert(creator_id);

        for (gid, owner_id) in groups.into_iter().take(MAX_GROUP_FRIEND_CRAWL_LIMIT) {
            queue_games_fetch("Group", gid);

            if let Some(oid) = owner_id {
                if seen_owners.insert(oid) {
                    queue_games_fetch("User", oid);
                }
            }
        }

        let friends = get_friends_for_user(creator_id, cookie_header).await;
        for fid in friends.into_iter().take(MAX_FRIEND_CRAWL_LIMIT) {
            if seen_owners.insert(fid) {
                queue_games_fetch("User", fid);
            }
        }
    } else if creator_type.eq_ignore_ascii_case("group") {
        if let Some(owner_id) = get_group_owner(creator_id, cookie_header).await {
            let mut seen_owners = HashSet::new();
            if let Some(uid) = auth_user_id {
                seen_owners.insert(uid);
            }
            seen_owners.insert(owner_id);

            queue_games_fetch("User", owner_id);

            let owner_groups = get_groups_for_user(owner_id, cookie_header).await;
            for (gid, gid_owner) in owner_groups.into_iter().take(MAX_GROUP_FRIEND_CRAWL_LIMIT) {
                queue_games_fetch("Group", gid);
                if let Some(oid) = gid_owner {
                    if seen_owners.insert(oid) {
                        queue_games_fetch("User", oid);
                    }
                }
            }

            let owner_friends = get_friends_for_user(owner_id, cookie_header).await;
            for fid in owner_friends.into_iter().take(MAX_FRIEND_CRAWL_LIMIT) {
                if seen_owners.insert(fid) {
                    queue_games_fetch("User", fid);
                }
            }
        }
    }

    let mut ordered_places: Vec<String> = Vec::new();
    let mut seen_places = HashSet::new();

    let creator_places = get_games_for_creator(creator_type, creator_id, cookie_header).await;
    for place in creator_places {
        if seen_places.insert(place.clone()) {
            ordered_places.push(place);
        }
    }

    let results = collect_discoveries(
        tasks
            .into_iter()
            .map(|(ct, cid)| async move { get_games_for_creator(&ct, cid, cookie_header).await }),
    )
    .await;
    for places in results {
        for place in places {
            if seen_places.insert(place.clone()) {
                ordered_places.push(place);
            }
            if ordered_places.len() >= 50 {
                break;
            }
        }
        if ordered_places.len() >= 50 {
            break;
        }
    }

    ordered_places
}

pub async fn attempt_deep_place_id_discovery(
    app: &AppHandle,
    asset_id: &str,
    _cookie_header: &str,
    place_limit: u32,
    excluded_place_ids: &[String],
) -> crate::error::Result<Vec<String>> {
    let _ = crate::commands::ipc::append_log_entry(
        app,
        "info",
        "spoofer",
        &format!("Archive recovery: searching archived delivery URLs for asset {asset_id}..."),
    );
    let hints =
        super::archive::discover_place_ids(asset_id, place_limit as usize, excluded_place_ids)
            .await?;
    for warning in hints.warnings {
        let _ = crate::commands::ipc::append_log_entry(
            app,
            "warn",
            "spoofer",
            &format!("Archive recovery for asset {asset_id}: {warning}"),
        );
    }
    let _ = crate::commands::ipc::append_log_entry(
        app,
        "info",
        "spoofer",
        &format!(
            "Archive recovery for asset {asset_id}: {} candidate Place ID(s) from {} completed search(es). Candidates still require a successful download.",
            hints.place_ids.len(), hints.queries_completed,
        ),
    );
    Ok(hints.place_ids)
}

fn json_numeric_id(value: &serde_json::Value) -> Option<String> {
    value
        .as_u64()
        .map(|number| number.to_string())
        .or_else(|| value.as_str().map(std::string::ToString::to_string))
        .filter(|id| is_valid_numeric_id(id))
}

#[must_use]
pub fn expected_asset_type(asset_type: Option<&str>) -> Option<&'static str> {
    match asset_type.unwrap_or_default().to_ascii_lowercase().as_str() {
        "audio" => Some("Audio"),
        "plugin" => Some("Plugin"),
        "video" => Some("Video"),
        _ => None,
    }
}

pub fn push_unique_url(urls: &mut Vec<String>, url: String) {
    if !urls.contains(&url) {
        urls.push(url);
    }
}

#[must_use]
pub fn extract_place_id_from_url(url: &str) -> Option<String> {
    let query = url.split_once('?')?.1;
    for part in query.split('&') {
        let (key, value) = part.split_once('=')?;
        if (key.eq_ignore_ascii_case("placeId") || key.eq_ignore_ascii_case("serverplaceid"))
            && is_valid_numeric_id(value)
        {
            return Some(value.to_string());
        }
    }
    None
}

pub fn parse_place_ids(raw: Option<&str>) -> Vec<String> {
    let mut ids = Vec::new();
    for candidate in raw
        .unwrap_or_default()
        .split(|character: char| character == ',' || character.is_whitespace())
        .map(str::trim)
    {
        if candidate.is_empty() || !is_valid_numeric_id(candidate) {
            continue;
        }
        if !ids.iter().any(|existing| existing == candidate) {
            ids.push(candidate.to_string());
        }
    }
    ids
}
