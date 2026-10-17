use super::jobs::{
    get_jobs, published_asset_id, reconcile_asset_moderation, update_asset_moderation,
};
use super::spoofer::permissions::{get_asset_permissions, AssetPermissionsResult};
use super::spoofer::upload_auth::UploadAuth;
use super::AnyValue;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::AppHandle;
use tokio::time::{timeout_at, Instant};

fn numeric_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|id| id > 0)
}

fn requested_ids(asset_ids: Vec<String>) -> Result<Vec<String>, String> {
    if asset_ids.is_empty() || asset_ids.len() > 1000 {
        return Err("Provide between 1 and 1000 asset IDs".into());
    }
    if asset_ids.iter().any(|id| !numeric_id(id)) {
        return Err("Asset IDs must be positive numeric IDs".into());
    }
    let mut seen = HashSet::new();
    Ok(asset_ids.into_iter().filter(|id| seen.insert(id.clone())).collect())
}

fn moderation_state(value: &Value) -> Option<&'static str> {
    match value.pointer("/moderationResult/moderationState").and_then(Value::as_str)? {
        "MODERATION_STATE_APPROVED" | "Approved" => Some("approved"),
        "MODERATION_STATE_REJECTED" | "MODERATION_STATE_DENIED" | "Rejected" => Some("rejected"),
        "MODERATION_STATE_REVIEWING" | "MODERATION_STATE_PENDING" | "Reviewing" | "Pending" => {
            Some("pending")
        }
        _ => None,
    }
}

async fn fetch_moderation(
    client: &reqwest::Client,
    endpoint: &str,
    asset_id: &str,
    cookie: Option<&str>,
    api_key: Option<&str>,
) -> Result<String, String> {
    let mut auth = UploadAuth::new(api_key, cookie.unwrap_or_default(), "")
        .map_err(|_| "Sign in to Roblox or provide an API key to check moderation")?;
    for _ in 0..2 {
        let response = auth
            .apply(client.get(format!("{endpoint}/{asset_id}")))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| "Moderation check failed: network error")?;
        if auth.refresh_csrf(&response) {
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Moderation check returned HTTP {}", response.status().as_u16()));
        }
        let value = response.json::<Value>().await.map_err(|_| "Invalid moderation response")?;
        return moderation_state(&value)
            .map(str::to_owned)
            .ok_or_else(|| "Roblox returned no recognized moderation state".into());
    }
    Err("Roblox denied the moderation check".into())
}

async fn recheck_results(
    client: &reqwest::Client,
    endpoint: &str,
    asset_ids: &[String],
    tracked: &[Value],
    cookie: Option<&str>,
    api_key: Option<&str>,
    deadline: Instant,
) -> (Vec<Value>, HashMap<String, String>) {
    let wanted: HashSet<_> = asset_ids.iter().map(String::as_str).collect();
    let mut by_id = HashMap::new();
    for asset in tracked {
        for key in ["id", "newId", "meshId", "imageId", "assetId"] {
            let Some(value) = asset.get(key) else { continue };
            let id = value
                .as_str()
                .map(str::to_owned)
                .or_else(|| value.as_u64().map(|id| id.to_string()));
            if let Some(id) = id.filter(|id| wanted.contains(id.as_str())) {
                by_id.entry(id).or_insert(asset);
            }
        }
    }
    let mut results = Vec::new();
    let mut requested = Vec::new();
    let mut seen = HashSet::new();
    for id in asset_ids {
        let Some(asset) = by_id.get(id) else {
            results.push(json!({"assetId":id,"moderation":null,"checked":false,"reason":"Asset is not pending or tracked"}));
            continue;
        };
        let moderation = asset.get("moderation").and_then(Value::as_str);
        if moderation != Some("pending") {
            let known = moderation.filter(|state| matches!(*state, "approved" | "rejected"));
            results.push(json!({"assetId":id,"moderation":known,"checked":false,"reason":if known.is_some(){"Moderation is already final"}else{"Asset is not pending or tracked"}}));
            continue;
        }
        let Some(query_id) = published_asset_id(asset) else {
            results.push(json!({"assetId":id,"moderation":"pending","checked":false,"reason":"No published asset ID is tracked"}));
            continue;
        };
        if seen.insert(query_id.clone()) {
            requested.push(query_id.clone());
        }
        results
            .push(json!({"assetId":id,"moderation":"pending","checked":false,"queryId":query_id}));
    }

    let checked: HashMap<_, _> = stream::iter(requested.into_iter().map(|id| async move {
        let response =
            timeout_at(deadline, fetch_moderation(client, endpoint, &id, cookie, api_key))
                .await
                .unwrap_or_else(|_| Err("Moderation check exceeded the request time limit".into()));
        (id, response)
    }))
    .buffer_unordered(8)
    .collect()
    .await;
    let mut updates = HashMap::new();
    for result in &mut results {
        let Some(query_id) = result.as_object_mut().and_then(|value| value.remove("queryId"))
        else {
            continue;
        };
        let Some((id, response)) = query_id.as_str().and_then(|id| checked.get_key_value(id))
        else {
            continue;
        };
        match response {
            Ok(moderation) => {
                result["moderation"] = json!(moderation);
                result["checked"] = json!(true);
                updates.insert(id.clone(), moderation.clone());
            }
            Err(reason) => result["reason"] = json!(reason),
        }
    }
    (results, updates)
}

