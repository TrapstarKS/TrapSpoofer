pub mod api;
mod archive;
pub mod resolution;
pub mod types;
pub mod validation;

pub use api::{
    auto_claim_free_asset, batch_get_download_urls_for_assets, send_asset_download_request_ua,
    write_download_response,
};
pub use resolution::{
    attempt_asset_usage_place_id_discovery, attempt_deep_place_id_discovery,
    attempt_social_graph_place_id_discovery, build_cdn_fallback_urls,
    build_direct_asset_download_urls, build_saved_versions_urls, extract_place_id_from_url,
    parse_place_ids, push_unique_url, resolve_asset_economy_urls, resolve_asset_id_location,
};
pub use types::ConcurrentDownloadTask;
pub use validation::validate_downloaded_payload;

use crate::commands::spoofer::{
    build_roblox_cookie_header, emit_transfer_update, is_valid_numeric_id, set_rate_limit,
    wait_rate_limit, AsyncWriteExt, BatchAssetRequest, DownloadResult, File, RateLimitBucket,
    TransferUpdate, CONTENT_LENGTH,
};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const MAX_ARCHIVE_PLACE_IDS: usize = 20;
const PERM_FAILURE_BAIL_THRESHOLD: usize = 20;

fn emit_spoofer_log(app: &AppHandle, level: &str, message: &str) {
    let _ = crate::commands::ipc::append_log_entry(app, level, "spoofer", message);
    let _ = app.emit(
        "spoofer-log",
        serde_json::json!({
            "message": message,
            "level": level,
        }),
    );
}

async fn run_discovery_and_extend_urls(
    app: &AppHandle,
    asset_id: &str,
    asset_type: Option<&str>,
    cookie_header: &str,
    transfer_id: &str,
    name: &str,
    candidate_urls: &mut Vec<String>,
) {
    emit_transfer_update(
        app,
        TransferUpdate {
            id: transfer_id.to_string(),
            name: Some(name.to_string()),
            status: Some("discovering_usage".into()),
            direction: Some("download".into()),
            progress: Some(0),
            error: None,
            original_asset_id: Some(asset_id.to_string()),
            size: None,
            new_asset_id: None,
        },
    );
    let usage_place_ids = attempt_asset_usage_place_id_discovery(asset_id, cookie_header).await;
    if !usage_place_ids.is_empty() {
        emit_spoofer_log(
            app,
            "info",
            &format!(
                "Asset usage discovery found {} candidate Place ID(s) for asset {asset_id}.",
                usage_place_ids.len()
            ),
        );
    }
    for place_id in &usage_place_ids {
        for url in
            build_direct_asset_download_urls(asset_id, asset_type, std::slice::from_ref(place_id))
        {
            push_unique_url(candidate_urls, url);
        }
    }

    emit_transfer_update(
        app,
        TransferUpdate {
            id: transfer_id.to_string(),
            name: Some(name.to_string()),
            status: Some("discovering_graph".into()),
            direction: Some("download".into()),
            progress: Some(0),
            error: None,
            original_asset_id: Some(asset_id.to_string()),
            size: None,
            new_asset_id: None,
        },
    );
    let creator_place_ids = attempt_social_graph_place_id_discovery(asset_id, cookie_header).await;
    if !creator_place_ids.is_empty() {
        emit_spoofer_log(
            app,
            "info",
            &format!(
                "Creator graph discovery found {} candidate Place ID(s) for asset {asset_id}.",
                creator_place_ids.len()
            ),
        );
    }
    for place_id in &creator_place_ids {
        for url in
            build_direct_asset_download_urls(asset_id, asset_type, std::slice::from_ref(place_id))
        {
            push_unique_url(candidate_urls, url);
        }
    }
}

/// Place IDs that are only resolved if the fast path (the batch-resolved
/// direct URL) fails. Resolving creator places costs several API calls, so
/// it is skipped entirely for the common case.
pub type DeferredPlaceIds =
    std::pin::Pin<Box<dyn std::future::Future<Output = Vec<String>> + Send + 'static>>;

/// Builds every fallback download candidate (place-scoped URLs, location
/// resolution, discovery, CDN/economy/version fallbacks). Returns whether the
/// usage/social-graph discovery already ran.
async fn extend_with_fallback_candidates(
    app: &AppHandle,
    client: &reqwest::Client,
    asset_id: &str,
    asset_type: Option<&str>,
    cookie_header: &str,
    transfer_id: &str,
    name: &str,
    place_ids: &mut Vec<String>,
    deferred_place_ids: &mut Option<DeferredPlaceIds>,
    candidate_urls: &mut Vec<String>,
) -> crate::error::Result<bool> {
    if let Some(resolver) = deferred_place_ids.take() {
        for place_id in resolver.await {
            if is_valid_numeric_id(&place_id) && !place_ids.contains(&place_id) {
                place_ids.push(place_id);
            }
        }
    }

    for url in build_direct_asset_download_urls(asset_id, asset_type, place_ids) {
        push_unique_url(candidate_urls, url);
    }

    for place_id in place_ids.iter().map(String::as_str).map(Some).chain(std::iter::once(None)) {
        if let Some(resolved_url) =
            resolve_asset_id_location(app, client, asset_id, cookie_header, place_id).await?
        {
            push_unique_url(candidate_urls, resolved_url);
        }
    }

    let mut discovery_attempted = false;
    if place_ids.is_empty() {
        run_discovery_and_extend_urls(
            app,
            asset_id,
            asset_type,
            cookie_header,
            transfer_id,
            name,
            candidate_urls,
        )
        .await;
        discovery_attempted = true;
    }

    for cdn_url in build_cdn_fallback_urls(asset_id).await {
        push_unique_url(candidate_urls, cdn_url);
    }

    for url in resolve_asset_economy_urls(asset_id, cookie_header).await {
        push_unique_url(candidate_urls, url);
    }

    for url in build_saved_versions_urls(asset_id, cookie_header).await {
        push_unique_url(candidate_urls, url);
    }

    if matches!(asset_type, Some("Audio") | Some("Sound")) {
        if let Some(cdn_url) = api::get_scraped_asset_cdn_url(client, asset_id).await {
            emit_spoofer_log(
                app,
                "info",
                &format!("Web scraper fallback found CDN URL for audio asset {asset_id}."),
            );
            push_unique_url(candidate_urls, cdn_url);
        }
    }

    Ok(discovery_attempted)
}

