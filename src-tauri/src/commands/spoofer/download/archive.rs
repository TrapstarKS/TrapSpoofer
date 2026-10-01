use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::{Client, StatusCode, Url};
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::time::Instant;

const CDX_ENDPOINT: &str = "https://web.archive.org/cdx/search/cdx";
const MAX_PLACES: usize = 20;

#[derive(Clone, Copy)]
struct LookupLimits {
    request_timeout: Duration,
    queue_timeout: Duration,
    total_timeout: Duration,
    response_bytes: usize,
}

impl Default for LookupLimits {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(6),
            queue_timeout: Duration::from_secs(120),
            total_timeout: Duration::from_secs(25),
            response_bytes: 512 * 1024,
        }
    }
}

struct ArchiveGate {
    permits: Semaphore,
    cooldown: Mutex<Option<Instant>>,
}

impl Default for ArchiveGate {
    fn default() -> Self {
        Self { permits: Semaphore::new(2), cooldown: Mutex::new(None) }
    }
}

impl ArchiveGate {
    fn available(&self) -> Result<(), String> {
        let cooldown = self.cooldown.lock().map_err(|_| "Archive recovery is unavailable.")?;
        if cooldown.is_some_and(|deadline| deadline > Instant::now()) {
            return Err("The archive service is rate limited. Try recovery again later.".into());
        }
        Ok(())
    }

    fn rate_limited(&self, duration: Duration) {
        if let Ok(mut cooldown) = self.cooldown.lock() {
            let duration = duration.clamp(Duration::from_secs(1), Duration::from_secs(120));
            let deadline = Instant::now() + duration;
            *cooldown = Some(cooldown.map_or(deadline, |previous| previous.max(deadline)));
        }
    }
}

#[derive(Debug)]
pub(super) struct ArchiveHints {
    pub place_ids: Vec<String>,
    pub warnings: Vec<String>,
    pub queries_completed: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct ArchivePlace {
    place_id: String,
    timestamp: String,
}

fn numeric_id(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|id| *id > 0).map(|id| id.to_string())
}

fn places_from_original(original: &str, asset_id: &str) -> Vec<String> {
    if original.len() > 8192 {
        return Vec::new();
    }
    let Ok(url) = Url::parse(original) else {
        return Vec::new();
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Vec::new();
    }
    let host = url.host_str().unwrap_or_default();
    let path = url.path().trim_end_matches('/').to_ascii_lowercase();
    let query = url.query_pairs().collect::<Vec<_>>();
    let query_asset_ids = query
        .iter()
        .filter(|(key, _)| key.eq_ignore_ascii_case("id"))
        .map(|(_, value)| numeric_id(value))
        .collect::<Vec<_>>();
    let asset_matches = if host == "assetdelivery.roblox.com" {
        if matches!(path.as_str(), "/v1/asset" | "/v2/asset") {
            !query_asset_ids.is_empty()
                && query_asset_ids.iter().all(|id| id.as_deref() == Some(asset_id))
        } else {
            ["/v1/assetid/", "/v2/assetid/"].iter().any(|prefix| {
                path.strip_prefix(prefix).and_then(numeric_id).as_deref() == Some(asset_id)
            }) && query_asset_ids.iter().all(|id| id.as_deref() == Some(asset_id))
        }
    } else if matches!(host, "roblox.com" | "www.roblox.com") && path == "/asset" {
        !query_asset_ids.is_empty()
            && query_asset_ids.iter().all(|id| id.as_deref() == Some(asset_id))
    } else {
        false
    };
    if !asset_matches {
        return Vec::new();
    }
    let mut places = Vec::new();
    for (key, value) in query {
        if key.eq_ignore_ascii_case("placeid") || key.eq_ignore_ascii_case("serverplaceid") {
            if let Some(id) = numeric_id(&value) {
                if !places.contains(&id) {
                    places.push(id);
                }
            }
        }
    }
    places
}

