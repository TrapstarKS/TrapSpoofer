use reqwest::{RequestBuilder, Response};

pub(super) enum UploadAuth {
    ApiKey(String),
    Cookie { header: String, csrf: String },
}

impl UploadAuth {
    pub fn new(api_key: Option<&str>, cookie: &str, csrf: &str) -> Result<Self, String> {
        if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
            return Ok(Self::ApiKey(key.to_string()));
        }
        let header = crate::utils::build_roblox_cookie_header(cookie);
        if header.is_empty() {
            return Err(
                "Sign in to Roblox or provide an Open Cloud API key before uploading.".into()
            );
        }
        Ok(Self::Cookie { header, csrf: csrf.to_string() })
    }

    const fn prefix(&self) -> &'static str {
        match self {
            Self::ApiKey(_) => "https://apis.roblox.com/assets/v1/",
            Self::Cookie { .. } => "https://apis.roblox.com/assets/user-auth/v1/",
        }
    }

    pub fn upload_url(&self) -> String {
        format!("{}assets", self.prefix())
    }

    pub const fn label(&self) -> &'static str {
        match self {
            Self::ApiKey(_) => "Open Cloud API key",
            Self::Cookie { .. } => "Roblox session (no API key)",
        }
    }

    pub fn operation_url(&self, path: &str) -> Result<String, String> {
        let path = path.trim_start_matches('/');
        let path = path
            .strip_prefix("assets/user-auth/v1/")
            .or_else(|| path.strip_prefix("assets/v1/"))
            .unwrap_or(path);
        let Some(operation_id) = path.strip_prefix("operations/") else {
            return Err("Roblox returned an invalid upload operation path.".into());
        };
        if operation_id.is_empty()
            || operation_id.len() > 256
            || !operation_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return Err("Roblox returned an invalid upload operation ID.".into());
        }
        Ok(format!("{}{path}", self.prefix()))
    }

    pub fn apply(&self, builder: RequestBuilder) -> RequestBuilder {
        match self {
            Self::ApiKey(key) => builder.header("x-api-key", key),
            Self::Cookie { header, csrf } => {
                let builder = builder
                    .header(reqwest::header::COOKIE, header)
                    .header(reqwest::header::ORIGIN, "https://create.roblox.com")
                    .header(reqwest::header::REFERER, "https://create.roblox.com/")
                    .header(reqwest::header::USER_AGENT, "RobloxStudio/WinInet");
                if csrf.is_empty() {
                    builder
                } else {
                    builder.header("x-csrf-token", csrf)
                }
            }
        }
    }

    pub fn refresh_csrf(&mut self, response: &Response) -> bool {
        if response.status() != reqwest::StatusCode::FORBIDDEN {
            return false;
        }
        let Self::Cookie { csrf, .. } = self else {
            return false;
        };
        let Some(token) =
            response.headers().get("x-csrf-token").and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        if token.is_empty() || token == csrf {
            return false;
        }
        *csrf = token.to_string();
        true
    }

    pub fn authorization_error(&self, status: u16) -> String {
        match self {
            Self::ApiKey(_) => format!("Upload authorization failed (HTTP {status}). Choose Roblox session in upload authentication to continue without a key, or check the saved API key, asset write permission and creator access."),
            Self::Cookie { .. } if status == 401 => "Your Roblox session expired. Sign in again before uploading.".into(),
            Self::Cookie { .. } => "Roblox denied this upload. The signed-in account needs permission to create assets for the selected user or group.".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_keys_use_session_auth_for_upload_and_polling() {
        for api_key in [None, Some(""), Some("   ")] {
            let auth = UploadAuth::new(api_key, "synthetic-session", "csrf").expect("session");
            assert!(matches!(auth, UploadAuth::Cookie { .. }));
            let request = auth
                .apply(
                    reqwest::Client::new()
                        .get(auth.operation_url("operations/test-1").expect("path")),
                )
                .build()
                .expect("request");
            assert!(!request.headers().contains_key("x-api-key"));
            assert_eq!(request.headers()["x-csrf-token"], "csrf");
            assert_eq!(request.url().path(), "/assets/user-auth/v1/operations/test-1");
        }
        assert!(UploadAuth::new(None, "", "").is_err());
    }

    #[test]
    fn csrf_refresh_requires_a_new_token_from_a_forbidden_response() {
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .status(403)
                .header("x-csrf-token", "refreshed")
                .body("")
                .expect("response"),
        );
        let mut auth = UploadAuth::new(None, "synthetic-session", "old").expect("session");
        assert!(auth.refresh_csrf(&response));
        assert!(!auth.refresh_csrf(&response));
        let request =
            auth.apply(reqwest::Client::new().post(auth.upload_url())).build().expect("request");
        assert_eq!(request.headers()["x-csrf-token"], "refreshed");
        let mut key = UploadAuth::new(Some("synthetic-key"), "", "").expect("key");
        assert!(!key.refresh_csrf(&response));
    }

    #[test]
    fn keeps_cookie_and_key_credentials_separate() {
        let client = reqwest::Client::new();
        let key = UploadAuth::new(Some("key"), "", "").expect("key");
        let request = key.apply(client.post(key.upload_url())).build().expect("request");
        assert_eq!(request.headers()["x-api-key"], "key");
        assert!(!request.headers().contains_key("cookie"));
        let cookie =
            UploadAuth::Cookie { header: ".ROBLOSECURITY=test".into(), csrf: "csrf".into() };
        let request = cookie.apply(client.post(cookie.upload_url())).build().expect("request");
        assert_eq!(request.headers()["cookie"], ".ROBLOSECURITY=test");
        assert_eq!(request.headers()["x-csrf-token"], "csrf");
        assert!(!request.headers().contains_key("x-api-key"));
        assert_eq!(request.url().path(), "/assets/user-auth/v1/assets");
    }

    #[test]
    fn polls_the_same_authentication_endpoint_and_rejects_redirected_paths() {
        let cookie = UploadAuth::Cookie { header: "test".into(), csrf: String::new() };
        for path in [
            "operations/abc-123",
            "assets/v1/operations/abc-123",
            "/assets/user-auth/v1/operations/abc-123",
        ] {
            assert_eq!(
                cookie.operation_url(path).expect("operation"),
                "https://apis.roblox.com/assets/user-auth/v1/operations/abc-123"
            );
        }
        for path in [
            "https://example.com/operations/1",
            "operations/../../assets",
            "operations/1?target=evil",
            "operations/",
        ] {
            assert!(cookie.operation_url(path).is_err());
        }
    }
}
