use std::collections::HashSet;

use reqwest::{header::COOKIE, Client};
use serde::Deserialize;
use tauri::AppHandle;

use super::{get_authenticated_user_id, RobloxGroup, ROBLOX_USER_AGENT};
use crate::error::Result;

#[derive(Deserialize)]
#[serde(untagged)]
enum GroupEntry {
    Membership { group: RobloxGroup },
    Creator(RobloxGroup),
}

#[derive(Deserialize)]
struct GroupPage {
    data: Vec<GroupEntry>,
    #[serde(rename = "nextPageCursor")]
    next_page_cursor: Option<String>,
}

// Keep the existing IPC command name, but discover upload destinations rather
// than treating the legacy management list as an asset-permission check.
pub(super) async fn get_upload_groups(app: &AppHandle, cookie: String) -> Result<Vec<RobloxGroup>> {
    let cookie_header = crate::utils::build_roblox_cookie_header(&cookie);
    let client = crate::utils::get_http_client();
    let memberships = async {
        let user_id = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            get_authenticated_user_id(app.clone(), cookie),
        )
        .await
        .map_err(|_| {
            crate::error::AppError::Custom("Roblox group account lookup timed out.".into())
        })??;
        let membership_url = format!(
            "https://groups.roblox.com/v2/users/{user_id}/groups/roles?limit=100&sortOrder=Asc"
        );
        fetch_group_pages(&client, &membership_url, &cookie_header, Some(app)).await
    };
    let (creators, legacy, memberships) = tokio::join!(
        fetch_group_pages(
            &client,
            "https://develop.roblox.com/v1/user/groups/canmanagegamesoritems",
            &cookie_header,
            Some(app),
        ),
        fetch_group_pages(
            &client,
            "https://develop.roblox.com/v1/user/groups/canmanage",
            &cookie_header,
            Some(app),
        ),
        memberships,
    );
    merge_group_results([creators, legacy, memberships])
}

async fn fetch_group_pages(
    client: &Client,
    url: &str,
    cookie_header: &str,
    app: Option<&AppHandle>,
) -> Result<Vec<RobloxGroup>> {
    let mut groups = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    for _ in 0..100 {
        let mut request = client
            .get(url)
            .header(COOKIE, cookie_header)
            .header("User-Agent", ROBLOX_USER_AGENT)
            .timeout(std::time::Duration::from_secs(15));
        if let Some(cursor) = &cursor {
            request = request.query(&[("cursor", cursor)]);
        }
        let response = request.send().await.map_err(|error| {
            crate::error::AppError::Custom(format!("Could not reach Roblox group servers: {error}"))
        })?;
        if let Some(app) = app {
            crate::utils::check_for_roblosecurity_update(app, &response, cookie_header);
        }
        if !response.status().is_success() {
            return Err(
                format!("Could not retrieve Roblox groups (HTTP {}).", response.status()).into()
            );
        }
        let page: GroupPage = response.json().await.map_err(|error| {
            crate::error::AppError::Custom(format!(
                "Could not parse Roblox group response: {error}"
            ))
        })?;
        groups.extend(page.data.into_iter().map(|entry| match entry {
            GroupEntry::Membership { group } | GroupEntry::Creator(group) => group,
        }));
        let Some(next) = page.next_page_cursor.filter(|value| !value.is_empty()) else {
            return Ok(groups);
        };
        if !seen_cursors.insert(next.clone()) {
            return Err("Roblox returned a repeated group pagination cursor.".into());
        }
        cursor = Some(next);
    }
    Err("Roblox group pagination exceeded its limit.".into())
}

fn merge_group_results(results: [Result<Vec<RobloxGroup>>; 3]) -> Result<Vec<RobloxGroup>> {
    let mut groups = Vec::new();
    let mut seen = HashSet::new();
    let mut received_list = false;
    let mut first_error = None;
    for result in results {
        match result {
            Ok(found) => {
                received_list = true;
                // A membership can carry several roles, including private Creator
                // Hub roles. Never infer upload rights from a rank or single role.
                // Roblox remains authoritative when the asset is actually uploaded.
                groups.extend(
                    found.into_iter().filter(|group| group.id > 0 && seen.insert(group.id)),
                );
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if !received_list {
        return Err(first_error.unwrap_or_else(|| "Could not retrieve Roblox groups.".into()));
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::Query, routing::get, Json, Router};
    use std::collections::HashMap;

    fn group(id: i64, name: &str) -> RobloxGroup {
        RobloxGroup { id, name: name.into() }
    }

    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let url = format!("http://{}/groups", listener.local_addr().expect("address"));
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.expect("server");
        });
        (url, task)
    }

    #[tokio::test]
    async fn discovers_memberships_across_pages_without_filtering_single_role_or_rank() {
        let router = Router::new().route(
            "/groups",
            get(|Query(query): Query<HashMap<String, String>>| async move {
                if query.get("cursor").map(String::as_str) == Some("next+page&value=1") {
                    Json(serde_json::json!({
                        "data": [{"group": {"id": 2, "name": "Creator role group"},
                            "role": {"rank": 0}, "roles": [{"name": "Admin", "isPublic": false}]}],
                        "nextPageCursor": null
                    }))
                } else {
                    Json(serde_json::json!({
                        "data": [{"group": {"id": 1, "name": "Member group"}, "role": {"rank": 1}}],
                        "nextPageCursor": "next+page&value=1"
                    }))
                }
            }),
        );
        let (url, server) = serve(router).await;
        let result =
            fetch_group_pages(&Client::new(), &url, ".ROBLOSECURITY=synthetic", None).await;
        server.abort();
        let groups = result.expect("memberships");
        assert_eq!(groups.iter().map(|group| group.id).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[tokio::test]
    async fn accepts_creator_list_without_pagination_fields() {
        let router = Router::new().route(
            "/groups",
            get(|| async { Json(serde_json::json!({"data": [{"id": 3, "name": "Creator"}]})) }),
        );
        let (url, server) = serve(router).await;
        let result =
            fetch_group_pages(&Client::new(), &url, ".ROBLOSECURITY=synthetic", None).await;
        server.abort();
        assert_eq!(result.expect("creators")[0].id, 3);
    }

    #[tokio::test]
    async fn rejects_repeated_pagination_cursor() {
        let router = Router::new().route(
            "/groups",
            get(|| async { Json(serde_json::json!({"data": [], "nextPageCursor": "same"})) }),
        );
        let (url, server) = serve(router).await;
        let result =
            fetch_group_pages(&Client::new(), &url, ".ROBLOSECURITY=synthetic", None).await;
        server.abort();
        assert!(result.expect_err("repeated cursor").to_string().contains("repeated"));
    }

    #[test]
    fn keeps_membership_only_groups_and_deduplicates_creator_results() {
        let groups = merge_group_results([
            Ok(vec![group(1, "Creator")]),
            Ok(vec![group(1, "Duplicate"), group(2, "Legacy")]),
            Ok(vec![group(2, "Duplicate"), group(3, "Asset-only role"), group(0, "Invalid")]),
        ])
        .expect("groups");
        assert_eq!(groups.iter().map(|group| group.id).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn keeps_successful_sources_when_an_optional_endpoint_fails() {
        let groups = merge_group_results([
            Err("HTTP 403".into()),
            Ok(vec![]),
            Ok(vec![group(3, "Asset-only role")]),
        ])
        .expect("memberships still available");
        assert_eq!(groups[0].id, 3);
        assert!(merge_group_results([
            Err("offline".into()),
            Err("offline".into()),
            Err("offline".into())
        ])
        .is_err());
    }
}