#[tauri::command]
#[specta::specta]
pub async fn recheck_asset_moderation(
    app: AppHandle,
    asset_ids: Vec<String>,
    pending_assets: Option<Vec<AnyValue>>,
    cookie: Option<String>,
    api_key: Option<String>,
) -> crate::error::Result<AnyValue> {
    let deadline = Instant::now() + Duration::from_secs(85);
    let ids = requested_ids(asset_ids)?;
    let mut tracked: Vec<Value> =
        pending_assets.unwrap_or_default().into_iter().map(|asset| asset.0).collect();
    let history = get_jobs(app.clone()).await?.0;
    if let Some(jobs) = history.as_array() {
        for job in jobs {
            if let Some(assets) = job.get("assetResults").and_then(Value::as_array) {
                tracked.extend(assets.iter().cloned());
            }
        }
    }
    reconcile_asset_moderation(&mut tracked).await;
    let endpoint = if api_key.as_deref().is_some_and(|key| !key.trim().is_empty()) {
        "https://apis.roblox.com/assets/v1/assets"
    } else {
        "https://apis.roblox.com/assets/user-auth/v1/assets"
    };
    let (results, updates) = recheck_results(
        &crate::utils::get_http_client(),
        endpoint,
        &ids,
        &tracked,
        cookie.as_deref(),
        api_key.as_deref(),
        deadline,
    )
    .await;
    update_asset_moderation(&app, &updates).await?;
    Ok(AnyValue(json!(results)))
}

fn permission_granted(
    result: &AssetPermissionsResult,
    target_type: &str,
    target_id: &str,
) -> Option<bool> {
    result.success.then(|| {
        result.permissions.iter().any(|permission| {
            permission.action == "Use"
                && (permission.subject_type == "All"
                    || permission.subject_type == target_type && permission.subject_id == target_id)
        })
    })
}

fn access_result(
    result: AssetPermissionsResult,
    target_type: &str,
    target_id: &str,
    owner_matches: Option<bool>,
    ownership_reason: Option<&str>,
) -> Value {
    let granted = permission_granted(&result, target_type, target_id);
    let can_use = (granted == Some(true) || owner_matches == Some(true)).then_some(true);
    let mut value = json!({
        "assetId":result.asset_id,"targetType":target_type,"targetId":target_id,
        "granted":granted,"permissionGranted":granted,"canUse":can_use,
        "status":if can_use.is_some(){"granted"}else{"unknown"},
        "permissionStatus":match granted {Some(true)=>"granted",Some(false)=>"not_granted",None=>"unknown"},
        "ownerMatches":owner_matches,
        "accessSource":if granted==Some(true){Some("permission")}else if owner_matches==Some(true){Some("ownership")}else{None},
    });
    if let Some(reason) = result.reason {
        value["reason"] = json!(reason);
    } else if can_use.is_none() {
        value["reason"] =
            json!("No explicit Use grant was found; effective access could not be confirmed");
    }
    if let Some(reason) = ownership_reason {
        value["ownershipReason"] = json!(reason);
    }
    value
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AssetOwner {
    creator_type: String,
    creator_id: String,
}

fn json_id(value: &Value) -> Option<String> {
    let id =
        value.as_str().map(str::to_owned).or_else(|| value.as_u64().map(|id| id.to_string()))?;
    numeric_id(&id).then_some(id)
}

fn creator(creator_type: &Value, creator_id: &Value) -> Option<AssetOwner> {
    let creator_type = match creator_type.as_str()?.to_ascii_lowercase().as_str() {
        "user" => "User",
        "group" => "Group",
        _ => return None,
    };
    Some(AssetOwner { creator_type: creator_type.into(), creator_id: json_id(creator_id)? })
}

async fn ownership_json(request: reqwest::RequestBuilder) -> Result<Value, String> {
    let response = request
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| "Ownership lookup failed: network error")?;
    if !response.status().is_success() {
        return Err(format!("Ownership lookup returned HTTP {}", response.status().as_u16()));
    }
    response.json().await.map_err(|_| "Invalid ownership metadata".into())
}

