use super::{build_roblox_cookie_header, COOKIE};
use reqwest::header::USER_AGENT;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;
use tauri::Emitter;

#[derive(Clone, Deserialize, specta::Type)]
pub struct BatchGrantPermissionsRequest {
    #[specta(type = Vec<f64>)]
    pub asset_ids: Vec<u64>,
    pub subject_type: String,
    pub subject_ids: Vec<String>,
    pub action: String,
    pub api_key: Option<String>,
    pub cookie: Option<String>,
}

#[derive(Serialize, specta::Type)]
pub struct PermissionAssetResult {
    pub asset_id: String,
    pub success: bool,
    pub reason: Option<String>,
}

#[derive(Serialize, specta::Type)]
pub struct BatchGrantPermissionsResponse {
    #[specta(type = Vec<f64>)]
    pub success_asset_ids: Vec<u64>,
    #[specta(type = Vec<f64>)]
    pub failed_asset_ids: Vec<u64>,
    pub errors: Vec<String>,
    pub results: Vec<PermissionAssetResult>,
}

#[derive(Deserialize, specta::Type)]
pub struct GetAssetPermissionsRequest {
    pub asset_ids: Vec<String>,
    pub api_key: Option<String>,
    pub cookie: Option<String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AssetPermissionsResult {
    pub asset_id: String,
    pub success: bool,
    pub permissions: Vec<AssetPermission>,
    pub reason: Option<String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[derive(Debug)]
pub struct AssetPermission {
    pub subject_type: String,
    pub subject_id: String,
    pub action: String,
}

pub fn sanitize_response(message: &str, cookie: Option<&str>, api_key: Option<&str>) -> String {
    let mut sanitized = message.to_owned();
    for secret in [cookie, api_key].into_iter().flatten().filter(|value| !value.is_empty()) {
        sanitized = sanitized.replace(secret, "[redacted]");
    }
    crate::commands::ipc::redact_log_message(&sanitized).chars().take(1200).collect()
}

fn emit_perm_log(app: &tauri::AppHandle, level: &str, msg: &str) {
    let _ = crate::commands::ipc::append_log_entry(app, level, "permissions", msg);
    let _ = app.emit("spoofer-log", json!({"message":msg,"level":level}));
}

fn valid_id(value: &str) -> bool {
    value.parse::<u64>().is_ok_and(|id| id > 0) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn subject_kind(value: &str) -> Result<(&'static str, bool), String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "universe" | "experience" => Ok(("Universe", false)),
        "place" | "placeid" => Ok(("Universe", true)),
        "user" => Ok(("User", false)),
        "group" => Ok(("Group", false)),
        _ => Err("Subject type must be Universe, Place, User, or Group".into()),
    }
}

pub fn validate_permission_targets(subject_type: &str, ids: &[String]) -> Result<(), String> {
    subject_kind(subject_type)?;
    if ids.is_empty() || ids.iter().flat_map(|id| id.split(',')).any(|id| !valid_id(id.trim())) {
        return Err("Provide at least one positive numeric permission subject ID".into());
    }
    Ok(())
}

fn authenticated(
    builder: reqwest::RequestBuilder,
    cookie: Option<&str>,
    api_key: Option<&str>,
    csrf: &str,
) -> reqwest::RequestBuilder {
    if let Some(key) = api_key.filter(|key| !key.trim().is_empty()) {
        return builder.header("x-api-key", key);
    }
    let builder = builder
        .header(COOKIE, build_roblox_cookie_header(cookie.unwrap_or_default()))
        .header("origin", "https://create.roblox.com")
        .header("referer", "https://create.roblox.com/")
        .header(USER_AGENT, "RobloxStudio/WinInet");
    if csrf.is_empty() {
        builder
    } else {
        builder.header("x-csrf-token", csrf)
    }
}

async fn request_with_retry(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    body: Option<&Value>,
    cookie: Option<&str>,
    api_key: Option<&str>,
    csrf: &mut String,
) -> Result<Value, String> {
    for attempt in 0..4u32 {
        let mut builder = authenticated(client.request(method.clone(), url), cookie, api_key, csrf)
            .timeout(Duration::from_secs(30));
        if let Some(body) = body {
            builder = builder.header("content-type", "application/json-patch+json").json(body);
        }
        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) if attempt == 3 => {
                return Err(sanitize_response(
                    &format!("Permission request failed: {error}"),
                    cookie,
                    api_key,
                ))
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                continue;
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::FORBIDDEN
            && api_key.filter(|key| !key.is_empty()).is_none()
        {
            if let Some(token) = response
                .headers()
                .get("x-csrf-token")
                .and_then(|value| value.to_str().ok())
                .filter(|token| *token != csrf.as_str())
            {
                *csrf = token.to_owned();
                continue;
            }
        }
        let retry_after = crate::utils::extract_retry_after(&response, Some(attempt));
        if (status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error())
            && attempt < 3
        {
            let wait = retry_after.unwrap_or(1000 * 2u64.pow(attempt));
            if wait > 60_000 {
                return Err(format!(
                    "Roblox asked to retry permissions after {} seconds; retry this job later",
                    wait / 1000
                ));
            }
            tokio::time::sleep(Duration::from_millis(wait)).await;
            continue;
        }
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let reason = serde_json::from_str::<Value>(&text)
                .ok()
                .map(|value| crate::utils::extract_human_error(&value, Some(status.as_u16())))
                .unwrap_or_else(|| format!("Permission request returned HTTP {}", status.as_u16()));
            return Err(sanitize_response(&reason, cookie, api_key));
        }
        if text.trim().is_empty() {
            return Ok(json!({}));
        }
        return serde_json::from_str(&text)
            .map_err(|_| "Roblox returned invalid permission response data".into());
    }
    Err("Permission request exhausted its retry attempts".into())
}

fn parse_grant_response(value: &Value, asset_id: u64) -> Result<(), String> {
    if value.get("successAssetIds").and_then(Value::as_array).is_some_and(|ids| {
        ids.iter()
            .any(|id| id.as_u64() == Some(asset_id) || id.as_str() == Some(&asset_id.to_string()))
    }) {
        return Ok(());
    }
    let code = value
        .get("errors")
        .and_then(Value::as_array)
        .and_then(|errors| {
            errors
                .iter()
                .find(|error| error.get("assetId").and_then(Value::as_u64) == Some(asset_id))
        })
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("Roblox did not confirm this asset permission grant");
    Err(code.to_owned())
}

#[tauri::command]
#[specta::specta]
pub async fn batch_grant_asset_permissions(
    app: tauri::AppHandle,
    req: BatchGrantPermissionsRequest,
) -> crate::error::Result<BatchGrantPermissionsResponse> {
    validate_permission_targets(&req.subject_type, &req.subject_ids)?;
    if req.action != "Use" {
        return Err("Only the Use permission is supported".into());
    }
    if req.asset_ids.contains(&0) {
        return Err("Asset IDs must be positive numeric IDs".into());
    }
    let (kind, places) = subject_kind(&req.subject_type)?;
    let cookie = req.cookie.as_deref().filter(|value| !value.trim().is_empty());
    let api_key = req.api_key.as_deref().filter(|value| !value.trim().is_empty());
    if cookie.is_none() && api_key.is_none() {
        return Err("Sign in or provide an API key to update asset permissions".into());
    }
    let client = crate::utils::get_http_client();
    let mut csrf = String::new();
    let mut subjects = Vec::new();
    for id in req.subject_ids.iter().flat_map(|id| id.split(',')).map(str::trim) {
        let id = if places {
            let value = request_with_retry(
                &client,
                reqwest::Method::GET,
                &format!("https://apis.roblox.com/universes/v1/places/{id}/universe"),
                None,
                None,
                None,
                &mut csrf,
            )
            .await?;
            value
                .get("universeId")
                .and_then(Value::as_u64)
                .filter(|id| *id > 0)
                .ok_or("Could not resolve Place ID to a Universe ID")?
                .to_string()
        } else {
            id.to_owned()
        };
        if !subjects.contains(&id) {
            subjects.push(id);
        }
    }
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for asset_id in req.asset_ids.iter().copied().filter(|id| seen.insert(*id)) {
        let _ = app.emit("asset-permissions-progress", json!({"current":results.len()+1,"total":req.asset_ids.len(),"assetId":asset_id.to_string()}));
        let mut reason = None;
        for subject in &subjects {
            let body = json!({"subjectType":kind,"subjectId":subject,"action":"Use","requests":[{"assetId":asset_id,"grantToDependencies":false}]});
            match request_with_retry(
                &client,
                reqwest::Method::PATCH,
                "https://apis.roblox.com/asset-permissions-api/v1/assets/permissions",
                Some(&body),
                cookie,
                api_key,
                &mut csrf,
            )
            .await
            .and_then(|value| parse_grant_response(&value, asset_id))
            {
                Ok(()) => {}
                Err(error) => {
                    reason = Some(sanitize_response(&error, cookie, api_key));
                    break;
                }
            }
        }
        results.push(PermissionAssetResult {
            asset_id: asset_id.to_string(),
            success: reason.is_none(),
            reason,
        });
    }
    let success_asset_ids = results
        .iter()
        .filter(|result| result.success)
        .filter_map(|result| result.asset_id.parse().ok())
        .collect::<Vec<_>>();
    let failed_asset_ids = results
        .iter()
        .filter(|result| !result.success)
        .filter_map(|result| result.asset_id.parse().ok())
        .collect::<Vec<_>>();
    let errors = results
        .iter()
        .filter_map(|result| {
            result.reason.as_ref().map(|reason| format!("Asset {}: {reason}", result.asset_id))
        })
        .collect();
    emit_perm_log(
        &app,
        if failed_asset_ids.is_empty() { "info" } else { "warn" },
        &format!(
            "Permissions finished: {} granted, {} failed",
            success_asset_ids.len(),
            failed_asset_ids.len()
        ),
    );
    Ok(BatchGrantPermissionsResponse { success_asset_ids, failed_asset_ids, errors, results })
}

pub async fn permission_status(
    app: &tauri::AppHandle,
    asset_id: &str,
    grant: &crate::commands::ipc::job::publish::GrantPermissions,
    cookie: &str,
    api_key: &str,
) -> Value {
    if !grant.enabled {
        return json!({"status":"not_requested"});
    }
    let Ok(asset_id) = asset_id.parse::<u64>() else {
        return json!({"status":"failed","reason":"Invalid asset ID"});
    };
    let result = batch_grant_asset_permissions(
        app.clone(),
        BatchGrantPermissionsRequest {
            asset_ids: vec![asset_id],
            subject_type: grant.subject_type.clone(),
            subject_ids: grant.ids.clone(),
            action: "Use".into(),
            cookie: Some(cookie.into()),
            api_key: Some(api_key.into()),
        },
    )
    .await;
    match result {
        Ok(response) if response.failed_asset_ids.is_empty() => json!({"status":"granted"}),
        Ok(response) => json!({"status":"failed","reason":response.errors.join("; ")}),
        Err(error) => {
            json!({"status":"failed","reason":sanitize_response(&error.to_string(),Some(cookie),Some(api_key))})
        }
    }
}

fn response_keys(value: &Value) -> String {
    value
        .as_object()
        .map(|object| {
            object
                .keys()
                .take(12)
                .map(|key| {
                    key.chars()
                        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                        .take(48)
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "non-object".into())
}

#[derive(Debug)]
struct PermissionCursor {
    parameter: &'static str,
    value: String,
}

fn parse_permissions_page(
    value: &Value,
) -> Result<(Vec<AssetPermission>, Option<PermissionCursor>), String> {
    // Creator Dashboard's generated GET client uses a results array; it currently has no cursor.
    let entries = if value.is_array() {
        value
    } else {
        ["results", "permissions", "data"].iter().find_map(|key| value.get(*key)).ok_or_else(
            || format!("Unrecognized Roblox permissions response keys: [{}]", response_keys(value)),
        )?
    };
    let mut permissions = Vec::new();
    if !entries.is_null() {
        let entries =
            entries.as_array().ok_or("Roblox permissions response must contain an array")?;
        for entry in entries {
            let subject_type = entry.get("subjectType").and_then(Value::as_str).filter(|value| {
                matches!(*value, "User" | "Group" | "GroupRoleset" | "All" | "Universe")
            });
            let action = entry.get("action").and_then(Value::as_str).filter(|value| {
                matches!(*value, "Edit" | "Use" | "Download" | "CopyFromRcc" | "UpdateFromRcc")
            });
            let subject_id = entry.get("subjectId").and_then(|id| {
                id.as_str().map(str::to_owned).or_else(|| id.as_u64().map(|id| id.to_string()))
            });
            let (Some(subject_type), Some(action), Some(subject_id)) =
                (subject_type, action, subject_id)
            else {
                return Err(format!(
                    "Unrecognized Roblox permission entry keys: [{}]",
                    response_keys(entry)
                ));
            };
            if !(valid_id(&subject_id) || subject_type == "All" && subject_id.is_empty()) {
                return Err("Roblox returned an invalid permission subject ID".into());
            }
            permissions.push(AssetPermission {
                subject_type: subject_type.into(),
                subject_id,
                action: action.into(),
            });
        }
    }
    let mut continuation = None;
    for (field, parameter) in
        [("nextPageCursor", "cursor"), ("nextCursor", "cursor"), ("nextPageToken", "pageToken")]
    {
        let Some(token) = value.get(field).filter(|token| !token.is_null()) else {
            continue;
        };
        let token =
            token.as_str().ok_or("Roblox returned an invalid permission pagination token")?;
        if token.is_empty() {
            continue;
        }
        if token.len() > 4096 || continuation.is_some() {
            return Err("Roblox returned an invalid permission pagination token".into());
        }
        continuation = Some(PermissionCursor { parameter, value: token.into() });
    }
    Ok((permissions, continuation))
}

async fn fetch_asset_permissions(
    client: &reqwest::Client,
    base_url: &str,
    cookie: Option<&str>,
    api_key: Option<&str>,
    csrf: &mut String,
) -> Result<Vec<AssetPermission>, String> {
    let mut url = reqwest::Url::parse(base_url).map_err(|_| "Invalid permissions endpoint")?;
    let mut permissions = Vec::new();
    let mut seen = HashSet::new();
    for _ in 0..100 {
        let response = request_with_retry(
            client,
            reqwest::Method::GET,
            url.as_str(),
            None,
            cookie,
            api_key,
            csrf,
        )
        .await?;
        let (page, continuation) = parse_permissions_page(&response)
            .map_err(|reason| sanitize_response(&reason, cookie, api_key))?;
        for permission in page {
            if !permissions.iter().any(|existing: &AssetPermission| {
                existing.subject_type == permission.subject_type
                    && existing.subject_id == permission.subject_id
                    && existing.action == permission.action
            }) {
                permissions.push(permission);
            }
        }
        if permissions.len() > 10_000 {
            return Err("Roblox permissions list exceeded 10000 entries".into());
        }
        let Some(cursor) = continuation else {
            return Ok(permissions);
        };
        if !seen.insert(cursor.value.clone()) {
            return Err("Roblox repeated a permissions pagination token".into());
        }
        url = reqwest::Url::parse(base_url).map_err(|_| "Invalid permissions endpoint")?;
        url.query_pairs_mut().append_pair(cursor.parameter, &cursor.value);
    }
    Err("Roblox permissions list exceeded 100 pages".into())
}

#[tauri::command]
#[specta::specta]
pub async fn get_asset_permissions(
    asset_ids: Vec<String>,
    cookie: Option<String>,
    api_key: Option<String>,
) -> crate::error::Result<Vec<AssetPermissionsResult>> {
    let req = GetAssetPermissionsRequest { asset_ids, cookie, api_key };
    if req.asset_ids.len() > 1000 {
        return Err("Inspect at most 1000 asset IDs per request".into());
    }
    if req.asset_ids.iter().any(|id| !valid_id(id)) {
        return Err("Asset IDs must be positive numeric IDs".into());
    }
    let client = crate::utils::get_http_client();
    let mut csrf = String::new();
    let mut results = Vec::new();
    for id in req.asset_ids {
        let response = fetch_asset_permissions(
            &client,
            &format!("https://apis.roblox.com/asset-permissions-api/v1/assets/{id}/permissions"),
            req.cookie.as_deref(),
            req.api_key.as_deref(),
            &mut csrf,
        )
        .await;
        match response {
            Ok(permissions) => results.push(AssetPermissionsResult {
                asset_id: id,
                success: true,
                permissions,
                reason: None,
            }),
            Err(reason) => results.push(AssetPermissionsResult {
                asset_id: id,
                success: false,
                permissions: vec![],
                reason: Some(reason),
            }),
        }
    }
    Ok(results)
}

#[tauri::command]
#[specta::specta]
pub async fn patch_asset_permissions(
    asset_id: String,
    universe_id: String,
    cookie: String,
    csrf_token: String,
) -> crate::error::Result<bool> {
    if !valid_id(&asset_id) || !valid_id(&universe_id) {
        return Err("Invalid asset or universe ID".into());
    }
    let mut csrf = csrf_token;
    let asset_id = asset_id.parse::<u64>().map_err(|_| "Invalid asset ID")?;
    let body = json!({"subjectType":"Universe","subjectId":universe_id,"action":"Use","requests":[{"assetId":asset_id,"grantToDependencies":false}]});
    let response = request_with_retry(
        &crate::utils::get_http_client(),
        reqwest::Method::PATCH,
        "https://apis.roblox.com/asset-permissions-api/v1/assets/permissions",
        Some(&body),
        Some(&cookie),
        None,
        &mut csrf,
    )
    .await?;
    parse_grant_response(&response, asset_id)?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
pub async fn set_asset_privacy(
    asset_id: String,
    privacy_status: String,
    cookie: String,
    csrf_token: String,
) -> crate::error::Result<bool> {
    let cookie_header = build_roblox_cookie_header(&cookie);
    let client = crate::utils::get_http_client();
    let url = format!("https://apis.roblox.com/asset-privacy/v1/assets/{asset_id}/privacy");

    let body = serde_json::json!({
        "privacyStatus": privacy_status
    });

    let resp = client
        .post(&url)
        .header(COOKIE, cookie_header)
        .header("x-csrf-token", csrf_token)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let parsed_err = if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(&text) {
            crate::utils::extract_human_error(&json_val, Some(status.as_u16()))
        } else {
            format!("HTTP {}: {}", status.as_u16(), text)
        };
        let parsed_err = sanitize_response(&parsed_err, Some(&cookie), None);
        return Err(format!("Could not update asset privacy: {parsed_err}").into());
    }

    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_creator_dashboard_results_and_rejects_unknown_envelopes() {
        let value = json!({"results":[{"subjectType":"Group","subjectId":"764544807","action":"Use","permissionLevel":"Granted","permissionSource":"Direct"}]});
        let (permissions, cursor) = parse_permissions_page(&value).expect("permissions");
        assert!(cursor.is_none());
        assert_eq!(permissions.len(), 1);
        assert_eq!(permissions[0].subject_id, "764544807");
        assert_eq!(permissions[0].subject_type, "Group");
        assert_eq!(permissions[0].action, "Use");
        let serialized = serde_json::to_value(&permissions[0]).expect("serialize");
        assert_eq!(serialized["subjectId"], "764544807");
        assert!(parse_permissions_page(&json!({"unexpected":[{"secret":"never echo me"}]}))
            .expect_err("unknown format")
            .contains("[unexpected]"));
        assert!(!parse_permissions_page(&json!({"results":[{"unexpected":"never echo me"}]}))
            .expect_err("entry failure")
            .contains("never echo me"));
        assert!(parse_permissions_page(&json!({"results":[]})).expect("empty list").0.is_empty());
    }
    #[tokio::test]
    async fn follows_permission_pages_and_rejects_repeated_tokens() {
        use axum::{extract::Query, routing::get, Json, Router};
        use std::collections::HashMap;
        let application=Router::new().route("/permissions",get(|Query(query):Query<HashMap<String,String>>| async move {
            Json(if query.get("cursor").map(String::as_str)==Some("page 2") {json!({"results":[{"subjectType":"User","subjectId":2,"action":"Use"}],"nextPageCursor":null})} else {json!({"results":[{"subjectType":"Group","subjectId":"764544807","action":"Use"}],"nextPageCursor":"page 2"})})
        })).route("/repeated",get(||async{Json(json!({"results":[],"nextPageCursor":"repeat"}))}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let server =
            tokio::spawn(async move { axum::serve(listener, application).await.expect("server") });
        let client = reqwest::Client::new();
        let mut csrf = String::new();
        let permissions = fetch_asset_permissions(
            &client,
            &format!("http://{address}/permissions"),
            None,
            None,
            &mut csrf,
        )
        .await
        .expect("both pages");
        assert_eq!(permissions.len(), 2);
        let reason = fetch_asset_permissions(
            &client,
            &format!("http://{address}/repeated"),
            None,
            None,
            &mut csrf,
        )
        .await
        .expect_err("repeated token");
        assert!(reason.contains("repeated"));
        server.abort();
    }
    #[test]
    fn universe_ids_are_never_interpreted_as_place_ids() {
        assert_eq!(subject_kind("Universe").expect("type"), ("Universe", false));
        assert_eq!(subject_kind("Place").expect("type"), ("Universe", true));
        assert!(validate_permission_targets("Unknown", &["1".into()]).is_err());
        assert!(validate_permission_targets("User", &["0".into()]).is_err());
    }
    #[test]
    fn partial_batch_response_does_not_report_success() {
        let value =
            json!({"successAssetIds":[1],"errors":[{"assetId":2,"code":"CannotManageAsset"}]});
        assert!(parse_grant_response(&value, 1).is_ok());
        assert_eq!(parse_grant_response(&value, 2).expect_err("failure"), "CannotManageAsset");
        assert!(parse_grant_response(&json!({}), 3).is_err());
        assert!(!sanitize_response(
            "secret-cookie secret-key",
            Some("secret-cookie"),
            Some("secret-key")
        )
        .contains("secret"));
    }
}
