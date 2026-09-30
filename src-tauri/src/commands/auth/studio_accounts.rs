use super::studio_cookies::{read_studio_cookies, StudioCookie};
use super::validation::{RobloxUserInfo, ROBLOX_USER_AGENT};
use futures::{stream, StreamExt};
use reqwest::{header, Client, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

const AUTH_ENDPOINT: &str = "https://users.roblox.com/v1/users/authenticated";

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioAccount {
    pub user: RobloxUserInfo,
    pub cookie: String,
    pub is_current: bool,
}

#[derive(Default, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioAccountsResult {
    pub accounts: Vec<StudioAccount>,
    pub rejected_count: u32,
    pub failed_count: u32,
}

enum ValidationOutcome {
    Accepted(StudioAccount),
    Rejected,
    Failed,
}

async fn validate_session(
    client: &Client,
    endpoint: &str,
    session: StudioCookie,
) -> ValidationOutcome {
    let Ok(response) = client
        .get(endpoint)
        .header(header::USER_AGENT, ROBLOX_USER_AGENT)
        .header(header::COOKIE, crate::utils::build_roblox_cookie_header(&session.cookie))
        .send()
        .await
    else {
        return ValidationOutcome::Failed;
    };
    if matches!(response.status(), StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return ValidationOutcome::Rejected;
    }
    if !response.status().is_success() {
        return ValidationOutcome::Failed;
    }
    let refreshed = response.headers().get_all(header::SET_COOKIE).iter().find_map(|value| {
        let value = value.to_str().ok()?.strip_prefix(".ROBLOSECURITY=")?;
        super::cookies::extract_roblox_cookie(value.split(';').next()?)
    });
    let Ok(user) = response.json::<RobloxUserInfo>().await else {
        return ValidationOutcome::Failed;
    };
    if user.id <= 0 || user.name.trim().is_empty() {
        return ValidationOutcome::Failed;
    }
    if session.user_id.as_ref().is_some_and(|id| *id != user.id.to_string()) {
        return ValidationOutcome::Rejected;
    }
    ValidationOutcome::Accepted(StudioAccount {
        user,
        cookie: refreshed.unwrap_or(session.cookie),
        is_current: session.is_current,
    })
}

async fn validate_sessions(
    client: &Client,
    endpoint: &str,
    sessions: Vec<StudioCookie>,
) -> StudioAccountsResult {
    let outcomes = stream::iter(sessions)
        .map(|session| validate_session(client, endpoint, session))
        .buffered(4);
    futures::pin_mut!(outcomes);
    let mut result = StudioAccountsResult::default();
    let mut positions: HashMap<i64, usize> = HashMap::new();
    while let Some(outcome) = outcomes.next().await {
        match outcome {
            ValidationOutcome::Accepted(account) => {
                if let Some(index) = positions.get(&account.user.id) {
                    if account.is_current {
                        result.accounts[*index] = account;
                    }
                } else {
                    positions.insert(account.user.id, result.accounts.len());
                    result.accounts.push(account);
                }
            }
            ValidationOutcome::Rejected => result.rejected_count += 1,
            ValidationOutcome::Failed => result.failed_count += 1,
        }
    }
    result.accounts.sort_by_key(|account| !account.is_current);
    result
}

#[tauri::command]
#[specta::specta]
pub async fn detect_studio_accounts() -> crate::error::Result<StudioAccountsResult> {
    let sessions = tokio::task::spawn_blocking(read_studio_cookies).await.map_err(|_| {
        crate::error::AppError::Custom("Could not read Roblox Studio accounts.".into())
    })??;
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = crate::utils::effective_reqwest_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|_| {
        crate::error::AppError::Custom("Could not initialize Roblox session validation.".into())
    })?;
    Ok(validate_sessions(&client, AUTH_ENDPOINT, sessions).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::HeaderMap, response::IntoResponse, routing::get, Json, Router};

    #[tokio::test]
    async fn validates_identity_deduplicates_and_distinguishes_expiry_from_network_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let endpoint = format!("http://{}/auth", listener.local_addr().expect("address"));
        let router = Router::new().route("/auth", get(|headers: HeaderMap| async move {
            assert!(!headers.contains_key("x-api-key"));
            let cookie = headers.get("cookie").and_then(|header| header.to_str().ok()).unwrap_or_default();
            if cookie.contains("expired") { return StatusCode::UNAUTHORIZED.into_response(); }
            if cookie.contains("offline") { return StatusCode::TOO_MANY_REQUESTS.into_response(); }
            let id = if cookie.contains("second") { 222 } else { 111 };
            Json(serde_json::json!({"id": id, "name": "SyntheticUser", "displayName": "Synthetic"})).into_response()
        }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("server");
        });
        let candidate = |cookie: &str, user_id: Option<&str>, is_current| StudioCookie {
            cookie: cookie.into(),
            user_id: user_id.map(str::to_string),
            is_current,
        };
        let result = validate_sessions(
            &Client::new(),
            &endpoint,
            vec![
                candidate("first", Some("111"), false),
                candidate("first-copy", None, true),
                candidate("second", Some("222"), false),
                candidate("first-wrong-account", Some("999"), false),
                candidate("expired", Some("333"), false),
                candidate("offline", Some("444"), false),
            ],
        )
        .await;
        server.abort();
        assert_eq!(result.accounts.len(), 2);
        assert_eq!(result.accounts[0].user.id, 111);
        assert!(result.accounts[0].is_current);
        assert_eq!(result.accounts[1].user.id, 222);
        assert_eq!(result.rejected_count, 2);
        assert_eq!(result.failed_count, 1);
    }
}
