#![allow(clippy::cast_possible_truncation)]
#[cfg(target_os = "windows")]
use aes_gcm::aead::{Aead, KeyInit};
#[cfg(target_os = "windows")]
use aes_gcm::{Aes256Gcm, Key, Nonce};
#[cfg(target_os = "windows")]
use base64::engine::general_purpose::STANDARD;
#[cfg(target_os = "windows")]
use base64::Engine;
use keyring::Entry;
use regex::Regex;
use rusqlite::Connection;
#[cfg(not(target_os = "windows"))]
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::LocalFree;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Security::Cryptography::{
    CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

#[cfg(not(target_os = "windows"))]
pub const BROWSER_COOKIE_SCAN_BYTES: u64 = 25 * 1024 * 1024;

pub const PROFILE_COOKIE_SERVICE: &str = "TrapSpoofer.RobloxProfileCookie";

fn roblosecurity_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)_\|WARNING:-DO-NOT-SHARE-THIS\.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items\.\|_[^\s"';,\x00-\x1f\x7f]+"#)
            .expect("Failed to compile ROBLOSECURITY regex")
    })
}

#[must_use]
pub fn extract_roblox_cookie(raw_value: &str) -> Option<String> {
    roblosecurity_regex().find(raw_value).map(|m| m.as_str().to_string())
}

#[cfg(not(target_os = "windows"))]
fn read_possible_cookie_file(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file.take(BROWSER_COOKIE_SCAN_BYTES));
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    extract_roblox_cookie(&text)
}

#[cfg(not(target_os = "windows"))]
fn browser_cookie_file_candidates() -> Vec<PathBuf> {
    let home_os = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let home = match home_os {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };
    let mut candidates = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let app_support = home.join("Library").join("Application Support");
        let chromium_roots = [
            app_support.join("Google").join("Chrome"),
            app_support.join("Chromium"),
            app_support.join("Microsoft Edge"),
            app_support.join("BraveSoftware").join("Brave-Browser"),
            app_support.join("com.operasoftware.Opera"),
        ];

        let profiles = ["Default", "Profile 1", "Profile 2", "Profile 3"];

        for root in chromium_roots {
            for profile in profiles {
                candidates.push(root.join(profile).join("Network").join("Cookies"));
                candidates.push(root.join(profile).join("Cookies"));
            }
        }

        let firefox_profiles = app_support.join("Firefox").join("Profiles");
        if let Ok(entries) = std::fs::read_dir(firefox_profiles) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    candidates.push(path.join("cookies.sqlite"));
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let chromium_roots = [
            config.join("google-chrome"),
            config.join("chromium"),
            config.join("microsoft-edge"),
            config.join("BraveSoftware").join("Brave-Browser"),
            config.join("opera"),
        ];
        let profiles = ["Default", "Profile 1", "Profile 2", "Profile 3"];

        for root in chromium_roots {
            for profile in profiles {
                candidates.push(root.join(profile).join("Network").join("Cookies"));
                candidates.push(root.join(profile).join("Cookies"));
            }
        }

        let firefox_profiles = home.join(".mozilla").join("firefox");
        if let Ok(entries) = std::fs::read_dir(firefox_profiles) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    candidates.push(path.join("cookies.sqlite"));
                }
            }
        }
    }

    candidates
}

#[cfg(target_os = "windows")]
#[derive(Clone)]
struct ChromiumCookieCandidate {
    cookies_path: PathBuf,
    local_state_path: PathBuf,
}

#[cfg(target_os = "windows")]
fn chromium_cookie_candidates() -> Vec<ChromiumCookieCandidate> {
    let home_os = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let home = match home_os {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };
    let local = std::env::var_os("LOCALAPPDATA")
        .map_or_else(|| home.join("AppData").join("Local"), PathBuf::from);
    let roaming = std::env::var_os("APPDATA")
        .map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from);

    let roots = [
        local.join("Google").join("Chrome").join("User Data"),
        local.join("Google").join("Chrome Beta").join("User Data"),
        local.join("Google").join("Chrome Canary").join("User Data"),
        local.join("Microsoft").join("Edge").join("User Data"),
        local.join("Microsoft").join("Edge Beta").join("User Data"),
        local.join("BraveSoftware").join("Brave-Browser").join("User Data"),
        local.join("BraveSoftware").join("Brave-Browser-Nightly").join("User Data"),
        local.join("Vivaldi").join("User Data"),
        local.join("Arc").join("User Data"),
        local.join("Yandex").join("YandexBrowser").join("User Data"),
        roaming.join("Opera Software").join("Opera Stable"),
        roaming.join("Opera Software").join("Opera GX Stable"),
        roaming.join("Opera Software").join("Opera Next"),
    ];

    let profile_names: Vec<String> = {
        let mut v = vec!["Default".to_string()];
        for i in 1..=20 {
            v.push(format!("Profile {i}"));
        }
        v
    };

    let mut candidates = Vec::new();
    for root in &roots {
        let local_state_path = root.join("Local State");
        if !local_state_path.is_file() {
            continue;
        }

        let mut profile_dirs = vec![root.clone()];

        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                if path.is_dir()
                    && (profile_names.iter().any(|p| p == &name) || name.starts_with("Profile"))
                    && !profile_dirs.contains(&path)
                {
                    profile_dirs.push(path);
                }
            }
        }

        for profile in profile_dirs {
            for cookies_path in [profile.join("Network").join("Cookies"), profile.join("Cookies")] {
                if cookies_path.is_file() {
                    candidates.push(ChromiumCookieCandidate {
                        cookies_path,
                        local_state_path: local_state_path.clone(),
                    });
                }
            }
        }
    }

    candidates
}