pub async fn download_animation_asset_with_progress(
    app: AppHandle,
    direct_url: Option<String>,
    cookie: String,
    fallback_cookies: Option<Vec<String>>,
    file_path: String,
    transfer_id: String,
    name: String,
    asset_id: String,
    asset_type: Option<String>,
    place_id: Option<String>,
    enable_archive_recovery: bool,
    proxy_url: Option<String>,
) -> crate::error::Result<DownloadResult> {
    download_asset_with_deferred_places(
        app,
        direct_url,
        cookie,
        fallback_cookies,
        file_path,
        transfer_id,
        name,
        asset_id,
        asset_type,
        place_id,
        None,
        enable_archive_recovery,
        proxy_url,
    )
    .await
}

/// Same as [`download_animation_asset_with_progress`], but when a direct URL
/// is available it is tried first and the (expensive) fallback candidates,
/// including `deferred_place_ids`, are only built if it fails.
pub async fn download_asset_with_deferred_places(
    app: AppHandle,
    direct_url: Option<String>,
    cookie: String,
    fallback_cookies: Option<Vec<String>>,
    file_path: String,
    transfer_id: String,
    name: String,
    asset_id: String,
    asset_type: Option<String>,
    place_id: Option<String>,
    deferred_place_ids: Option<DeferredPlaceIds>,
    enable_archive_recovery: bool,
    proxy_url: Option<String>,
) -> crate::error::Result<DownloadResult> {
    let mut deferred_place_ids = deferred_place_ids;
    if !is_valid_numeric_id(&asset_id) {
        return Err("Invalid Roblox asset ID: IDs must contain only numeric digits.".into());
    }
    let file_path_buf = std::path::PathBuf::from(&file_path);
    if file_path_buf.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("Invalid target destination: path traversal is not permitted.".into());
    }

    if let Some(parent) = file_path_buf.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|_| "Could not create or access the download destination folder.")?;
    }

    let mut cookie_header = build_roblox_cookie_header(&cookie);
    if cookie_header.is_empty() {
        return Err(
            "Missing or invalid .ROBLOSECURITY cookie. Please check your account in Settings."
                .into(),
        );
    }

    emit_transfer_update(
        &app,
        TransferUpdate {
            id: transfer_id.clone(),
            name: Some(name.clone()),
            status: Some("resolving_location".into()),
            direction: Some("download".into()),
            progress: Some(0),
            error: None,
            original_asset_id: Some(asset_id.clone()),
            size: None,
            new_asset_id: None,
        },
    );

    let client = crate::utils::get_http_client_with_proxy(proxy_url.as_deref());
    let mut place_ids = parse_place_ids(place_id.as_deref());

    if let Some(cached_place_id) =
        crate::commands::spoofer::remote_cache::get_local_context(&asset_id)
    {
        if !place_ids.contains(&cached_place_id) {
            place_ids.insert(0, cached_place_id);
        }
    }

    let mut last_error =
        "Download failed before Roblox returned a usable asset location.".to_string();
    let mut candidate_urls = Vec::new();
    let mut discovery_attempted = false;
    // Fast path: when the batch endpoint already produced a direct URL, try it
    // alone first and only build the expensive fallback list if it fails.
    let mut fallbacks_built = false;

    if let Some(url) = direct_url.filter(|url| !url.trim().is_empty()) {
        push_unique_url(&mut candidate_urls, url);
    } else {
        discovery_attempted = extend_with_fallback_candidates(
            &app,
            &client,
            &asset_id,
            asset_type.as_deref(),
            &cookie_header,
            &transfer_id,
            &name,
            &mut place_ids,
            &mut deferred_place_ids,
            &mut candidate_urls,
        )
        .await
        .unwrap_or_else(|error| {
            last_error = format!("Fallback location resolution failed: {error}");
            false
        });
        fallbacks_built = true;
    }

    let mut universes_by_place = HashMap::new();
    let mut attempts = DownloadAttempts::default();
    let mut attempted_claim = false;
    let user_agents =
        ["RobloxStudio/WinInet", "RobloxApp/WinInet", "Roblox/WinInet", "roblox/9.0.0.0 (WinInet)"];

    let mut consecutive_perm_failures: usize = 0;

    let mut is_first_url = true;
    let mut i: usize = 0;
    'phases: loop {
        while i < candidate_urls.len() {
            let candidate_idx = i;
            let candidate_url_count = candidate_urls.len();
            i += 1;
            let download_url = &candidate_urls[candidate_idx];

            emit_transfer_update(
                &app,
                TransferUpdate {
                    id: transfer_id.clone(),
                    name: Some(name.clone()),
                    status: Some(format!(
                        "downloading:{}/{}",
                        candidate_idx + 1,
                        candidate_url_count
                    )),
                    direction: Some("download".into()),
                    progress: Some(0),
                    error: None,
                    original_asset_id: Some(asset_id.clone()),
                    size: None,
                    new_asset_id: None,
                },
            );

            if candidate_idx > 0 && candidate_idx % 10 == 0 {
                emit_spoofer_log(
                    &app,
                    "info",
                    &format!(
                        "Still trying asset {asset_id}: candidate {}/{}.",
                        candidate_idx + 1,
                        candidate_url_count
                    ),
                );
            }

            let mut this_url_was_perm_failure = false;
            let is_cdn_url = download_url.contains("rbxcdn.com");
            let context = resolve_download_context(
                download_url,
                place_ids.first().map(String::as_str),
                &mut universes_by_place,
                |pid| {
                    let cookie = cookie_header.clone();
                    async move {
                        crate::commands::spoofer::get_universe_id_from_place_id(pid, cookie)
                            .await
                            .ok()
                    }
                },
            )
            .await;

            let mut resume_offset = if is_first_url {
                if let Ok(meta) = tokio::fs::metadata(&file_path).await {
                    meta.len()
                } else {
                    0
                }
            } else {
                0
            };
            is_first_url = false;

            for attempt in 0..3u64 {
                if attempt > 0 {
                    if let Ok(meta) = tokio::fs::metadata(&file_path).await {
                        resume_offset = meta.len();
                    }
                }
                let ua = user_agents[attempt as usize % user_agents.len()];
                let cookie_for_req = if is_cdn_url { None } else { Some(cookie_header.as_str()) };
                wait_rate_limit(RateLimitBucket::AssetDownload).await;
                let send_result = tokio::time::timeout(
                    Duration::from_secs(30),
                    send_asset_download_request_ua(
                        &client,
                        download_url,
                        cookie_for_req,
                        context.place_id.as_deref(),
                        ua,
                        context.universe_id.as_deref(),
                        resume_offset,
                    ),
                )
                .await;
                let download_resp = match send_result {
                    Ok(Ok(resp)) => resp,
                    Ok(Err(error)) => {
                        last_error = format!("Download request failed: {error}");
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(1000 * (attempt + 1))).await;
                            continue;
                        }
                        break;
                    }
                    Err(_elapsed) => {
                        last_error = "Download request timed out.".to_string();
                        if attempt < 2 {
                            tokio::time::sleep(Duration::from_millis(1000 * (attempt + 1))).await;
                            continue;
                        }
                        break;
                    }
                };

                crate::utils::check_for_roblosecurity_update(&app, &download_resp, &cookie_header);
                let status = download_resp.status();
                attempts.record_http_status(status);

                if status.is_success() {
                    match write_download_response(
                        &app,
                        download_resp,
                        file_path.clone(),
                        transfer_id.clone(),
                        name.clone(),
                        asset_id.clone(),
                        asset_type.clone(),
                        resume_offset,
                    )
                    .await
                    {
                        Ok(res) => {
                            let res = match attempts.accept_candidate(res, context.place_id.clone())
                            {
                                Ok(res) => res,
                                Err(error) => {
                                    last_error = error;
                                    this_url_was_perm_failure = true;
                                    break;
                                }
                            };
                            crate::commands::spoofer::record_adaptive_success();
                            emit_transfer_update(
                                &app,
                                TransferUpdate {
                                    id: transfer_id.clone(),
                                    name: Some(name.clone()),
                                    status: Some("done".into()),
                                    direction: Some("download".into()),
                                    progress: Some(100),
                                    error: None,
                                    original_asset_id: Some(asset_id.clone()),
                                    size: None,
                                    new_asset_id: None,
                                },
                            );
                            return Ok(res);
                        }
                        Err(e) => {
                            last_error = format!("Download stream failed: {e}");
                            if attempt < 2 {
                                tokio::time::sleep(Duration::from_millis(1000 * (attempt + 1)))
                                    .await;
                                continue;
                            }
                            break;
                        }
                    }
                }

                let mut status_reason = status.to_string();
                if status == reqwest::StatusCode::UNAUTHORIZED {
                    let error_msg = "Your Roblox session cookie is invalid or expired. Please sign in again or update your .ROBLOSECURITY cookie.".to_string();
                    emit_transfer_update(
                        &app,
                        TransferUpdate {
                            id: transfer_id.clone(),
                            status: Some("error".into()),
                            error: Some(error_msg.clone()),
                            progress: Some(0),
                            name: None,
                            original_asset_id: None,
                            direction: None,
                            size: None,
                            new_asset_id: None,
                        },
                    );
                    return Ok(DownloadResult {
                        success: false,
                        file_path: None,
                        error: Some(error_msg),
                        resolved_place_id: None,
                    });
                } else if status == reqwest::StatusCode::FORBIDDEN {
                    status_reason =
                        "Permission Denied: Asset is private, copylocked, or belongs to a restricted universe."
                            .to_string();
                } else if status == reqwest::StatusCode::NOT_FOUND {
                    status_reason = "Not Found: The asset or referenced place does not exist or has been removed.".to_string();
                } else if status == reqwest::StatusCode::CONFLICT {
                    status_reason =
                        "Conflict: Roblox asset delivery was blocked for this asset.".to_string();
                }

                let _ = crate::commands::ipc::append_log_entry(
                    &app,
                    "debug",
                    "spoofer",
                    &format!("Download failed for asset {asset_id} ({status_reason}) from {download_url}"),
                );
                log::debug!(
                    "Download failed for asset {asset_id} ({status_reason}) from {download_url}"
                );
                last_error = format!("Download failed: {status_reason}");
                crate::commands::spoofer::remote_cache::invalidate_context(&asset_id);

                if should_attempt_claim(status) && !attempted_claim {
                    attempted_claim = true;
                    if let Ok(true) =
                        auto_claim_free_asset(&app, &client, &asset_id, &cookie_header).await
                    {
                        continue;
                    }
                }

                if is_retryable_download_status(status) && attempt < 2 {
                    let retry_after_ms = crate::utils::extract_retry_after(&download_resp, None)
                        .unwrap_or_else(|| 800 * (attempt + 1));
                    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                        if let Some(ref fallbacks) = fallback_cookies {
                            let mut current_idx = 0;
                            for (i, fc) in fallbacks.iter().enumerate() {
                                if cookie_header.contains(fc) {
                                    current_idx = i + 1;
                                    break;
                                }
                            }
                            if current_idx < fallbacks.len() {
                                let next_cookie = fallbacks[current_idx].clone();
                                cookie_header = build_roblox_cookie_header(&next_cookie);
                                emit_spoofer_log(
                                &app,
                                "info",
                                &format!(
                                    "Rate limited downloading asset {asset_id}. Switching to fallback downloader {}/{}...",
                                    current_idx + 1, fallbacks.len()
                                ),
                            );
                                tokio::time::sleep(Duration::from_millis(500)).await;
                                continue;
                            }
                        }

                        crate::commands::spoofer::record_adaptive_rate_limit(Some(retry_after_ms));
                        set_rate_limit(
                            RateLimitBucket::AssetDownload,
                            Duration::from_millis(retry_after_ms),
                        );
                        if crate::commands::spoofer::should_log_rate_limit_warning("asset-download")
                        {
                            emit_spoofer_log(
                                &app,
                                "warn",
                                &format!(
                                    "Roblox rate limited downloads; backing off for {:.1}s.",
                                    retry_after_ms as f64 / 1000.0
                                ),
                            );
                        }
                    } else if status.is_server_error() {
                        crate::commands::spoofer::record_adaptive_server_error();
                    }
                    tokio::time::sleep(Duration::from_millis(retry_after_ms)).await;
                    continue;
                }

                this_url_was_perm_failure = true;
                break;
            }

            if this_url_was_perm_failure {
                consecutive_perm_failures += 1;
            } else {
                consecutive_perm_failures = 0;
            }

            if attempts.should_stop_candidates(consecutive_perm_failures) {
                emit_spoofer_log(
                &app,
                "info",
                &format!(
                    "Giving up on asset {asset_id} after {consecutive_perm_failures} consecutive permanent failures ({}/{} candidates tried).",
                    candidate_idx + 1,
                    candidate_url_count
                ),
            );
                break;
            }
        }

        if !fallbacks_built {
            fallbacks_built = true;
            let before = candidate_urls.len();
            discovery_attempted |= extend_with_fallback_candidates(
                &app,
                &client,
                &asset_id,
                asset_type.as_deref(),
                &cookie_header,
                &transfer_id,
                &name,
                &mut place_ids,
                &mut deferred_place_ids,
                &mut candidate_urls,
            )
            .await
            .unwrap_or_else(|error| {
                last_error = format!("Fallback location resolution failed: {error}");
                false
            });
            if candidate_urls.len() > before {
                consecutive_perm_failures = 0;
                continue 'phases;
            }
        }

        if !discovery_attempted {
            discovery_attempted = true;
            let before = candidate_urls.len();
            run_discovery_and_extend_urls(
                &app,
                &asset_id,
                asset_type.as_deref(),
                &cookie_header,
                &transfer_id,
                &name,
                &mut candidate_urls,
            )
            .await;
            let added = candidate_urls.len().saturating_sub(before);
            if added > 0 {
                emit_spoofer_log(
                    &app,
                    "info",
                    &format!(
                        "Direct URLs exhausted for asset {asset_id}; falling back to {added} discovered candidate(s)."
                    ),
                );
                consecutive_perm_failures = 0;
                continue 'phases;
            }
        }

        if attempts.take_archive_recovery(enable_archive_recovery) {
            emit_transfer_update(
                &app,
                TransferUpdate {
                    id: transfer_id.clone(),
                    status: Some("recovering".into()),
                    error: None,
                    progress: Some(0),
                    name: Some(format!("{name} (Wayback Discovery)")),
                    original_asset_id: Some(asset_id.clone()),
                    direction: Some("download".into()),
                    size: None,
                    new_asset_id: None,
                },
            );

            let mut excluded_place_ids = place_ids.clone();
            excluded_place_ids
                .extend(candidate_urls.iter().filter_map(|url| extract_place_id_from_url(url)));
            excluded_place_ids.sort();
            excluded_place_ids.dedup();
            let recovery_error = match attempt_deep_place_id_discovery(
                &app,
                &asset_id,
                &cookie_header,
                MAX_ARCHIVE_PLACE_IDS as u32,
                &excluded_place_ids,
            )
            .await
            {
                Ok(recovered_place_ids) => {
                    if recovered_place_ids.is_empty() {
                        "Wayback Archive discovery could not find any archived place IDs for this asset.".to_string()
                    } else if let Some(start) = append_archive_candidates(
                        &asset_id,
                        asset_type.as_deref(),
                        &recovered_place_ids,
                        &place_ids,
                        &mut candidate_urls,
                    ) {
                        i = start;
                        consecutive_perm_failures = 0;
                        emit_spoofer_log(
                            &app,
                            "info",
                            &format!(
                                "Wayback Discovery added {} new download candidate(s) for asset {asset_id}.",
                                candidate_urls.len() - start,
                            ),
                        );
                        continue 'phases;
                    } else {
                        "Wayback Archive discovery found no new place IDs for this asset."
                            .to_string()
                    }
                }
                Err(e) => {
                    format!("Wayback Archive search encountered an error: {e}")
                }
            };
            last_error.push_str(&format!(" {recovery_error}"));
        }
        break 'phases;
    }

    if place_ids.is_empty()
        && !candidate_urls.iter().any(|url| extract_place_id_from_url(url).is_some())
        && (last_error.contains("Permission Denied") || last_error.contains("Conflict"))
    {
        last_error.push_str(
            " No Place ID was found for place-scoped asset delivery. Try providing a published Place ID under 'Force Place ID(s)' or scanning directly from Studio.",
        );
    }
    let failure_stage =
        if candidate_urls.is_empty() { "failed_discovery" } else { "failed_download" };
    emit_transfer_update(
        &app,
        TransferUpdate {
            id: transfer_id.clone(),
            status: Some(failure_stage.into()),
            error: Some(last_error.clone()),
            progress: Some(0),
            name: Some(name),
            original_asset_id: Some(asset_id),
            direction: Some("download".into()),
            size: None,
            new_asset_id: None,
        },
    );

    Ok(DownloadResult {
        success: false,
        file_path: None,
        error: Some(last_error),
        resolved_place_id: None,
    })
}

