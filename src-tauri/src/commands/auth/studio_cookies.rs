use super::cookies::extract_roblox_cookie;
use std::collections::HashSet;

pub(super) struct StudioCookie {
    pub cookie: String,
    pub user_id: Option<String>,
    pub is_current: bool,
}

struct StoredCookie {
    name: String,
    value: String,
}

const SESSION_PREFIX: &str = "/RobloxStudioAuth/.ROBLOSECURITY";
const CURRENT_USER: &str = "/RobloxStudioAuth/userid";
const MAX_SESSIONS: usize = 64;

fn user_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok().filter(|id| *id > 0).map(|id| id.to_string())
}

fn sessions_from_records(mut records: Vec<StoredCookie>) -> Vec<StudioCookie> {
    let current = records
        .iter()
        .find(|record| record.name == CURRENT_USER)
        .and_then(|record| user_id(&record.value));
    records.sort_by_key(|record| record.name == ".ROBLOSECURITY" || record.name == SESSION_PREFIX);
    let mut seen = HashSet::new();
    let mut sessions: Vec<_> = records
        .into_iter()
        .filter_map(|record| {
            let suffix = if record.name == ".ROBLOSECURITY" {
                ""
            } else {
                record.name.strip_prefix(SESSION_PREFIX)?
            };
            let owner = if suffix.is_empty() { None } else { Some(user_id(suffix)?) };
            let cookie = extract_roblox_cookie(&record.value)?;
            if cookie.len() > 16_384 || !seen.insert(cookie.clone()) {
                return None;
            }
            let is_current = if let Some(current) = &current {
                owner.as_ref() == Some(current)
            } else {
                suffix.is_empty()
            };
            Some(StudioCookie { cookie, user_id: owner, is_current })
        })
        .collect();
    sessions.sort_by_key(|session| !session.is_current);
    sessions.truncate(MAX_SESSIONS);
    sessions
}

#[cfg(any(target_os = "windows", test))]
fn credential_value(bytes: &[u8]) -> Option<String> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        let text = text.trim_end_matches('\0');
        if !text.contains('\0') {
            return Some(text.to_string());
        }
    }
    if bytes.len() % 2 != 0 {
        return None;
    }
    let wide: Vec<_> =
        bytes.chunks_exact(2).map(|part| u16::from_le_bytes([part[0], part[1]])).collect();
    String::from_utf16(&wide).ok().map(|text| text.trim_end_matches('\0').to_string())
}

#[cfg(any(target_os = "macos", test))]
fn read_u32(bytes: &[u8], offset: usize, big_endian: bool) -> Option<usize> {
    let raw: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    usize::try_from(if big_endian { u32::from_be_bytes(raw) } else { u32::from_le_bytes(raw) }).ok()
}

#[cfg(any(target_os = "macos", test))]
fn record_string(record: &[u8], field: usize) -> Option<String> {
    let offset = read_u32(record, field, false)?;
    if offset < 56 {
        return None;
    }
    let bytes = record.get(offset..)?;
    let end = bytes.iter().position(|byte| *byte == 0)?;
    if end > 16_384 {
        return None;
    }
    std::str::from_utf8(&bytes[..end]).ok().map(str::to_string)
}