#[cfg(target_os = "windows")]
fn decrypt_dpapi(data: &[u8]) -> crate::error::Result<Vec<u8>> {
    unsafe {
        let in_blob =
            CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() };
        let mut out_blob = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        let ok = CryptUnprotectData(
            &in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        );
        if ok == 0 {
            return Err("Windows DPAPI cookie decrypt failed".into());
        }
        let decrypted =
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        LocalFree(out_blob.pbData.cast());
        Ok(decrypted)
    }
}

#[cfg(target_os = "windows")]
fn chromium_master_key(local_state_path: &Path) -> crate::error::Result<Vec<u8>> {
    let text = std::fs::read_to_string(local_state_path)?;
    let parsed: serde_json::Value = serde_json::from_str(&text)?;
    let encrypted_key = parsed
        .get("os_crypt")
        .and_then(|v| v.get("encrypted_key"))
        .and_then(|v| v.as_str())
        .ok_or("Chromium Local State does not contain an encrypted cookie key")?;
    let mut key_bytes = STANDARD
        .decode(encrypted_key)
        .map_err(|e| crate::error::AppError::Custom(format!("Invalid Chromium cookie key: {e}")))?;
    if key_bytes.starts_with(b"DPAPI") {
        key_bytes.drain(..5);
    }
    decrypt_dpapi(&key_bytes)
}

#[cfg(target_os = "windows")]
fn decrypt_chromium_cookie(encrypted_value: &[u8], master_key: &[u8]) -> Option<String> {
    if encrypted_value.is_empty() {
        return None;
    }

    if encrypted_value.starts_with(b"v20") {
        return None;
    }

    if encrypted_value.starts_with(b"v10") || encrypted_value.starts_with(b"v11") {
        if encrypted_value.len() <= 15 {
            return None;
        }
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(master_key));
        let nonce = Nonce::from_slice(&encrypted_value[3..15]);
        return cipher
            .decrypt(nonce, &encrypted_value[15..])
            .ok()
            .and_then(|p| String::from_utf8(p).ok());
    }

    decrypt_dpapi(encrypted_value).ok().and_then(|bytes| String::from_utf8(bytes).ok())
}

struct TempDb {
    dir: PathBuf,
    db: PathBuf,
}

impl Drop for TempDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn path_with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn private_temp_dir() -> Option<PathBuf> {
    for _ in 0..8 {
        let dir =
            std::env::temp_dir().join(format!("trapspoofer-cookie-{:016x}", rand::random::<u64>()));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                        .is_err()
                    {
                        let _ = std::fs::remove_dir(&dir);
                        continue;
                    }
                }
                return Some(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
    }
    None
}

fn copy_cookie_db(path: &Path) -> Option<TempDb> {
    let dir = private_temp_dir()?;
    let temp_db = dir.join("Cookies.sqlite");
    if std::fs::copy(path, &temp_db).is_err() {
        let _ = std::fs::remove_dir_all(&dir);
        return None;
    }

    for suffix in ["-wal", "-shm"] {
        let source = path_with_suffix(path, suffix);
        if source.is_file() {
            let destination = path_with_suffix(&temp_db, suffix);
            if std::fs::copy(&source, &destination).is_err() {
                let _ = std::fs::remove_dir_all(&dir);
                return None;
            }
        }
    }

    Some(TempDb { dir, db: temp_db })
}