fn should_attempt_claim(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::CONFLICT
        || status == reqwest::StatusCode::FORBIDDEN
        || status == reqwest::StatusCode::NOT_FOUND
}

fn is_retryable_download_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn numeric_place_id(value: &str) -> Option<u64> {
    let value = value.trim();
    if !is_valid_numeric_id(value) {
        return None;
    }
    value.parse::<u64>().ok().filter(|id| *id > 0)
}

fn append_archive_candidates(
    asset_id: &str,
    asset_type: Option<&str>,
    recovered_place_ids: &[String],
    known_place_ids: &[String],
    candidate_urls: &mut Vec<String>,
) -> Option<usize> {
    if !is_valid_numeric_id(asset_id) {
        return None;
    }
    let mut seen: HashSet<u64> =
        known_place_ids.iter().filter_map(|id| numeric_place_id(id)).collect();
    for url in candidate_urls.iter() {
        if let Some(id) = extract_place_id_from_url(url).and_then(|id| numeric_place_id(&id)) {
            seen.insert(id);
        }
    }
    let fresh_places: Vec<String> = recovered_place_ids
        .iter()
        .filter_map(|id| numeric_place_id(id))
        .filter(|id| seen.insert(*id))
        .take(MAX_ARCHIVE_PLACE_IDS)
        .map(|id| id.to_string())
        .collect();
    if fresh_places.is_empty() {
        return None;
    }
    let start = candidate_urls.len();
    for url in build_direct_asset_download_urls(asset_id, asset_type, &fresh_places) {
        push_unique_url(candidate_urls, url);
    }
    (candidate_urls.len() > start).then_some(start)
}