async fn universe_owner(
    client: &reqwest::Client,
    endpoint: &str,
    universe_id: &str,
) -> Result<AssetOwner, String> {
    let value = ownership_json(client.get(endpoint).query(&[("universeIds", universe_id)])).await?;
    value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|games| {
            games
                .iter()
                .find(|game| game.get("id").and_then(json_id).as_deref() == Some(universe_id))
        })
        .and_then(|game| game.get("creator"))
        .and_then(|owner| creator(owner.get("type")?, owner.get("id")?))
        .ok_or_else(|| "Roblox returned no owner for the requested universe".into())
}

async fn asset_owner(
    client: &reqwest::Client,
    endpoint: &str,
    asset_id: &str,
) -> Result<AssetOwner, String> {
    let value = ownership_json(client.get(format!("{endpoint}/{asset_id}/details"))).await?;
    let owner = value.get("Creator").ok_or("Roblox returned no asset creator")?;
    creator(
        owner
            .get("CreatorType")
            .or_else(|| owner.get("Type"))
            .ok_or("Roblox returned no creator type")?,
        owner
            .get("CreatorTargetId")
            .or_else(|| owner.get("Id"))
            .or_else(|| owner.get("TargetId"))
            .ok_or("Roblox returned no creator ID")?,
    )
    .ok_or_else(|| "Roblox returned an unrecognized asset creator".into())
}

#[tauri::command]
#[specta::specta]
pub async fn check_asset_access(
    asset_ids: Vec<String>,
    universe_id: Option<String>,
    group_id: Option<String>,
    cookie: Option<String>,
    api_key: Option<String>,
) -> crate::error::Result<AnyValue> {
    let deadline = Instant::now() + Duration::from_secs(85);
    let ids = requested_ids(asset_ids)?;
    let (target_type, target_id) = match (universe_id.as_deref(), group_id.as_deref()) {
        (Some(id), None) if numeric_id(id) => ("Universe", id),
        (None, Some(id)) if numeric_id(id) => ("Group", id),
        _ => return Err("Provide exactly one positive numeric universeId or groupId".into()),
    };
    let client = crate::utils::get_http_client();
    let target_owner = if target_type == "Group" {
        Ok(AssetOwner { creator_type: "Group".into(), creator_id: target_id.into() })
    } else {
        timeout_at(
            deadline,
            universe_owner(&client, "https://games.roblox.com/v1/games", target_id),
        )
        .await
        .unwrap_or_else(|_| Err("Universe ownership lookup exceeded the request time limit".into()))
    };
    let results: HashMap<_, _> = stream::iter(ids.clone().into_iter().map(|id| {
        let cookie = cookie.clone();
        let api_key = api_key.clone();
        let client = client.clone();
        let target_owner = target_owner.clone();
        async move {
            let permission_deadline = deadline.min(Instant::now() + Duration::from_secs(30));
            let response = timeout_at(
                permission_deadline,
                get_asset_permissions(vec![id.clone()], cookie, api_key),
            )
            .await;
            let result = match response {
                Ok(Ok(mut results)) if !results.is_empty() => results.remove(0),
                _ => AssetPermissionsResult {
                    asset_id: id.clone(),
                    success: false,
                    permissions: vec![],
                    reason: Some(
                        "Permission check failed or exceeded the request time limit".into(),
                    ),
                },
            };
            let mut owner_matches = None;
            let mut ownership_reason = None;
            if permission_granted(&result, target_type, target_id) != Some(true) {
                match target_owner {
                    Ok(target_owner) => match timeout_at(
                        deadline,
                        asset_owner(&client, "https://economy.roblox.com/v2/assets", &id),
                    )
                    .await
                    {
                        Ok(Ok(owner)) => owner_matches = Some(owner == target_owner),
                        Ok(Err(reason)) => ownership_reason = Some(reason),
                        Err(_) => {
                            ownership_reason = Some(
                                "Asset ownership lookup exceeded the request time limit".into(),
                            )
                        }
                    },
                    Err(reason) => ownership_reason = Some(reason),
                }
            }
            let value = access_result(
                result,
                target_type,
                target_id,
                owner_matches,
                ownership_reason.as_deref(),
            );
            (id, value)
        }
    }))
    .buffer_unordered(8)
    .collect()
    .await;
    Ok(AnyValue(json!(ids.iter().filter_map(|id| results.get(id)).collect::<Vec<_>>())))
}