#[cfg(target_os = "windows")]
fn read_chromium_cookie(candidate: &ChromiumCookieCandidate) -> Option<String> {
    let master_key = chromium_master_key(&candidate.local_state_path).ok()?;
    let temp_db = copy_cookie_db(&candidate.cookies_path)?;
    let conn = Connection::open(&temp_db.db).ok()?;
    let mut stmt = conn
        .prepare(
            "SELECT value, encrypted_value FROM cookies \
             WHERE host_key LIKE '%roblox.com' AND name = '.ROBLOSECURITY' \
             ORDER BY expires_utc DESC",
        )
        .ok()?;
    let rows = stmt
        .query_map([], |row| {
            let value: String = row.get(0)?;
            let encrypted_value: Vec<u8> = row.get(1)?;
            Ok((value, encrypted_value))
        })
        .ok()?;

    for row in rows.flatten() {
        let (value, encrypted_value) = row;
        if let Some(cookie) = extract_roblox_cookie(&value) {
            return Some(cookie);
        }
        if let Some(decrypted) = decrypt_chromium_cookie(&encrypted_value, &master_key) {
            if let Some(cookie) = extract_roblox_cookie(&decrypted) {
                return Some(cookie);
            }
        }
    }

    None
}

fn firefox_cookie_candidates() -> Vec<PathBuf> {
    let home_os = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    let home = match home_os {
        Some(h) => PathBuf::from(h),
        None => return Vec::new(),
    };
    let profiles = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map_or_else(|| home.join("AppData").join("Roaming"), PathBuf::from)
            .join("Mozilla")
            .join("Firefox")
            .join("Profiles")
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("Firefox").join("Profiles")
    } else {
        home.join(".mozilla").join("firefox")
    };
    let mut candidates = Vec::new();
    if let Ok(entries) = std::fs::read_dir(profiles) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                candidates.push(path.join("cookies.sqlite"));
            }
        }
    }
    candidates
}

fn read_firefox_cookie(path: &Path) -> Option<String> {
    let temp_db = copy_cookie_db(path)?;
    let conn = Connection::open(&temp_db.db).ok()?;
    let mut stmt = conn
        .prepare(
            "SELECT value FROM moz_cookies \
             WHERE host LIKE '%roblox.com' AND name = '.ROBLOSECURITY' \
             ORDER BY expiry DESC",
        )
        .ok()?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).ok()?;
    for value in rows.flatten() {
        if let Some(cookie) = extract_roblox_cookie(&value) {
            return Some(cookie);
        }
    }
    None
}

#[cfg(target_os = "windows")]
pub fn get_cookie_from_browser_profiles() -> Option<String> {
    chromium_cookie_candidates()
        .iter()
        .find_map(read_chromium_cookie)
        .or_else(|| firefox_cookie_candidates().iter().find_map(|path| read_firefox_cookie(path)))
}

#[cfg(not(target_os = "windows"))]
pub fn get_cookie_from_browser_profiles() -> Option<String> {
    firefox_cookie_candidates().iter().find_map(|path| read_firefox_cookie(path)).or_else(|| {
        browser_cookie_file_candidates().into_iter().find_map(|path| {
            if path.is_file() {
                read_possible_cookie_file(&path)
            } else {
                None
            }
        })
    })
}

pub fn get_cookie_from_roblox_studio_inner(
    user_id: Option<String>,
) -> crate::error::Result<Option<String>> {
    let requested = user_id.filter(|id| !id.trim().is_empty() && id != "none");
    if requested.as_ref().is_some_and(|id| !id.bytes().all(|byte| byte.is_ascii_digit())) {
        return Err("Invalid Roblox user ID.".into());
    }
    Ok(super::studio_cookies::read_studio_cookies()?
        .into_iter()
        .find(|session| requested.as_ref().map_or(true, |id| session.user_id.as_ref() == Some(id)))
        .map(|session| session.cookie))
}

pub fn profile_cookie_entry(user_id: &str) -> crate::error::Result<Entry> {
    let normalized_user_id = user_id.chars().filter(char::is_ascii_digit).collect::<String>();
    if normalized_user_id.is_empty() {
        return Err(crate::error::AppError::Custom("Missing Roblox user id".into()));
    }

    Entry::new(PROFILE_COOKIE_SERVICE, &normalized_user_id).map_err(|e| {
        crate::error::AppError::Custom(format!("Failed to open credential store: {e}"))
    })
}

#[cfg(test)]
mod tests {
    use super::extract_roblox_cookie;

    const SAMPLE: &str = "_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items.|_synthetic-token";

    #[test]
    fn stops_at_binary_cookie_record_terminator() {
        let raw = format!("binary-header\0{SAMPLE}\0next-cookie-record\u{7f}tail");
        assert_eq!(extract_roblox_cookie(&raw).as_deref(), Some(SAMPLE));
        assert_eq!(extract_roblox_cookie(&format!("{SAMPLE}\u{1}tail")).as_deref(), Some(SAMPLE));
    }

    #[test]
    fn accepts_text_cookie_and_rejects_unrelated_data() {
        assert_eq!(
            extract_roblox_cookie(&format!(".ROBLOSECURITY={SAMPLE}; Path=/")).as_deref(),
            Some(SAMPLE)
        );
        assert_eq!(extract_roblox_cookie("unrelated binary cookie record"), None);
    }
}