struct DownloadContext {
    place_id: Option<String>,
    universe_id: Option<String>,
}

async fn resolve_download_context<F, Fut>(
    download_url: &str,
    fallback_place_id: Option<&str>,
    universes_by_place: &mut HashMap<String, Option<String>>,
    resolve_universe: F,
) -> DownloadContext
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Option<String>>,
{
    let place_id = extract_place_id_from_url(download_url)
        .or_else(|| fallback_place_id.map(str::to_string))
        .and_then(|id| numeric_place_id(&id))
        .map(|id| id.to_string());
    let universe_id = if let Some(ref pid) = place_id {
        if let Some(cached) = universes_by_place.get(pid) {
            cached.clone()
        } else {
            let resolved = resolve_universe(pid.clone()).await;
            universes_by_place.insert(pid.clone(), resolved.clone());
            resolved
        }
    } else {
        None
    };
    DownloadContext { place_id, universe_id }
}

#[derive(Default)]
struct DownloadAttempts {
    recoverable_failure: bool,
    finished: bool,
    archive_attempted: bool,
}

impl DownloadAttempts {
    fn record_http_status(&mut self, status: reqwest::StatusCode) {
        self.recoverable_failure |= matches!(status.as_u16(), 403 | 404 | 409 | 410);
        self.finished |= status == reqwest::StatusCode::UNAUTHORIZED;
    }