fn parse_cdx(bytes: &[u8], asset_id: &str) -> Result<Vec<ArchivePlace>, String> {
    let data: Value = serde_json::from_slice(bytes)
        .map_err(|_| "The archive service returned invalid JSON, not a search result.")?;
    let rows = data.as_array().ok_or("The archive service returned an invalid result table.")?;
    let Some(header) = rows.first() else {
        return Ok(Vec::new());
    };
    let header = header.as_array().ok_or("The archive result has no field header.")?;
    let column = |name: &str| {
        header
            .iter()
            .position(|field| field.as_str() == Some(name))
            .ok_or_else(|| format!("The archive result is missing its {name} field."))
    };
    let original = column("original")?;
    let timestamp = column("timestamp")?;
    let status = column("statuscode")?;
    let mut places = Vec::new();
    for row in rows.iter().skip(1).take(400) {
        let Some(row) = row.as_array() else {
            continue;
        };
        if row.get(status).and_then(Value::as_str) != Some("200") {
            continue;
        }
        let Some(original) = row.get(original).and_then(Value::as_str) else {
            continue;
        };
        let Some(timestamp) = row.get(timestamp).and_then(Value::as_str) else {
            continue;
        };
        if timestamp.len() != 14 || !timestamp.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        for place_id in places_from_original(original, asset_id) {
            places.push(ArchivePlace { place_id, timestamp: timestamp.to_string() });
        }
    }
    Ok(places)
}

fn encoded_component_pattern(value: &str) -> String {
    value
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphabetic() {
                format!(
                    "(?:{}|%{:02x}|%{:02x})",
                    char::from(byte),
                    byte.to_ascii_lowercase(),
                    byte.to_ascii_uppercase(),
                )
            } else {
                format!("(?:{}|%{byte:02x})", char::from(byte))
            }
        })
        .collect()
}

fn cdx_queries(endpoint: &str, asset_id: &str) -> Result<Vec<Url>, String> {
    let asset_id = numeric_id(asset_id).ok_or("Invalid asset ID for archive recovery.")?;
    let scopes = [
        format!("https://assetdelivery.roblox.com/v1/asset/?id={asset_id}"),
        format!("https://assetdelivery.roblox.com/v1/asset?id={asset_id}"),
        format!("https://www.roblox.com/asset/?id={asset_id}"),
        format!("https://assetdelivery.roblox.com/v2/asset?id={asset_id}"),
        "https://assetdelivery.roblox.com/v1/asset".to_string(),
        "https://assetdelivery.roblox.com/v2/asset".to_string(),
    ];
    let id_pattern = format!("(?:0|%30)*{}", encoded_component_pattern(&asset_id));
    let id_key = encoded_component_pattern("id");
    let filter = format!(
        "original:(?i)^https?://(?:assetdelivery\\.roblox\\.com/v[12]/asset(?:/?\\?(?:[^#]*&)?{id_key}={id_pattern}(?:&[^#]*)?|id/{id_pattern}/?(?:\\?[^#]*)?)|(?:www\\.)?roblox\\.com/asset/?\\?(?:[^#]*&)?{id_key}={id_pattern}(?:&[^#]*)?)$"
    );
    let place_filter = format!(
        "original:(?i).*[?&](?:{}|{})=(?:[0-9]|%3[0-9])+(?:[&#].*)?$",
        encoded_component_pattern("placeid"),
        encoded_component_pattern("serverplaceid"),
    );
    scopes
        .into_iter()
        .map(|scope| {
            let mut url = Url::parse(endpoint).map_err(|_| "Invalid archive endpoint.")?;
            url.query_pairs_mut()
                .append_pair("url", &scope)
                .append_pair("matchType", "prefix")
                .append_pair("output", "json")
                .append_pair("fl", "timestamp,original,statuscode")
                .append_pair("filter", "statuscode:200")
                .append_pair("filter", &filter)
                .append_pair("filter", &place_filter)
                .append_pair("collapse", "urlkey")
                .append_pair("limit", "400");
            Ok(url)
        })
        .collect()
}

enum QueryError {
    RateLimited(Duration),
    Http(u16),
    Response(String),
}

impl QueryError {
    fn message(&self) -> String {
        match self {
            Self::RateLimited(_) => {
                "Archive service rate limited the search (HTTP 429). Try again later.".into()
            }
            Self::Http(status) => {
                format!("Archive service could not complete the search (HTTP {status}).")
            }
            Self::Response(message) => message.clone(),
        }
    }
}