#[cfg(any(target_os = "macos", test))]
fn parse_binary_cookies(bytes: &[u8]) -> Result<Vec<StoredCookie>, &'static str> {
    const INVALID: &str = "The Roblox Studio session store is incomplete or unsupported.";
    if bytes.get(..4) != Some(b"cook") {
        return Err(INVALID);
    }
    let page_count = read_u32(bytes, 4, true).filter(|count| *count <= 4096).ok_or(INVALID)?;
    let mut cursor = 8 + page_count * 4;
    let mut result = Vec::new();
    for index in 0..page_count {
        let length = read_u32(bytes, 8 + index * 4, true).ok_or(INVALID)?;
        let end = cursor.checked_add(length).ok_or(INVALID)?;
        let page = bytes.get(cursor..end).ok_or(INVALID)?;
        cursor = end;
        if page.get(..4) != Some(&[0, 0, 1, 0]) {
            return Err(INVALID);
        }
        let count = read_u32(page, 4, false).filter(|count| *count <= 8192).ok_or(INVALID)?;
        if 12 + count * 4 > page.len() {
            return Err(INVALID);
        }
        for index in 0..count {
            let offset = read_u32(page, 8 + index * 4, false).ok_or(INVALID)?;
            if offset < 12 + count * 4 {
                return Err(INVALID);
            }
            let length = read_u32(page, offset, false).filter(|size| *size >= 56).ok_or(INVALID)?;
            let record =
                page.get(offset..offset.checked_add(length).ok_or(INVALID)?).ok_or(INVALID)?;
            let domain = record_string(record, 16).ok_or(INVALID)?;
            let domain = domain.trim_start_matches('.');
            if domain != "roblox.com" && !domain.ends_with(".roblox.com") {
                continue;
            }
            let name = record_string(record, 20).ok_or(INVALID)?;
            if name != CURRENT_USER && name != ".ROBLOSECURITY" && !name.starts_with(SESSION_PREFIX)
            {
                continue;
            }
            let value = record_string(record, 28).ok_or(INVALID)?;
            result.push(StoredCookie { name, value });
            if result.len() > 1024 {
                return Err(INVALID);
            }
        }
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
pub(super) fn read_studio_cookies() -> crate::error::Result<Vec<StudioCookie>> {
    use std::io::Read;
    let home = std::env::var_os("HOME").ok_or("The home directory is unavailable.")?;
    let path = std::path::PathBuf::from(home)
        .join("Library/HTTPStorages/com.Roblox.RobloxStudio.binarycookies");
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not read the Roblox Studio session store.".into()),
    };
    let mut bytes = Vec::new();
    file.take(25 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| {
        crate::error::AppError::Custom("Could not read the Roblox Studio session store.".into())
    })?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("The Roblox Studio session store is too large.".into());
    }
    Ok(sessions_from_records(parse_binary_cookies(&bytes).map_err(crate::error::AppError::from)?))
}