    fn accept_candidate(
        &mut self,
        mut result: DownloadResult,
        place_id: Option<String>,
    ) -> Result<DownloadResult, String> {
        if !result.success {
            self.recoverable_failure = true;
            return Err(result
                .error
                .filter(|error| !error.trim().is_empty())
                .unwrap_or_else(|| "Downloaded asset did not contain usable content.".into()));
        }
        self.finished = true;
        result.resolved_place_id = place_id;
        Ok(result)
    }

    const fn should_stop_candidates(&self, consecutive_perm_failures: usize) -> bool {
        !self.archive_attempted && consecutive_perm_failures >= PERM_FAILURE_BAIL_THRESHOLD
    }

    fn take_archive_recovery(&mut self, enabled: bool) -> bool {
        if !enabled || !self.recoverable_failure || self.finished || self.archive_attempted {
            return false;
        }
        self.archive_attempted = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_candidates_append_only_fresh_hints_after_existing_queue() {
        let asset_id = "123456789";
        let mut urls = build_direct_asset_download_urls(asset_id, Some("audio"), &[]);
        urls.extend(build_direct_asset_download_urls(
            asset_id,
            Some("audio"),
            &["123450".into(), "123451".into()],
        ));
        let original = urls.clone();
        let recovered = [
            "123450",
            "000123451",
            "123452",
            "123460",
            " 123460 ",
            "123461",
            "0",
            "-1",
            "1&placeId=2",
            "18446744073709551616",
        ]
        .map(str::to_string);
        let start = append_archive_candidates(
            asset_id,
            Some("audio"),
            &recovered,
            &["123452".into()],
            &mut urls,
        )
        .expect("new candidates");
        assert_eq!(start, original.len());
        assert_eq!(&urls[..start], original);
        let new_places: Vec<String> =
            urls[start..].iter().filter_map(|url| extract_place_id_from_url(url)).collect();
        assert_eq!(new_places, ["123460", "123460", "123461", "123461"]);
        for url in &urls[start..] {
            let parsed = reqwest::Url::parse(url).expect("candidate URL");
            let query: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            assert_eq!(parsed.host_str(), Some("assetdelivery.roblox.com"));
            assert_eq!(query.get("id").map(String::as_str), Some(asset_id));
            assert_eq!(query.get("expectedAssetType").map(String::as_str), Some("Audio"));
        }
        let appended = urls.clone();
        assert!(append_archive_candidates(
            asset_id,
            Some("audio"),
            &recovered,
            &["123452".into()],
            &mut urls,
        )
        .is_none());
        assert_eq!(urls, appended);
    }

    #[test]
    fn archive_candidates_empty_or_known_hints_do_not_replay() {
        let mut urls =
            build_direct_asset_download_urls("123456789", Some("animation"), &["123450".into()]);
        let original = urls.clone();
        for recovered in [vec![], vec!["123450".into(), "000123450".into(), "0".into()]] {
            assert!(append_archive_candidates(
                "123456789",
                Some("animation"),
                &recovered,
                &[],
                &mut urls,
            )
            .is_none());
            assert_eq!(urls, original);
        }
        assert!(append_archive_candidates(
            "123456789&placeId=1",
            Some("animation"),
            &["123451".into()],
            &[],
            &mut urls,
        )
        .is_none());
        assert_eq!(urls, original);
    }

    #[test]
    fn archive_candidates_bound_fresh_hints_after_deduplication() {
        let mut recovered = vec!["123450".to_string(); MAX_ARCHIVE_PLACE_IDS * 3];
        recovered.extend(["0".into(), "bad".into(), "18446744073709551616".into()]);
        for index in 0..MAX_ARCHIVE_PLACE_IDS + 10 {
            recovered.push((223450 + index).to_string());
            recovered.push(format!("00{}", 223450 + index));
        }
        let mut urls = Vec::new();
        assert_eq!(
            append_archive_candidates(
                "123456789",
                Some("animation"),
                &recovered,
                &["123450".into()],
                &mut urls,
            ),
            Some(0),
        );
        assert_eq!(urls.len(), MAX_ARCHIVE_PLACE_IDS * 2);
        let places: Vec<String> =
            urls.iter().filter_map(|url| extract_place_id_from_url(url)).collect();
        let expected: Vec<String> = (0..MAX_ARCHIVE_PLACE_IDS)
            .flat_map(|index| [(223450 + index).to_string(), (223450 + index).to_string()])
            .collect();
        assert_eq!(places, expected);
    }

    #[test]
    fn archive_candidates_keep_their_budget_without_replaying_old_tail() {
        let old_places: Vec<String> =
            (0..MAX_ARCHIVE_PLACE_IDS + 10).map(|index| (123450 + index).to_string()).collect();
        let fresh_places: Vec<String> =
            (0..MAX_ARCHIVE_PLACE_IDS).map(|index| (223450 + index).to_string()).collect();
        let mut urls =
            build_direct_asset_download_urls("123456789", Some("animation"), &old_places);
        let old_count = urls.len();
        let mut attempts = DownloadAttempts::default();
        let mut visited = Vec::new();
        let mut failures = 0;
        for url in &urls {
            visited.push(url.clone());
            attempts.record_http_status(reqwest::StatusCode::FORBIDDEN);
            failures += 1;
            if attempts.should_stop_candidates(failures) {
                break;
            }
        }
        assert_eq!(visited.len(), PERM_FAILURE_BAIL_THRESHOLD);
        assert!(visited.len() < old_count);
        assert!(attempts.take_archive_recovery(true));
        let start = append_archive_candidates(
            "123456789",
            Some("animation"),
            &fresh_places,
            &old_places,
            &mut urls,
        )
        .expect("new candidates");
        failures = 0;
        for url in &urls[start..] {
            visited.push(url.clone());
            attempts.record_http_status(reqwest::StatusCode::FORBIDDEN);
            failures += 1;
            if attempts.should_stop_candidates(failures) {
                break;
            }
        }
        assert_eq!(failures, MAX_ARCHIVE_PLACE_IDS * 2);
        assert_eq!(visited.len(), PERM_FAILURE_BAIL_THRESHOLD + MAX_ARCHIVE_PLACE_IDS * 2);
        assert_eq!(visited.iter().collect::<HashSet<_>>().len(), visited.len());
        assert!(visited[PERM_FAILURE_BAIL_THRESHOLD..].iter().all(|url| {
            let pid = extract_place_id_from_url(url).expect("place");
            fresh_places.contains(&pid)
        }));
        assert!(!attempts.take_archive_recovery(true));
    }

    #[tokio::test]
    async fn download_context_follows_each_candidate_and_reuses_place_cache() {
        let client = reqwest::Client::new();
        let mut universes = HashMap::new();
        let mut lookups = Vec::new();
        for place_id in ["123450", "223450", "223450", "123450"] {
            let url = build_direct_asset_download_urls(
                "123456789",
                Some("animation"),
                &[place_id.to_string()],
            )
            .remove(0);
            let context = resolve_download_context(&url, Some("123450"), &mut universes, |pid| {
                lookups.push(pid.clone());
                std::future::ready(Some(format!("9{pid}")))
            })
            .await;
            assert_eq!(context.place_id.as_deref(), Some(place_id));
            assert_eq!(context.universe_id.as_deref(), Some(format!("9{place_id}").as_str()));
            let request = crate::commands::spoofer::apply_roblox_game_context(
                client.get(&url),
                context.place_id.as_deref(),
                context.universe_id.as_deref(),
            )
            .build()
            .expect("request");
            assert_eq!(request.headers()["Roblox-Place-Id"], place_id);
            assert_eq!(request.headers()["Roblox-Universe-Id"], format!("9{place_id}"));
            let session: serde_json::Value = serde_json::from_str(
                request.headers()["Roblox-Session-Id"].to_str().expect("session header"),
            )
            .expect("session JSON");
            assert_eq!(session["PlaceId"].as_u64(), numeric_place_id(place_id));
        }
        assert_eq!(lookups, ["123450", "223450"]);
    }

    #[tokio::test]
    async fn download_context_missing_universe_never_inherits_another_place() {
        let client = reqwest::Client::new();
        let mut universes = HashMap::from([("123450".into(), Some("9123450".into()))]);
        let mut lookups = Vec::new();
        let url = "https://assetdelivery.roblox.com/v1/asset?id=123456789&placeId=223450";
        for _ in 0..2 {
            let context = resolve_download_context(url, Some("123450"), &mut universes, |pid| {
                lookups.push(pid);
                std::future::ready(None)
            })
            .await;
            assert_eq!(context.place_id.as_deref(), Some("223450"));
            assert!(context.universe_id.is_none());
            let request = crate::commands::spoofer::apply_roblox_game_context(
                client.get(url),
                context.place_id.as_deref(),
                context.universe_id.as_deref(),
            )
            .build()
            .expect("request");
            assert_eq!(request.headers()["Roblox-Place-Id"], "223450");
            assert!(!request.headers().contains_key("Roblox-Universe-Id"));
        }
        let unscoped = "https://assetdelivery.roblox.com/v1/asset?id=123456789";
        let context = resolve_download_context(
            unscoped,
            None,
            &mut universes,
            |_| -> std::future::Ready<Option<String>> {
                panic!("an unscoped request must not resolve a universe");
            },
        )
        .await;
        assert!(context.place_id.is_none());
        assert!(context.universe_id.is_none());
        let context = resolve_download_context(
            unscoped,
            Some("123450"),
            &mut universes,
            |_| -> std::future::Ready<Option<String>> {
                panic!("cached universe must be reused");
            },
        )
        .await;
        assert_eq!(context.universe_id.as_deref(), Some("9123450"));
        assert_eq!(lookups, ["223450"]);

        let context = resolve_download_context(url, Some("123450"), &mut HashMap::new(), |_| {
            std::future::ready(Some("9223450".into()))
        })
        .await;
        assert_eq!(context.universe_id.as_deref(), Some("9223450"));
    }

    #[test]
    fn archive_recovery_requires_opt_in_and_runs_once() {
        for status in [403, 404, 409, 410] {
            let mut attempts = DownloadAttempts::default();
            attempts.record_http_status(reqwest::StatusCode::from_u16(status).expect("status"));
            assert!(!attempts.take_archive_recovery(false));
            assert!(attempts.take_archive_recovery(true));
            assert!(!attempts.take_archive_recovery(true));
        }
    }

    #[test]
    fn archive_recovery_preserves_failure_after_later_errors() {
        for first_status in [403, 409] {
            let mut attempts = DownloadAttempts::default();
            for status in [first_status, 404, 408, 429, 502] {
                attempts.record_http_status(reqwest::StatusCode::from_u16(status).expect("status"));
            }
            assert!(attempts.take_archive_recovery(true));
        }
    }

    #[test]
    fn archive_recovery_rejects_unrelated_errors_and_stops_on_unauthorized() {
        for status in [400, 401, 408, 429, 500] {
            let mut attempts = DownloadAttempts::default();
            attempts.record_http_status(reqwest::StatusCode::from_u16(status).expect("status"));
            assert!(!attempts.take_archive_recovery(true));
        }
        let mut attempts = DownloadAttempts::default();
        attempts.record_http_status(reqwest::StatusCode::FORBIDDEN);
        attempts.record_http_status(reqwest::StatusCode::UNAUTHORIZED);
        assert!(!attempts.take_archive_recovery(true));
    }

    #[test]
    fn invalid_payload_allows_only_explicit_archive_recovery() {
        for enabled in [false, true] {
            let mut attempts = DownloadAttempts::default();
            attempts.record_http_status(reqwest::StatusCode::OK);
            let result = attempts.accept_candidate(
                DownloadResult {
                    success: false,
                    file_path: None,
                    error: Some("Downloaded asset response was an error page.".into()),
                    resolved_place_id: None,
                },
                Some("987654321".into()),
            );
            assert_eq!(
                result.err().expect("invalid candidate"),
                "Downloaded asset response was an error page.",
            );
            assert_eq!(attempts.take_archive_recovery(enabled), enabled);
        }
    }

    #[tokio::test]
    async fn invalid_candidate_advances_to_valid_payload_and_stops(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let candidates: [(&str, &[u8]); 3] = [
            ("invalid", b"<!doctype html><title>Forbidden</title>"),
            ("valid", b"<roblox version=\"4\"><Item class=\"KeyframeSequence\" /></roblox>"),
            ("unused", b"<roblox version=\"4\"><Item class=\"KeyframeSequence\" /></roblox>"),
        ];
        let mut attempts = DownloadAttempts::default();
        let mut visited = Vec::new();
        let mut errors = Vec::new();
        let mut selected = None;
        for (index, (name, body)) in candidates.into_iter().enumerate() {
            visited.push(name);
            attempts.record_http_status(reqwest::StatusCode::OK);
            let path = std::env::temp_dir()
                .join(format!("trapspoofer-candidate-{}-{name}.rbxm", uuid::Uuid::new_v4()));
            tokio::fs::write(&path, body).await?;
            let path_string = path.to_string_lossy().to_string();
            let validation = validate_downloaded_payload(&path_string, Some("animation")).await;
            tokio::fs::remove_file(&path).await?;
            let valid = validation.is_ok();
            let result = attempts.accept_candidate(
                DownloadResult {
                    success: valid,
                    file_path: valid.then_some(path_string),
                    error: validation.err(),
                    resolved_place_id: None,
                },
                Some((123450 + index).to_string()),
            );
            match result {
                Ok(result) => {
                    selected = Some(result);
                    break;
                }
                Err(error) => errors.push(error),
            }
        }
        assert_eq!(visited, ["invalid", "valid"]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("error page"));
        let selected = selected.expect("valid candidate");
        assert!(selected.success);
        assert!(selected.file_path.as_deref().is_some_and(|path| path.ends_with("-valid.rbxm")));
        assert_eq!(selected.resolved_place_id.as_deref(), Some("123451"));
        assert!(!attempts.take_archive_recovery(true));
        Ok(())
    }

    #[test]
    fn direct_download_urls_do_not_use_zero_server_place_id() {
        let urls =
            build_direct_asset_download_urls("123456789", Some("animation"), &["987654321".into()]);
        assert!(!urls.iter().any(|url| url.contains("serverplaceid=0")));
        assert!(urls.iter().any(|url| url.contains("serverplaceid=987654321")));
    }

    #[tokio::test]
    async fn validation_rejects_error_page_downloads() -> Result<(), Box<dyn std::error::Error>> {
        let path = std::env::temp_dir().join("trapspoofer-invalid-download.html");
        tokio::fs::write(&path, b"<!doctype html><title>Forbidden</title>").await?;
        let path_string = path.to_string_lossy().to_string();
        let result = validate_downloaded_payload(&path_string, Some("audio")).await;
        let _ = tokio::fs::remove_file(path).await;
        assert!(result.is_err());
        Ok(())
    }
}