#[cfg(test)]
mod tests {
    use super::super::spoofer::permissions::AssetPermission;
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn rechecks_only_requested_pending_assets_with_get_and_model_id() {
        use axum::{
            extract::{Path, State},
            http::Method,
            routing::any,
            Json, Router,
        };
        type RecordedCalls = Arc<Mutex<Vec<(Method, String)>>>;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let router =
            Router::new()
                .route(
                    "/assets/:id",
                    any(
                        |State(calls): State<RecordedCalls>,
                         method: Method,
                         Path(id): Path<String>| async move {
                            calls.lock().expect("calls").push((method, id));
                            Json(json!({"moderationResult":{"moderationState":"Approved"}}))
                        },
                    ),
                )
                .with_state(Arc::clone(&calls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let endpoint = format!("http://{}/assets", listener.local_addr().expect("address"));
        let server =
            tokio::spawn(async move { axum::serve(listener, router).await.expect("server") });
        let tracked = vec![
            json!({"id":"1","assetId":"100","meshId":"101","newId":"101","moderation":"pending"}),
            json!({"id":"2","newId":"200","moderation":"approved"}),
            json!({"id":"3","newId":"300","moderation":"rejected"}),
            json!({"id":"4","newId":"400","moderation":"pending"}),
        ];
        let ids = ["1", "101", "100", "2", "3", "999"].map(str::to_owned);
        let (results, updates) = recheck_results(
            &reqwest::Client::new(),
            &endpoint,
            &ids,
            &tracked,
            Some("synthetic-session"),
            None,
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        assert_eq!(*calls.lock().expect("calls"), vec![(Method::GET, "100".into())]);
        assert_eq!(updates, HashMap::from([("100".into(), "approved".into())]));
        assert_eq!(
            results
                .iter()
                .map(|result| result["checked"].as_bool().expect("checked"))
                .collect::<Vec<_>>(),
            vec![true, true, true, false, false, false]
        );
        assert_eq!(results[5]["moderation"], Value::Null);
        assert!(results.iter().all(|result| result.get("queryId").is_none()));
        server.abort();
    }

    #[tokio::test]
    async fn failed_moderation_checks_remain_pending_without_updates() {
        use axum::{http::StatusCode, routing::get, Router};
        let router = Router::new().route("/assets/:id", get(|| async { StatusCode::FORBIDDEN }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let endpoint = format!("http://{}/assets", listener.local_addr().expect("address"));
        let server =
            tokio::spawn(async move { axum::serve(listener, router).await.expect("server") });
        let (results, updates) = recheck_results(
            &reqwest::Client::new(),
            &endpoint,
            &["1".into()],
            &[json!({"id":"1","newId":"100","moderation":"pending"})],
            None,
            Some("synthetic-key"),
            Instant::now() + Duration::from_secs(2),
        )
        .await;
        assert!(updates.is_empty());
        assert_eq!(results[0]["moderation"], "pending");
        assert_eq!(results[0]["checked"], false);
        assert!(results[0]["reason"].as_str().expect("reason").contains("403"));
        server.abort();
    }

    #[test]
    fn access_requires_use_on_the_exact_target_or_all_and_preserves_unknown() {
        let response =
            |subject_type: &str, subject_id: &str, action: &str| AssetPermissionsResult {
                asset_id: "100".into(),
                success: true,
                reason: None,
                permissions: vec![AssetPermission {
                    subject_type: subject_type.into(),
                    subject_id: subject_id.into(),
                    action: action.into(),
                }],
            };
        assert_eq!(
            access_result(response("Group", "7", "Use"), "Group", "7", None, None)["granted"],
            true
        );
        assert_eq!(
            access_result(response("All", "", "Use"), "Universe", "7", None, None)["granted"],
            true
        );
        let no_grant = access_result(response("Group", "7", "Use"), "Universe", "7", None, None);
        assert_eq!(no_grant["granted"], false);
        assert_eq!(no_grant["canUse"], Value::Null);
        assert_eq!(no_grant["status"], "unknown");
        assert_eq!(
            access_result(response("Group", "7", "Edit"), "Group", "7", None, None)["granted"],
            false
        );
        let unknown = access_result(
            AssetPermissionsResult {
                asset_id: "100".into(),
                success: false,
                permissions: vec![],
                reason: Some("HTTP 403".into()),
            },
            "Group",
            "7",
            None,
            None,
        );
        assert_eq!(unknown["granted"], Value::Null);
        assert_eq!(unknown["status"], "unknown");
    }

    #[tokio::test]
    async fn public_ownership_gets_confirm_use_without_an_explicit_grant() {
        use axum::{extract::Query, http::Method, routing::any, Json, Router};
        let router = Router::new()
            .route("/games",any(|method:Method,Query(query):Query<HashMap<String,String>>|async move {
                assert_eq!(method,Method::GET);
                assert_eq!(query.get("universeIds").map(String::as_str),Some("7"));
                Json(json!({"data":[{"id":8,"creator":{"type":"User","id":9}},{"id":7,"creator":{"type":"Group","id":9}}]}))
            }))
            .route("/assets/100/details",any(|method:Method|async move {
                assert_eq!(method,Method::GET);
                Json(json!({"Creator":{"CreatorType":"Group","CreatorTargetId":9}}))
            }))
            .route("/assets/101/details",any(|method:Method|async move {
                assert_eq!(method,Method::GET);
                Json(json!({"Creator":{"CreatorType":"User","CreatorTargetId":9}}))
            }))
            .route("/assets/102/details",any(||async { axum::http::StatusCode::FORBIDDEN }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let server =
            tokio::spawn(async move { axum::serve(listener, router).await.expect("server") });
        let client = reqwest::Client::new();
        let target =
            universe_owner(&client, &format!("{base}/games"), "7").await.expect("universe creator");
        assert_eq!(target, AssetOwner { creator_type: "Group".into(), creator_id: "9".into() });
        let no_grants = || AssetPermissionsResult {
            asset_id: "100".into(),
            success: true,
            permissions: vec![],
            reason: None,
        };
        let owner =
            asset_owner(&client, &format!("{base}/assets"), "100").await.expect("asset creator");
        let access = access_result(no_grants(), "Universe", "7", Some(owner == target), None);
        assert_eq!(access["permissionGranted"], false);
        assert_eq!(access["canUse"], true);
        assert_eq!(access["accessSource"], "ownership");
        let other_owner =
            asset_owner(&client, &format!("{base}/assets"), "101").await.expect("other creator");
        let unconfirmed =
            access_result(no_grants(), "Universe", "7", Some(other_owner == target), None);
        assert_eq!(unconfirmed["canUse"], Value::Null);
        assert_eq!(unconfirmed["status"], "unknown");
        let error = asset_owner(&client, &format!("{base}/assets"), "102")
            .await
            .expect_err("denied metadata");
        let unknown = access_result(no_grants(), "Group", "9", None, Some(&error));
        assert_eq!(unknown["canUse"], Value::Null);
        assert!(unknown["ownershipReason"].as_str().expect("reason").contains("403"));
        server.abort();
    }
}