#[cfg(target_os = "windows")]
pub(super) fn read_studio_cookies() -> crate::error::Result<Vec<StudioCookie>> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    const PREFIX: &str = "https://www.roblox.com:RobloxStudioAuth";
    struct Credentials(*mut *mut CREDENTIALW);
    impl Drop for Credentials {
        fn drop(&mut self) {
            unsafe {
                CredFree(self.0.cast());
            }
        }
    }
    let filter: Vec<u16> = format!("{PREFIX}*").encode_utf16().chain(std::iter::once(0)).collect();
    let mut count = 0;
    let mut entries = std::ptr::null_mut();
    unsafe {
        if CredEnumerateW(filter.as_ptr(), 0, &mut count, &mut entries) == 0 {
            return if GetLastError() == ERROR_NOT_FOUND {
                Ok(Vec::new())
            } else {
                Err("Could not read Roblox Studio sessions from Windows Credentials.".into())
            };
        }
        let entries = Credentials(entries);
        if entries.0.is_null() || count == 0 {
            return Ok(Vec::new());
        }
        let mut records = Vec::new();
        for ptr in std::slice::from_raw_parts(entries.0, count.min(1024) as usize) {
            let Some(entry) = ptr.as_ref() else {
                continue;
            };
            if entry.Type != CRED_TYPE_GENERIC
                || entry.TargetName.is_null()
                || entry.CredentialBlob.is_null()
                || entry.CredentialBlobSize == 0
                || entry.CredentialBlobSize > 32_768
            {
                continue;
            }
            let mut length = 0;
            while length < 512 && *entry.TargetName.add(length) != 0 {
                length += 1;
            }
            if length == 512 {
                continue;
            }
            let target =
                String::from_utf16_lossy(std::slice::from_raw_parts(entry.TargetName, length));
            let Some(suffix) = target.strip_prefix(PREFIX) else {
                continue;
            };
            if suffix != "userid" && !suffix.starts_with(".ROBLOSECURITY") {
                continue;
            }
            let bytes =
                std::slice::from_raw_parts(entry.CredentialBlob, entry.CredentialBlobSize as usize);
            let Some(value) = credential_value(bytes) else {
                continue;
            };
            records.push(StoredCookie { name: format!("/RobloxStudioAuth/{suffix}"), value });
        }
        Ok(sessions_from_records(records))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(super) fn read_studio_cookies() -> crate::error::Result<Vec<StudioCookie>> {
    let Some(home) = std::env::var_os("HOME") else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for suffix in [".config/roblox-studio/cookies", ".local/share/roblox-studio/cookies"] {
        if let Ok(value) = std::fs::read_to_string(std::path::Path::new(&home).join(suffix)) {
            records.push(StoredCookie { name: ".ROBLOSECURITY".into(), value });
        }
    }
    Ok(sessions_from_records(records))
}

#[cfg(test)]
mod tests {
    use super::*;
    const TOKEN: &str = "_|WARNING:-DO-NOT-SHARE-THIS.--Sharing-this-will-allow-someone-to-log-in-as-you-and-to-steal-your-ROBUX-and-items.|_synthetic-";

    fn fixture(records: &[(&str, &str, &str)]) -> Vec<u8> {
        let mut page = vec![0; 12 + records.len() * 4];
        page[..4].copy_from_slice(&[0, 0, 1, 0]);
        page[4..8].copy_from_slice(&(records.len() as u32).to_le_bytes());
        for (index, (domain, name, value)) in records.iter().enumerate() {
            let offset = page.len() as u32;
            page[8 + index * 4..12 + index * 4].copy_from_slice(&offset.to_le_bytes());
            let mut record = vec![0; 56];
            for (field, value) in [(16, *domain), (20, *name), (24, "/"), (28, *value)] {
                let offset = record.len() as u32;
                record[field..field + 4].copy_from_slice(&offset.to_le_bytes());
                record.extend_from_slice(value.as_bytes());
                record.push(0);
            }
            let length = record.len() as u32;
            record[..4].copy_from_slice(&length.to_le_bytes());
            page.extend(record);
        }
        let mut bytes = b"cook".to_vec();
        bytes.extend_from_slice(&1u32.to_be_bytes());
        bytes.extend_from_slice(&(page.len() as u32).to_be_bytes());
        bytes.extend(page);
        bytes
    }

    #[test]
    fn reads_all_studio_accounts_and_prioritizes_current_without_duplicates() {
        let one = format!("{TOKEN}one");
        let two = format!("{TOKEN}two");
        let bytes = fixture(&[
            (".roblox.com", CURRENT_USER, "222"),
            (".roblox.com", "/RobloxStudioAuth/.ROBLOSECURITY111", &one),
            (".roblox.com", "/RobloxStudioAuth/.ROBLOSECURITY222", &two),
            (".roblox.com", ".ROBLOSECURITY", &two),
            ("evilroblox.com", ".ROBLOSECURITY", &format!("{TOKEN}evil")),
            (".roblox.com", "/RobloxStudioAuth/.ROBLOSECURITY111evil", &one),
        ]);
        let sessions = sessions_from_records(parse_binary_cookies(&bytes).expect("records"));
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].user_id.as_deref(), Some("222"));
        assert!(sessions[0].is_current);
        assert_eq!(sessions[1].user_id.as_deref(), Some("111"));
        assert!(!sessions[1].is_current);
    }

    #[test]
    fn accepts_legacy_studio_session_without_guessing_the_identity() {
        let sessions = sessions_from_records(vec![StoredCookie {
            name: ".ROBLOSECURITY".into(),
            value: format!("{TOKEN}legacy"),
        }]);
        assert_eq!(sessions.len(), 1);
        assert!(sessions[0].user_id.is_none());
        assert!(sessions[0].is_current);
    }

    #[test]
    fn decodes_windows_utf8_and_utf16_credentials_with_optional_terminators() {
        for value in ["1234567", "12345678", &format!("{TOKEN}windows")] {
            for terminated in [false, true] {
                let text = format!("{value}{}", if terminated { "\0" } else { "" });
                let utf16: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
                assert_eq!(credential_value(text.as_bytes()).as_deref(), Some(value));
                assert_eq!(credential_value(&utf16).as_deref(), Some(value));
            }
        }
    }

    #[test]
    fn rejects_truncated_stores_and_invalid_offsets_without_panicking() {
        let bytes = fixture(&[(".roblox.com", ".ROBLOSECURITY", &format!("{TOKEN}one"))]);
        for end in 0..bytes.len() {
            assert!(parse_binary_cookies(&bytes[..end]).is_err());
        }
        let mut broken = bytes;
        broken[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_binary_cookies(&broken).is_err());
    }
}