async fn fetch_cdx(
    client: &Client,
    url: Url,
    asset_id: &str,
    max_bytes: usize,
) -> Result<Vec<ArchivePlace>, QueryError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| QueryError::Response("Could not contact the archive service.".into()))?;
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        let seconds = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30);
        return Err(QueryError::RateLimited(Duration::from_secs(seconds.min(120))));
    }
    if !response.status().is_success() {
        return Err(QueryError::Http(response.status().as_u16()));
    }
    if response.content_length().is_some_and(|length| length > max_bytes as u64) {
        return Err(QueryError::Response(
            "Archive response exceeded the search size limit.".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| {
        QueryError::Response("Archive response ended before it could be read.".into())
    })? {
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            return Err(QueryError::Response(
                "Archive response exceeded the search size limit.".into(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    parse_cdx(&body, asset_id).map_err(QueryError::Response)
}

async fn lookup_with_exclusions(
    client: &Client,
    endpoint: &str,
    asset_id: &str,
    limit: usize,
    limits: LookupLimits,
    gate: &ArchiveGate,
    excluded_place_ids: &[String],
) -> Result<ArchiveHints, String> {
    let asset_id = numeric_id(asset_id).ok_or("Invalid asset ID for archive recovery.")?;
    let queries = cdx_queries(endpoint, &asset_id)?;
    let excluded: HashSet<String> =
        excluded_place_ids.iter().filter_map(|id| numeric_id(id)).collect();
    gate.available()?;
    let _permit = tokio::time::timeout(limits.queue_timeout, gate.permits.acquire())
        .await
        .map_err(|_| {
            "Archive recovery is busy. Try this asset again after the other recoveries finish."
        })?
        .map_err(|_| "Archive recovery is unavailable.")?;
    gate.available()?;
    let deadline = Instant::now() + limits.total_timeout;
    let mut hints =
        ArchiveHints { place_ids: Vec::new(), warnings: Vec::new(), queries_completed: 0 };
    let mut candidates = HashMap::<String, String>::new();
    for query in queries {
        if let Err(error) = gate.available() {
            hints.warnings.push(error);
            break;
        }
        if Instant::now() >= deadline {
            hints.warnings.push(
                "Archive lookup reached its time limit before all searches completed.".into(),
            );
            break;
        }
        let request_deadline = deadline.min(Instant::now() + limits.request_timeout);
        match tokio::time::timeout_at(
            request_deadline,
            fetch_cdx(client, query, &asset_id, limits.response_bytes),
        )
        .await
        {
            Ok(Ok(places)) => {
                hints.queries_completed += 1;
                for place in places {
                    if excluded.contains(&place.place_id) {
                        continue;
                    }
                    candidates
                        .entry(place.place_id)
                        .and_modify(|timestamp| {
                            if *timestamp < place.timestamp {
                                *timestamp = place.timestamp.clone();
                            }
                        })
                        .or_insert(place.timestamp);
                }
            }
            Ok(Err(error)) => {
                hints.warnings.push(error.message());
                if let QueryError::RateLimited(duration) = error {
                    gate.rate_limited(duration);
                    break;
                }
                if matches!(error, QueryError::Http(401 | 403)) {
                    break;
                }
            }
            Err(_) => {
                hints.warnings.push("Archive search timed out; its result is unknown.".into())
            }
        }
        if candidates.len() >= limit.clamp(1, MAX_PLACES) {
            break;
        }
    }
    let mut candidates = candidates.into_iter().collect::<Vec<_>>();
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    hints.place_ids =
        candidates.into_iter().take(limit.clamp(1, MAX_PLACES)).map(|(id, _)| id).collect();
    hints.warnings.sort();
    hints.warnings.dedup();
    if hints.place_ids.is_empty() && !hints.warnings.is_empty() {
        return Err(format!("Archive lookup was incomplete. {}", hints.warnings.join(" ")));
    }
    Ok(hints)
}

pub(super) async fn discover_place_ids(
    asset_id: &str,
    limit: usize,
    excluded_place_ids: &[String],
) -> Result<ArchiveHints, String> {
    static GATE: OnceLock<ArchiveGate> = OnceLock::new();
    let mut builder = Client::builder()
        .user_agent("TrapSpoofer/asset-recovery")
        .connect_timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = crate::utils::effective_reqwest_proxy() {
        builder = builder.proxy(proxy);
    }
    let client = builder.build().map_err(|_| "Could not initialize archive recovery.")?;
    lookup_with_exclusions(
        &client,
        CDX_ENDPOINT,
        asset_id,
        limit,
        LookupLimits::default(),
        GATE.get_or_init(ArchiveGate::default),
        excluded_place_ids,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{RawQuery, State};
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::{routing::get, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    async fn lookup(
        client: &Client,
        endpoint: &str,
        asset_id: &str,
        limit: usize,
        limits: LookupLimits,
        gate: &ArchiveGate,
    ) -> Result<ArchiveHints, String> {
        lookup_with_exclusions(client, endpoint, asset_id, limit, limits, gate, &[]).await
    }

    #[test]
    fn queries_use_documented_scope_and_an_exact_asset_filter() {
        let queries = cdx_queries(CDX_ENDPOINT, "12345").expect("queries");
        assert_eq!(queries.len(), 6);
        for url in &queries {
            let query = url.query_pairs().collect::<Vec<_>>();
            assert!(query.iter().any(|(key, value)| key == "matchType" && value == "prefix"));
            let scope = query.iter().find(|(key, _)| key == "url").expect("scope").1.clone();
            assert!(!scope.contains('*'));
            assert!(!scope.contains("/games/"));
            let filter = query
                .iter()
                .find_map(|(key, value)| {
                    (key == "filter").then(|| value.strip_prefix("original:")).flatten()
                })
                .expect("asset filter");
            let pattern = regex::Regex::new(filter).expect("valid regex");
            assert!(
                pattern.is_match("https://assetdelivery.roblox.com/v1/asset/?id=12345&placeId=888")
            );
            assert!(pattern
                .is_match("https://assetdelivery.roblox.com/v1/asset?serverplaceid=888&id=12345"));
            assert!(
                pattern.is_match("https://assetdelivery.roblox.com/v2/assetId/12345?placeId=888")
            );
            assert!(!pattern
                .is_match("https://assetdelivery.roblox.com/v1/asset?id=123456&placeId=888"));
            assert!(!pattern.is_match("https://roblox.com/games/888?assetId=12345"));
        }
        let first = queries[0].query_pairs().find(|(key, _)| key == "url").expect("encoded URL").1;
        assert_eq!(first, "https://assetdelivery.roblox.com/v1/asset/?id=12345");
        assert!(cdx_queries(CDX_ENDPOINT, "12345&other=1").is_err());
    }

    #[test]
    fn parses_exact_asset_urls_with_case_encoding_and_parameter_order() {
        assert_eq!(
            places_from_original("https://assetdelivery.roblox.com/V1/Asset?ServerPlaceID=00777&ID=12345&placeId=%38%38%38&placeId=888", "12345"),
            ["777", "888"],
        );
        assert_eq!(
            places_from_original("http://www.roblox.com/asset/?placeId=777&id=12345", "12345"),
            ["777"],
        );
        assert_eq!(
            places_from_original(
                "https://assetdelivery.roblox.com/v2/assetId/12345?serverplaceid=777",
                "12345"
            ),
            ["777"],
        );
    }

    #[test]
    fn rejects_unrelated_ambiguous_and_invalid_archive_hints() {
        for url in [
            "https://roblox.com/games/777?assetId=12345&placeId=777",
            "https://assetdelivery.roblox.com.example.org/v1/asset?id=12345&placeId=777",
            "https://other.example/v1/asset?id=12345&placeId=777",
            "https://user:password@assetdelivery.roblox.com/v1/asset?id=12345&placeId=777",
            "https://assetdelivery.roblox.com/v1/asset?id=123456&placeId=777",
            "https://assetdelivery.roblox.com/v1/asset?id=12345&id=54321&placeId=777",
            "https://assetdelivery.roblox.com/v1/assetId/12345?id=54321&placeId=777",
            "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=0&serverplaceid=-1",
            "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=18446744073709551616",
            "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=777x",
        ] {
            assert!(places_from_original(url, "12345").is_empty(), "{url}");
        }
    }

    #[test]
    fn parses_cdx_headers_and_rejects_error_pages_and_bad_rows() {
        let table = json!([
            ["statuscode", "original", "timestamp"],
            [
                "200",
                "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=777",
                "20260101000000"
            ],
            [
                "403",
                "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=888",
                "20260101000000"
            ],
            [
                "200",
                "https://assetdelivery.roblox.com/v1/asset?id=99999&placeId=999",
                "20260101000000"
            ],
            ["200"],
            null
        ]);
        assert_eq!(
            parse_cdx(table.to_string().as_bytes(), "12345").expect("CDX"),
            [ArchivePlace { place_id: "777".into(), timestamp: "20260101000000".into() }]
        );
        assert!(parse_cdx(b"[]", "12345").expect("empty search").is_empty());
        assert!(parse_cdx(b"<html>Service unavailable</html>", "12345").is_err());
        assert!(parse_cdx(b"{\"error\":\"denied\"}", "12345").is_err());
        assert!(parse_cdx(b"[[\"original\"]]", "12345").is_err());
    }

    #[derive(Clone)]
    struct Reply {
        status: StatusCode,
        body: String,
        delay: Duration,
        chunked: bool,
    }

    impl Reply {
        fn json(body: Value) -> Self {
            Self {
                status: StatusCode::OK,
                body: body.to_string(),
                delay: Duration::ZERO,
                chunked: false,
            }
        }
    }

    struct ServerState {
        replies: Vec<Reply>,
        requests: Mutex<Vec<(String, HeaderMap)>>,
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    struct Server {
        endpoint: String,
        state: Arc<ServerState>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn mock_cdx(
        State(state): State<Arc<ServerState>>,
        RawQuery(query): RawQuery,
        headers: HeaderMap,
    ) -> axum::response::Response {
        let query = query.unwrap_or_default();
        let index = {
            let mut requests = state.requests.lock().expect("requests");
            let index = requests.len();
            requests.push((query.clone(), headers));
            index
        };
        let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
        state.peak.fetch_max(active, Ordering::SeqCst);
        let mut reply = state.replies[index.min(state.replies.len() - 1)].clone();
        let request_url =
            Url::parse(&format!("http://localhost/cdx?{query}")).expect("request URL");
        let filters = request_url
            .query_pairs()
            .filter(|(key, _)| key == "filter")
            .filter_map(|(_, value)| value.strip_prefix("original:").map(str::to_string))
            .map(|pattern| regex::Regex::new(&pattern).expect("CDX regex filter"))
            .collect::<Vec<_>>();
        if let Ok(rows) = serde_json::from_str::<Vec<Vec<String>>>(&reply.body) {
            if let Some(original_index) =
                rows.first().and_then(|header| header.iter().position(|field| field == "original"))
            {
                let filtered = rows
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, row)| {
                        (index == 0
                            || row.get(original_index).is_some_and(|url| {
                                filters.iter().all(|filter| filter.is_match(url))
                            }))
                        .then_some(row)
                    })
                    .collect::<Vec<_>>();
                reply.body = serde_json::to_string(&filtered).expect("filtered CDX rows");
            }
        }
        tokio::time::sleep(reply.delay).await;
        state.active.fetch_sub(1, Ordering::SeqCst);
        let mut response = if reply.chunked {
            let chunks = [Ok::<_, std::io::Error>(reply.body)];
            (reply.status, axum::body::Body::from_stream(futures::stream::iter(chunks)))
                .into_response()
        } else {
            (reply.status, reply.body).into_response()
        };
        if reply.status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(reqwest::header::RETRY_AFTER, "30".parse().expect("header"));
        }
        response
    }

    async fn server(replies: Vec<Reply>) -> Server {
        let state = Arc::new(ServerState {
            replies,
            requests: Mutex::new(Vec::new()),
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        });
        let router = Router::new().route("/cdx", get(mock_cdx)).with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("test listener");
        let address = listener.local_addr().expect("listener address");
        let task =
            tokio::spawn(async move { axum::serve(listener, router).await.expect("test server") });
        Server { endpoint: format!("http://{address}/cdx"), state, task }
    }

    fn client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client")
    }

    fn valid_table() -> Value {
        json!([
            ["timestamp", "original", "statuscode"],
            [
                "20230101000000",
                "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=777",
                "200"
            ],
            [
                "20260101000000",
                "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=888",
                "200"
            ],
            [
                "20240101000000",
                "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=777",
                "200"
            ]
        ])
    }

    #[tokio::test]
    async fn http_lookup_encodes_queries_validates_candidates_and_sorts_fresh_hints() {
        let server = server(vec![Reply::json(json!([])), Reply::json(valid_table())]).await;
        let result = lookup(
            &client(),
            &server.endpoint,
            "12345",
            2,
            LookupLimits::default(),
            &ArchiveGate::default(),
        )
        .await
        .expect("lookup");
        assert_eq!(result.place_ids, ["888", "777"]);
        assert_eq!(result.queries_completed, 2);
        assert!(result.warnings.is_empty());
        let requests = server.state.requests.lock().expect("requests");
        assert_eq!(requests.len(), 2);
        for (query, headers) in requests.iter() {
            assert!(!headers.contains_key(reqwest::header::COOKIE));
            assert!(!headers.contains_key(reqwest::header::AUTHORIZATION));
            let parsed = Url::parse(&format!("http://localhost/cdx?{query}")).expect("request URL");
            let values = parsed.query_pairs().collect::<Vec<_>>();
            assert_eq!(values.iter().filter(|(key, _)| key == "filter").count(), 3);
            assert!(values.iter().any(|(key, value)| key == "url" && value.ends_with("id=12345")));
            assert!(values.iter().any(|(key, value)| key == "limit" && value == "400"));
        }
    }

    #[tokio::test]
    async fn empty_http_search_is_distinct_from_denied_broken_and_unavailable_service() {
        let empty = server(vec![Reply::json(json!([]))]).await;
        let result = lookup(
            &client(),
            &empty.endpoint,
            "12345",
            20,
            LookupLimits::default(),
            &ArchiveGate::default(),
        )
        .await
        .expect("empty search");
        assert!(result.place_ids.is_empty());
        assert!(result.warnings.is_empty());
        assert_eq!(result.queries_completed, 6);
        for (status, body, expected) in [
            (StatusCode::FORBIDDEN, "denied", "HTTP 403"),
            (StatusCode::SERVICE_UNAVAILABLE, "unavailable", "HTTP 503"),
            (StatusCode::OK, "<html>Error</html>", "invalid JSON"),
        ] {
            let mut reply = Reply::json(json!([]));
            reply.status = status;
            reply.body = body.into();
            let failure = server(vec![reply]).await;
            let error = lookup(
                &client(),
                &failure.endpoint,
                "12345",
                20,
                LookupLimits::default(),
                &ArchiveGate::default(),
            )
            .await
            .expect_err("service failure");
            assert!(error.contains(expected), "{error}");
            assert!(failure.state.requests.lock().expect("requests").len() <= 6);
        }
    }

    #[tokio::test]
    async fn keeps_verified_hints_when_a_later_search_fails() {
        let mut unavailable = Reply::json(json!([]));
        unavailable.status = StatusCode::SERVICE_UNAVAILABLE;
        let server = server(vec![Reply::json(valid_table()), unavailable]).await;
        let result = lookup(
            &client(),
            &server.endpoint,
            "12345",
            20,
            LookupLimits::default(),
            &ArchiveGate::default(),
        )
        .await
        .expect("partial search");
        assert_eq!(result.place_ids, ["888", "777"]);
        assert_eq!(result.queries_completed, 1);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("503"));
    }

    #[tokio::test]
    async fn rate_limit_stops_fanout_and_allows_a_later_attempt() {
        let mut limited = Reply::json(json!([]));
        limited.status = StatusCode::TOO_MANY_REQUESTS;
        let server = server(vec![limited, Reply::json(valid_table())]).await;
        let gate = ArchiveGate::default();
        let client = client();
        let error = lookup(&client, &server.endpoint, "12345", 1, LookupLimits::default(), &gate)
            .await
            .expect_err("rate limit");
        assert!(error.contains("429"));
        assert!(lookup(&client, &server.endpoint, "12345", 1, LookupLimits::default(), &gate)
            .await
            .is_err());
        assert_eq!(server.state.requests.lock().expect("requests").len(), 1);
        *gate.cooldown.lock().expect("cooldown") = Some(Instant::now());
        let result = lookup(&client, &server.endpoint, "12345", 1, LookupLimits::default(), &gate)
            .await
            .expect("retry after cooldown");
        assert_eq!(result.place_ids, ["888"]);
        assert_eq!(server.state.requests.lock().expect("requests").len(), 2);
    }

    #[tokio::test]
    async fn limits_response_bytes_for_sized_and_chunked_http_bodies() {
        for chunked in [false, true] {
            let mut reply = Reply::json(valid_table());
            reply.chunked = chunked;
            let server = server(vec![reply]).await;
            let limits = LookupLimits { response_bytes: 16, ..LookupLimits::default() };
            let error =
                lookup(&client(), &server.endpoint, "12345", 20, limits, &ArchiveGate::default())
                    .await
                    .expect_err("oversized body");
            assert!(error.contains("size limit"), "{error}");
        }
    }

    #[tokio::test]
    async fn total_deadline_bounds_slow_requests_and_releases_capacity() {
        let mut slow = Reply::json(valid_table());
        slow.delay = Duration::from_millis(100);
        let server = server(vec![slow]).await;
        let limits = LookupLimits {
            total_timeout: Duration::from_millis(30),
            request_timeout: Duration::from_secs(1),
            ..LookupLimits::default()
        };
        let gate = ArchiveGate::default();
        let started = Instant::now();
        let error = lookup(&client(), &server.endpoint, "12345", 20, limits, &gate)
            .await
            .expect_err("timeout");
        assert!(error.contains("timed out"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(gate.permits.available_permits(), 2);
        assert_eq!(server.state.requests.lock().expect("requests").len(), 1);
    }

    #[tokio::test]
    async fn semaphore_wait_is_bounded_and_never_sends_a_request_after_expiry() {
        let server = server(vec![Reply::json(valid_table())]).await;
        let gate = ArchiveGate::default();
        let permits = gate.permits.acquire_many(2).await.expect("hold capacity");
        let limits =
            LookupLimits { queue_timeout: Duration::from_millis(15), ..LookupLimits::default() };
        let error = lookup(&client(), &server.endpoint, "12345", 1, limits, &gate)
            .await
            .expect_err("busy timeout");
        assert!(error.contains("busy"));
        assert!(server.state.requests.lock().expect("requests").is_empty());
        drop(permits);
        let result =
            lookup(&client(), &server.endpoint, "12345", 1, LookupLimits::default(), &gate)
                .await
                .expect("capacity restored");
        assert_eq!(result.place_ids, ["888"]);
    }

    #[tokio::test]
    async fn concurrent_lookups_share_two_network_slots() {
        let mut reply = Reply::json(valid_table());
        reply.delay = Duration::from_millis(20);
        let server = server(vec![reply]).await;
        let gate = ArchiveGate::default();
        let client = client();
        let lookup_one =
            || lookup(&client, &server.endpoint, "12345", 1, LookupLimits::default(), &gate);
        let results = tokio::join!(lookup_one(), lookup_one(), lookup_one());
        assert!(results.0.is_ok() && results.1.is_ok() && results.2.is_ok());
        assert_eq!(server.state.requests.lock().expect("requests").len(), 3);
        assert_eq!(server.state.peak.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn http_filters_preserve_encoded_keys_values_and_zero_padded_ids() {
        let server = server(vec![Reply::json(json!([
            ["timestamp", "original", "statuscode"],
            ["20260101000000", "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=%38%38%38", "200"],
            ["20260101000000", "https://assetdelivery.roblox.com/v1/asset?%49%44=%30%31%32%33%34%35&%70lace%49d=%37%37%37", "200"],
            ["20260101000000", "https://assetdelivery.roblox.com/v1/asset?id=0012345&serverplaceid=999", "200"],
            ["20260101000000", "https://assetdelivery.roblox.com/v1/asset?id=123456&placeId=666", "200"]
        ]))]).await;
        let result = lookup(
            &client(),
            &server.endpoint,
            "12345",
            20,
            LookupLimits::default(),
            &ArchiveGate::default(),
        )
        .await
        .expect("encoded archive hints");
        assert_eq!(result.place_ids, ["777", "888", "999"]);
        assert!(result.warnings.is_empty());
    }

    #[tokio::test]
    async fn excludes_known_hints_before_the_cap_and_keeps_searching_for_fresh_places() {
        let excluded = (1..=20).map(|id| id.to_string()).collect::<Vec<_>>();
        let mut rows = vec![json!(["timestamp", "original", "statuscode"])];
        for id in &excluded {
            rows.push(json!([
                "20260101000000",
                format!("https://assetdelivery.roblox.com/v1/asset?id=12345&placeId={id}"),
                "200"
            ]));
        }
        rows.push(json!([
            "20200101000000",
            "https://assetdelivery.roblox.com/v1/asset?id=12345&placeId=777",
            "200"
        ]));
        let server =
            server(vec![Reply::json(Value::Array(rows)), Reply::json(valid_table())]).await;
        let result = lookup_with_exclusions(
            &client(),
            &server.endpoint,
            "12345",
            2,
            LookupLimits::default(),
            &ArchiveGate::default(),
            &excluded,
        )
        .await
        .expect("fresh archive hints");
        assert_eq!(result.place_ids, ["888", "777"]);
        assert_eq!(result.queries_completed, 2);
        assert_eq!(server.state.requests.lock().expect("requests").len(), 2);
    }
}
