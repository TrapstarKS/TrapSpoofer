use super::state::{begin_spoofer_job, finish_spoofer_job, wait_if_paused};
use super::types::SpooferActionRequest;
use crate::commands::spoofer::permissions::{
    permission_status, sanitize_response, validate_permission_targets,
};
use crate::commands::spoofer::upload_auth::UploadAuth;
use crate::commands::spoofer::{publish_asset_with_hooks, PublishHooks};
use crate::commands::AnyValue;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const MAX_UPLOAD_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Clone, Deserialize, Serialize, specta::Type)]
pub struct PublishFile {
    pub path: String,
    #[serde(rename = "type")]
    pub asset_type: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GrantPermissions {
    pub enabled: bool,
    #[serde(alias = "subjectType")]
    pub subject_type: String,
    pub ids: Vec<String>,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PublishFileInspection {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub asset_type: String,
    #[specta(type = f64)]
    pub size: u64,
    pub sha256: Option<String>,
    pub cache_hit: bool,
    pub cached_asset_id: Option<String>,
    pub error: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Default)]
struct CachedUpload {
    asset_id: Option<String>,
    operation_path: Option<String>,
    mesh_id: Option<String>,
    image_id: Option<String>,
    uncertain: bool,
}

fn cache_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|_| "Could not open local publish cache")?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| "Could not configure publish cache")?;
    connection.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS publish_cache (cache_key TEXT PRIMARY KEY, asset_id TEXT, operation_path TEXT, mesh_id TEXT, image_id TEXT, uncertain INTEGER NOT NULL DEFAULT 0)").map_err(|_| "Could not initialize local publish cache")?;
    Ok(connection)
}

fn cache_read(path: &Path, key: &str) -> Result<Option<CachedUpload>, String> {
    if !path.try_exists().map_err(|_| "Could not inspect local publish cache")? {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "Could not open local publish cache")?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| "Could not configure publish cache")?;
    connection.query_row("SELECT asset_id,operation_path,mesh_id,image_id,uncertain FROM publish_cache WHERE cache_key=?1", [key], |row| Ok(CachedUpload {asset_id:row.get(0)?,operation_path:row.get(1)?,mesh_id:row.get(2)?,image_id:row.get(3)?,uncertain:row.get(4)?})).optional().map_err(|_| "Could not read local publish cache".into())
}

fn cache_write(path: &Path, key: &str, value: &CachedUpload) -> Result<(), String> {
    cache_connection(path)?.execute("INSERT INTO publish_cache(cache_key,asset_id,operation_path,mesh_id,image_id,uncertain) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(cache_key) DO UPDATE SET asset_id=excluded.asset_id,operation_path=excluded.operation_path,mesh_id=excluded.mesh_id,image_id=excluded.image_id,uncertain=excluded.uncertain", params![key,value.asset_id,value.operation_path,value.mesh_id,value.image_id,value.uncertain]).map_err(|_| "Could not save upload receipt; do not retry this upload before checking Creator Hub")?;
    Ok(())
}

fn cache_key(hash: &str, profile_id: Option<&str>, group_id: Option<&str>, kind: &str) -> String {
    hex::encode(Sha256::digest(
        format!(
            "{hash}|profile:{}|group:{}|type:{kind}",
            profile_id.unwrap_or_default(),
            group_id.unwrap_or_default()
        )
        .as_bytes(),
    ))
}

fn kind_from_path(path: &Path, requested: Option<&str>) -> Result<&'static str, String> {
    let extension =
        path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let kind = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "bmp" | "tga" => "Image",
        "ogg" | "mp3" | "wav" | "flac" => "Audio",
        "fbx" | "obj" | "gltf" | "glb" | "mesh" => "Mesh",
        _ => return Err("Unsupported file extension. Choose an image, audio, FBX, OBJ, glTF, GLB, or Roblox .mesh file".into()),
    };
    if let Some(requested) = requested.filter(|value| !value.is_empty()) {
        if !(requested.eq_ignore_ascii_case(kind)
            || kind == "Mesh" && requested.eq_ignore_ascii_case("Model"))
        {
            return Err(format!("The requested type does not match this {kind} file"));
        }
    }
    Ok(kind)
}

fn account_id(account: Option<&AnyValue>) -> Option<String> {
    account.and_then(|account| account.0.get("id")).and_then(|id| {
        id.as_str().map(str::to_owned).or_else(|| id.as_u64().map(|id| id.to_string()))
    })
}

fn creator_metadata(value: Option<&AnyValue>) -> Value {
    let mut result = serde_json::Map::new();
    if let Some(value) = value {
        for key in ["id", "name", "displayName", "username"] {
            if let Some(field) =
                value.0.get(key).filter(|field| field.is_string() || field.is_number())
            {
                result.insert(key.into(), field.clone());
            }
        }
    }
    Value::Object(result)
}

fn numeric_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().all(|byte| byte.is_ascii_digit())
        && id.parse::<u64>().is_ok_and(|id| id > 0)
}

async fn read_local(file: &PublishFile) -> Result<(PathBuf, Vec<u8>, &'static str), String> {
    let path = tokio::fs::canonicalize(&file.path)
        .await
        .map_err(|_| "Local file could not be found or accessed")?;
    let metadata = tokio::fs::metadata(&path).await.map_err(|_| "Could not inspect local file")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_UPLOAD_BYTES {
        return Err("Choose a nonempty regular file no larger than 20 MiB".into());
    }
    let kind = kind_from_path(&path, file.asset_type.as_deref())?;
    let mut bytes = tokio::fs::read(&path).await.map_err(|_| "Could not read local file")?;
    validate_payload(&path, &bytes, kind)?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("gltf"))
    {
        bytes = bundle_gltf(&path, &bytes).await?;
    }
    Ok((path, bytes, kind))
}

fn validate_payload(path: &Path, bytes: &[u8], kind: &str) -> Result<(), String> {
    let ext =
        path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase();
    let valid = match ext.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => bytes.starts_with(b"\xff\xd8\xff"),
        "bmp" => bytes.starts_with(b"BM"),
        "tga" => {
            bytes.len() >= 18
                && matches!(bytes[2], 1 | 2 | 3 | 9 | 10 | 11)
                && bytes[12..16] != [0; 4]
        }
        "ogg" => bytes.starts_with(b"OggS"),
        "wav" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WAVE"),
        "flac" => bytes.starts_with(b"fLaC"),
        "mp3" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() > 1 && bytes[0] == 255 && bytes[1] & 224 == 224)
        }
        "glb" => {
            bytes.starts_with(b"glTF")
                && bytes.get(4..8) == Some(&2u32.to_le_bytes())
                && bytes.len() >= 20
                && u32::from_le_bytes(bytes[8..12].try_into().map_err(|_| "Invalid GLB")?) as usize
                    == bytes.len()
        }
        "gltf" => serde_json::from_slice::<Value>(bytes).ok().is_some_and(|value| {
            value
                .get("asset")
                .and_then(|asset| asset.get("version"))
                .and_then(Value::as_str)
                .is_some_and(|version| version.starts_with("2."))
        }),
        "fbx" => {
            bytes.starts_with(b"Kaydara FBX Binary")
                || String::from_utf8_lossy(&bytes[..bytes.len().min(4096)])
                    .contains("FBXHeaderExtension")
        }
        "obj" | "mesh" => {
            crate::commands::spoofer::mesh::convert_to_glb(bytes, &ext)?;
            true
        }
        _ => false,
    };
    if !valid {
        return Err(format!("The file contents are not valid {kind} data for .{ext}"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn inspect_publish_files(
    app: AppHandle,
    files: Vec<PublishFile>,
    profile_id: Option<String>,
    group_id: Option<String>,
) -> crate::error::Result<Vec<PublishFileInspection>> {
    if files.len() > 1000 {
        return Err("Inspect at most 1000 files at a time".into());
    }
    let cache_path = app.path().app_data_dir()?.join("publish-cache.sqlite3");
    let mut result = Vec::new();
    for file in files {
        let name = file.name.clone().unwrap_or_else(|| {
            Path::new(&file.path)
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Asset")
                .into()
        });
        let mut inspection = PublishFileInspection {
            path: file.path.clone(),
            name,
            asset_type: String::new(),
            size: 0,
            sha256: None,
            cache_hit: false,
            cached_asset_id: None,
            error: None,
            warnings: vec![],
        };
        match read_local(&file).await {
            Ok((path, bytes, kind)) => {
                let hash = hex::encode(Sha256::digest(&bytes));
                inspection.asset_type = kind.into();
                inspection.size = bytes.len() as u64;
                inspection.sha256 = Some(hash.clone());
                match cache_read(
                    &cache_path,
                    &cache_key(&hash, profile_id.as_deref(), group_id.as_deref(), kind),
                ) {
                    Ok(Some(cached)) => {
                        inspection.cache_hit = cached.asset_id.is_some()
                            || cached.operation_path.is_some()
                            || cached.uncertain;
                        inspection.cached_asset_id = cached.asset_id;
                        if cached.uncertain {
                            inspection.warnings.push("An earlier request has an uncertain outcome; verify Creator Hub before retrying".into());
                        }
                    }
                    Ok(None) => {}
                    Err(error) => inspection.error = Some(error),
                }
                let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
                if ext.eq_ignore_ascii_case("mesh") || ext.eq_ignore_ascii_case("obj") {
                    inspection.warnings.push("Converted to static GLB geometry. Materials, rigging and facial animation are not preserved".into());
                }
            }
            Err(error) => inspection.error = Some(error),
        }
        result.push(inspection);
    }
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn list_publish_folder(
    directory: String,
    recursive: bool,
    glob: Option<String>,
) -> crate::error::Result<Vec<PublishFile>> {
    let root = tokio::fs::canonicalize(directory)
        .await
        .map_err(|_| "Publish directory could not be found")?;
    if !root.is_dir() {
        return Err("Choose a directory".into());
    }
    let pattern = glob
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(glob::Pattern::new)
        .transpose()
        .map_err(|_| "Invalid filename glob")?;
    let mut directories = vec![root.clone()];
    let mut files = Vec::new();
    while let Some(directory) = directories.pop() {
        let mut entries = tokio::fs::read_dir(&directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let kind = entry.file_type().await?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() && recursive {
                directories.push(entry.path());
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let path = entry.path();
            if kind_from_path(&path, None).is_err() {
                continue;
            }
            if pattern.as_ref().is_some_and(|pattern| {
                !pattern.matches_path(path.strip_prefix(&root).unwrap_or(&path))
                    && !pattern.matches(&entry.file_name().to_string_lossy())
            }) {
                continue;
            }
            files.push(PublishFile {
                path: path.to_string_lossy().into_owned(),
                asset_type: None,
                name: None,
                description: None,
            });
            if files.len() > 1000 {
                return Err("Folder contains more than 1000 supported files; narrow the glob or choose a smaller folder".into());
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

async fn bundle_gltf(source: &Path, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut document: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid glTF document")?;
    let parent = tokio::fs::canonicalize(source.parent().ok_or("glTF has no parent directory")?)
        .await
        .map_err(|_| "Could not access glTF source directory")?;
    let mut resource_bytes = bytes.len() as u64;
    for category in ["buffers", "images"] {
        if let Some(entries) = document.get_mut(category).and_then(Value::as_array_mut) {
            for entry in entries {
                let Some(uri) = entry.get("uri").and_then(Value::as_str).map(str::to_owned) else {
                    continue;
                };
                if uri.starts_with("data:") {
                    continue;
                }
                if uri.contains(':') || uri.contains('?') || uri.contains('#') {
                    return Err("glTF resources must be local files or data URIs".into());
                }
                let decoded = urlencoding::decode(&uri).map_err(|_| "Invalid glTF resource URI")?;
                let path = tokio::fs::canonicalize(parent.join(decoded.as_ref()))
                    .await
                    .map_err(|_| "Could not read glTF resource")?;
                if !path.starts_with(&parent) {
                    return Err("glTF resource is outside its source directory".into());
                }
                let metadata = tokio::fs::metadata(&path)
                    .await
                    .map_err(|_| "Could not inspect glTF resource")?;
                if !metadata.is_file() || metadata.len() > MAX_UPLOAD_BYTES {
                    return Err("glTF resource exceeds 20 MiB".into());
                }
                resource_bytes =
                    resource_bytes.saturating_add(metadata.len().saturating_mul(4) / 3 + 128);
                if resource_bytes > MAX_UPLOAD_BYTES {
                    return Err(
                        "glTF with its resources exceeds Roblox's 20 MiB upload limit".into()
                    );
                }
                let payload =
                    tokio::fs::read(&path).await.map_err(|_| "Could not read glTF resource")?;
                let mime = match path
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "png" => "image/png",
                    "jpg" | "jpeg" => "image/jpeg",
                    _ => "application/octet-stream",
                };
                entry["uri"] = Value::String(format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(payload)
                ));
            }
        }
    }
    let bytes = serde_json::to_vec(&document).map_err(|_| "Could not encode glTF resources")?;
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("glTF with its resources exceeds Roblox's 20 MiB upload limit".into());
    }
    Ok(bytes)
}

async fn stage_file(
    source: &Path,
    mut bytes: Vec<u8>,
    directory: &Path,
) -> Result<PathBuf, String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = if matches!(extension.as_str(), "mesh" | "obj") {
        bytes = crate::commands::spoofer::mesh::convert_to_glb(&bytes, &extension)?;
        "glb".into()
    } else {
        extension
    };
    if bytes.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("Converted file exceeds Roblox's 20 MiB upload limit".into());
    }
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|_| "Could not create publish staging directory")?;
    let path = directory.join(format!("{}.{}", uuid::Uuid::new_v4(), extension));
    tokio::fs::write(&path, bytes).await.map_err(|_| "Could not stage local file")?;
    Ok(path)
}

fn asset_id_from_content(value: &str) -> Option<String> {
    let value = value.strip_prefix("rbxassetid://").unwrap_or(value);
    if numeric_id(value) {
        return Some(value.into());
    }
    urlencoding::decode(value)
        .ok()
        .and_then(|value| {
            value.split("id=").nth(1).map(|id| {
                id.split(|c: char| !c.is_ascii_digit()).next().unwrap_or_default().to_owned()
            })
        })
        .filter(|id| numeric_id(id))
}

fn model_mesh_ids(bytes: &[u8]) -> Result<Vec<String>, String> {
    use rbx_dom_weak::types::{ContentType, Variant};
    let dom = if bytes.starts_with(b"<roblox!") {
        rbx_binary::from_reader(bytes).map_err(|_| "Could not parse uploaded binary model")?
    } else {
        rbx_xml::from_reader(bytes, rbx_xml::DecodeOptions::new())
            .map_err(|_| "Could not parse uploaded XML model")?
    };
    let mut ids = Vec::new();
    for instance in dom.descendants() {
        if instance.class.as_str() != "MeshPart" {
            continue;
        }
        for (name, value) in &instance.properties {
            if !matches!(name.as_str(), "MeshId" | "MeshContent") {
                continue;
            }
            let content = match value {
                Variant::ContentId(value) => Some(value.as_str()),
                Variant::Content(value) => match value.value() {
                    ContentType::Uri(uri) => Some(uri.as_str()),
                    _ => None,
                },
                Variant::String(value) => Some(value.as_str()),
                _ => None,
            };
            if let Some(id) = content.and_then(asset_id_from_content) {
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
    }
    if ids.is_empty() {
        return Err("Uploaded Model has no MeshPart mesh ID yet".into());
    }
    Ok(ids)
}

async fn resolve_model_mesh_id(
    asset_id: &str,
    cookie: &str,
    api_key: &str,
    csrf: &str,
) -> Result<String, String> {
    let client = crate::utils::get_http_client();
    let use_key = cookie.trim().is_empty() && !api_key.trim().is_empty();
    let auth = UploadAuth::new(if use_key { Some(api_key) } else { None }, cookie, csrf)?;
    let mut last_error = "Model is still processing".to_owned();
    for attempt in 0..6 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let response = auth
            .apply(client.get(if use_key {
                format!("https://apis.roblox.com/asset-delivery-api/v1/assetId/{asset_id}")
            } else {
                format!("https://assetdelivery.roblox.com/v1/asset/?id={asset_id}")
            }))
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                let mut bytes =
                    response.bytes().await.map_err(|_| "Could not read uploaded model")?.to_vec();
                if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                    let location = value
                        .get("location")
                        .and_then(Value::as_str)
                        .or_else(|| value.pointer("/locations/0/location").and_then(Value::as_str))
                        .ok_or("Roblox returned no Model download location")?;
                    let url = reqwest::Url::parse(location)
                        .map_err(|_| "Roblox returned an invalid Model download location")?;
                    let host = url.host_str().unwrap_or_default();
                    if url.scheme() != "https"
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || !(host == "rbxcdn.com"
                            || host.ends_with(".rbxcdn.com")
                            || host.ends_with(".roblox.com"))
                    {
                        return Err("Roblox returned an untrusted Model download location".into());
                    }
                    let response = client
                        .get(url)
                        .timeout(Duration::from_secs(20))
                        .send()
                        .await
                        .map_err(|_| "Could not download uploaded Model")?;
                    if !response.status().is_success()
                        || response.content_length().is_some_and(|size| size > 100 * 1024 * 1024)
                    {
                        return Err(
                            "Uploaded Model download failed or exceeded its size limit".into()
                        );
                    }
                    bytes = response
                        .bytes()
                        .await
                        .map_err(|_| "Could not read uploaded Model")?
                        .to_vec();
                }
                match model_mesh_ids(&bytes) {Ok(ids) if ids.len()==1=>return Ok(ids[0].clone()),Ok(ids)=>return Err(format!("Model contains {} MeshParts; choose a single-mesh file to get an unambiguous game mesh ID",ids.len())),Err(error)=>last_error=error}
            }
            Ok(response) => {
                last_error = format!(
                    "Could not resolve uploaded Model mesh ID (HTTP {})",
                    response.status().as_u16()
                );
                if matches!(response.status().as_u16(), 401 | 403) {
                    break;
                }
            }
            Err(_) => last_error = "Network error while resolving uploaded Model mesh ID".into(),
        }
    }
    Err(last_error)
}

fn moderation_from_value(value: &Value) -> &'static str {
    match value
        .pointer("/moderationResult/moderationState")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "MODERATION_STATE_APPROVED" | "Approved" => "approved",
        "MODERATION_STATE_REJECTED" | "MODERATION_STATE_DENIED" | "Rejected" => "rejected",
        _ => "pending",
    }
}

async fn wait_for_moderation(asset_id: &str, cookie: &str, api_key: &str, csrf: &str) -> String {
    let Ok(auth) = UploadAuth::new(Some(api_key), cookie, csrf) else {
        return "pending".into();
    };
    let client = crate::utils::get_http_client();
    let prefix = if api_key.trim().is_empty() {
        "https://apis.roblox.com/assets/user-auth/v1/assets"
    } else {
        "https://apis.roblox.com/assets/v1/assets"
    };
    for attempt in 0..5 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        let response = auth
            .apply(client.get(format!("{prefix}/{asset_id}")))
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        let Ok(response) = response else {
            continue;
        };
        if !response.status().is_success() {
            if matches!(response.status().as_u16(), 401 | 403 | 404) {
                break;
            }
            continue;
        }
        if let Ok(value) = response.json::<Value>().await {
            let state = moderation_from_value(&value);
            if state != "pending" {
                return state.into();
            }
        }
    }
    "pending".into()
}

struct JobGuard(String);
impl Drop for JobGuard {
    fn drop(&mut self) {
        finish_spoofer_job(&self.0);
    }
}

pub async fn process_publish_action(
    app: AppHandle,
    data: SpooferActionRequest,
) -> crate::error::Result<()> {
    let files = data.publish_files.as_deref().unwrap_or_default();
    let permission_ids = data.permission_asset_ids.as_deref().unwrap_or_default();
    if files.is_empty() && permission_ids.is_empty() {
        return Err("Choose at least one file or asset ID".into());
    }
    if files.len() + permission_ids.len() > 1000 {
        return Err("Process at most 1000 assets per job".into());
    }
    if permission_ids.iter().any(|id| !numeric_id(id)) {
        return Err("Permission asset IDs must be positive numeric IDs".into());
    }
    if let Some(grant) = data.grant_permissions.as_ref().filter(|grant| grant.enabled) {
        validate_permission_targets(&grant.subject_type, &grant.ids)?;
    }
    if files.is_empty() && !data.grant_permissions.as_ref().is_some_and(|grant| grant.enabled) {
        return Err("Enable permissions and choose a target for the permission job".into());
    }
    let job_id = data
        .job_id
        .as_deref()
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string();
    let app_data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&app_data)?;
    begin_spoofer_job(&job_id)?;
    let guard = JobGuard(job_id.clone());
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        if let Err(error) = run_publish_job(&app, &data, &job_id, &app_data).await {
            let error = sanitize_response(
                &error.to_string(),
                data.cookie.as_deref(),
                data.api_key.as_deref(),
            );
            let _=app.emit("spoofer-result",json!({"jobId":job_id,"success":false,"partial":false,"output":error,"replacements":{},"assetResults":[]}));
            let _=crate::commands::jobs::persist_job(&app,json!({"id":job_id,"status":"errored","assetResults":[],"config":{"kind":"publish","publishFiles":data.publish_files,"grantPermissions":data.grant_permissions},"error":error})).await;
        }
    });
    Ok(())
}

async fn run_publish_job(
    app: &AppHandle,
    data: &SpooferActionRequest,
    job_id: &str,
    app_data: &Path,
) -> crate::error::Result<()> {
    let start = chrono::Utc::now();
    let files = data.publish_files.clone().unwrap_or_default();
    let permission_ids = data.permission_asset_ids.clone().unwrap_or_default();
    let total = files.len() + permission_ids.len();
    let logs = app_data.join("trapspoofer_logs");
    tokio::fs::create_dir_all(&logs).await?;
    let log_path = logs.join(format!("job-{job_id}.txt"));
    let _ = app
        .emit("spoofer-started", json!({"jobId":job_id,"logFilePath":log_path.to_string_lossy()}));
    let cookie = data.cookie.as_deref().unwrap_or_default();
    let api_key = data.api_key.as_deref().unwrap_or_default();
    let user_id = account_id(data.account.as_ref());
    if cookie.trim().is_empty() && api_key.trim().is_empty() {
        return Err("Sign in or provide an API key before publishing".into());
    }
    if !files.is_empty()
        && data.group_id.as_deref().or(user_id.as_deref()).is_none_or(|id| !numeric_id(id))
    {
        return Err("Choose a creator account or group before publishing".into());
    }
    let csrf = if cookie.is_empty() {
        String::new()
    } else {
        crate::commands::auth::get_csrf_token(app.clone(), cookie.into()).await.unwrap_or_default()
    };
    let cache_path = app_data.join("publish-cache.sqlite3");
    let staging = app_data.join("downloads").join("local-publish").join(job_id);
    let mut results = Vec::new();
    let mut cancelled = false;
    let mut replacements = serde_json::Map::new();
    for file in &files {
        if wait_if_paused(job_id).await.is_err() {
            cancelled = true;
            break;
        }
        let _ = app
            .emit("spoofer-status", json!({"jobId":job_id,"id":file.path,"status":"processing"}));
        let outcome = publish_one(
            app,
            data,
            file,
            job_id,
            &cache_path,
            &staging,
            user_id.as_deref(),
            cookie,
            api_key,
            &csrf,
        )
        .await;
        let mut result = match outcome {
            Ok(value) => value,
            Err(error) => {
                json!({"id":file.path,"path":file.path,"name":file.name.clone().unwrap_or_else(||Path::new(&file.path).file_stem().and_then(|value|value.to_str()).unwrap_or("Asset").into()),"type":kind_from_path(Path::new(&file.path),file.asset_type.as_deref()).unwrap_or("unknown"),"success":false,"stage":"publish","errorReason":sanitize_response(&error,Some(cookie),Some(api_key)),"permission":{"status":"not_requested"}})
            }
        };
        if result["success"] == true {
            if let Some(new_id) = result.get("newId").and_then(Value::as_str) {
                replacements.insert(file.path.clone(), Value::String(new_id.into()));
            }
        }
        result["jobId"] = Value::String(job_id.into());
        log_result(app, &log_path, &result);
        results.push(result);
        emit_progress(app, job_id, results.len(), total);
    }
    for asset_id in &permission_ids {
        if wait_if_paused(job_id).await.is_err() {
            cancelled = true;
            break;
        }
        let permission = if let Some(grant) = &data.grant_permissions {
            permission_status(app, asset_id, grant, cookie, api_key).await
        } else {
            json!({"status":"not_requested"})
        };
        let result = json!({"id":asset_id,"assetId":asset_id,"newId":asset_id,"type":"permission","name":format!("Asset {asset_id}"),"success":permission["status"]=="granted","errorReason":permission.get("reason"),"permission":permission});
        log_result(app, &log_path, &result);
        results.push(result);
        emit_progress(app, job_id, results.len(), total);
    }
    if cancelled {
        for file in files.iter().skip(results.len().min(files.len())) {
            results.push(json!({"id":file.path,"path":file.path,"type":kind_from_path(Path::new(&file.path),None).unwrap_or("unknown"),"success":false,"cancelled":true,"errorReason":"Job cancelled before processing this file"}));
        }
        let processed_permissions =
            results.iter().filter(|result| result["type"] == "permission").count();
        for id in permission_ids.iter().skip(processed_permissions) {
            results.push(json!({"id":id,"type":"permission","success":false,"cancelled":true,"errorReason":"Job cancelled before processing this asset"}));
        }
    }
    let _ = tokio::fs::remove_dir_all(&staging).await;
    let succeeded = results.iter().filter(|result| result["success"] == true).count();
    let success = !cancelled && succeeded == total;
    let end = chrono::Utc::now();
    let status = if success {
        "successful"
    } else if succeeded > 0 {
        "partially_finished"
    } else {
        "errored"
    };
    if let Err(error)=crate::commands::jobs::persist_job(app,json!({"id":job_id,"status":status,"startTime":start.to_rfc3339(),"endTime":end.to_rfc3339(),"durationMs":(end-start).num_milliseconds(),"account":creator_metadata(data.account.as_ref()),"group":creator_metadata(data.group.as_ref()),"assetResults":results,"config":{"kind":if files.is_empty(){"permissions"}else{"publish"},"publishFiles":files,"permissionAssetIds":permission_ids,"grantPermissions":data.grant_permissions,"groupId":data.group_id},"logFilePath":log_path.to_string_lossy()})).await {let _=crate::commands::ipc::append_log_entry(app,"error","publish",&format!("Could not save publishing history: {error}"));}
    let _=app.emit("spoofer-result",json!({"jobId":job_id,"success":success,"partial":!success&&succeeded>0,"cancelled":cancelled,"assetResults":results,"replacements":replacements,"localPathReplacements":replacements,"output":format!("Processed {succeeded}/{total} assets"),"logFilePath":log_path.to_string_lossy()}));
    Ok(())
}

fn log_result(app: &AppHandle, path: &Path, result: &Value) {
    let success = result["success"] == true;
    let message = format!(
        "{}: {}{}",
        result.get("name").and_then(Value::as_str).unwrap_or("Asset"),
        if success { "completed" } else { "needs attention" },
        result
            .get("errorReason")
            .and_then(Value::as_str)
            .map(|reason| format!(": {reason}"))
            .unwrap_or_default()
    );
    let _ = app.emit("spoofer-asset-status", json!({"id":result.get("id"),"jobId":result.get("jobId"),"stage":if success {"done"}else{"error"},"message":result.get("errorReason")}));
    let _ = crate::commands::ipc::append_log_entry(
        app,
        if success { "info" } else { "warn" },
        "publish",
        &message,
    );
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "{} {}",
            chrono::Utc::now().to_rfc3339(),
            crate::commands::ipc::redact_log_message(&message)
        );
    }
    let _ = app
        .emit("spoofer-log", json!({"level":if success{"success"}else{"warn"},"message":message}));
}

fn emit_progress(app: &AppHandle, job_id: &str, current: usize, total: usize) {
    let _=app.emit("spoofer-progress",json!({"jobId":job_id,"current":current,"total":total,"progress":if total==0{100}else{current*100/total}}));
}

async fn publish_one(
    app: &AppHandle,
    data: &SpooferActionRequest,
    file: &PublishFile,
    job_id: &str,
    cache_path: &Path,
    staging: &Path,
    user_id: Option<&str>,
    cookie: &str,
    api_key: &str,
    csrf: &str,
) -> Result<Value, String> {
    let (path, bytes, kind) = read_local(file).await?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let key = cache_key(&hash, user_id, data.group_id.as_deref(), kind);
    let previous = cache_read(cache_path, &key)?;
    let cache_hit = previous.as_ref().is_some_and(|cached| {
        cached.asset_id.is_some() || cached.operation_path.is_some() || cached.uncertain
    });
    let mut receipt = previous.unwrap_or_default();
    if receipt.asset_id.is_none() {
        if let Some(operation_path) = receipt.operation_path.as_deref() {
            let auth = UploadAuth::new(Some(api_key), cookie, csrf)?;
            let client = crate::utils::get_http_client_with_proxy(data.proxy_url.as_deref());
            let id = crate::commands::spoofer::upload::poll_roblox_operation(
                app,
                &client,
                operation_path,
                &auth,
                &format!("{job_id}:local:{}", file.path),
                file.name.as_deref().unwrap_or("Local asset"),
                None,
                data.operation_poll_interval_ms,
            )
            .await?;
            receipt.asset_id = Some(id);
            receipt.uncertain = false;
            cache_write(cache_path, &key, &receipt)?;
        } else {
            if receipt.uncertain {
                return Err("A previous upload request has an uncertain outcome. Check Creator Hub before uploading again; retrying automatically could create a duplicate".into());
            }
            let staged = stage_file(&path, bytes, staging).await?;
            wait_if_paused(job_id).await.map_err(|error| error.to_string())?;
            receipt.uncertain = true;
            cache_write(cache_path, &key, &receipt)?;
            let sink_path = cache_path.to_path_buf();
            let sink_key = key.clone();
            let sink = std::sync::Arc::new(
                move |asset_id: Option<String>, operation_path: Option<String>| {
                    let mut receipt = cache_read(&sink_path, &sink_key)?.unwrap_or_default();
                    if asset_id.is_some() {
                        receipt.asset_id = asset_id;
                    }
                    if operation_path.is_some() {
                        receipt.operation_path = operation_path;
                    }
                    receipt.uncertain = false;
                    cache_write(&sink_path, &sink_key, &receipt)
                },
            );
            let name =
                file.name.clone().filter(|name| !name.trim().is_empty()).unwrap_or_else(|| {
                    path.file_stem().and_then(|value| value.to_str()).unwrap_or("Asset").into()
                });
            let result = publish_asset_with_hooks(
                app.clone(),
                staged.to_string_lossy().into_owned(),
                name,
                file.description.clone().unwrap_or_default(),
                cookie.into(),
                csrf.into(),
                data.group_id.clone(),
                format!("{job_id}:local:{}", file.path),
                Some(if kind == "Mesh" { "Model" } else { kind }.into()),
                Some(api_key.into()),
                user_id.map(str::to_owned),
                None,
                None,
                None,
                data.proxy_url.clone(),
                data.operation_poll_interval_ms,
                PublishHooks { receipt_sink: Some(sink), ..Default::default() },
            )
            .await;
            let _ = tokio::fs::remove_file(staged).await;
            let result = match result {
                Ok(result) => result,
                Err(error) => {
                    let message = error.to_string();
                    if message.contains("authorization")
                        || message.contains("denied this upload")
                        || message.contains("session expired")
                    {
                        receipt.uncertain = false;
                        cache_write(cache_path, &key, &receipt)?;
                    }
                    return Err(message);
                }
            };
            if !result.success {
                let error = result.error.unwrap_or_else(|| "Upload failed".into());
                if (error.starts_with("Upload failed:") && !error.contains("409"))
                    || error.contains("continued limiting upload requests")
                {
                    receipt.uncertain = false;
                    cache_write(cache_path, &key, &receipt)?;
                }
                return Err(error);
            }
            receipt = cache_read(cache_path, &key)?.unwrap_or_default();
            if receipt.asset_id.is_none() {
                receipt.asset_id = result.asset_id;
                receipt.uncertain = false;
                cache_write(cache_path, &key, &receipt)?;
            }
        }
    }
    let asset_id = receipt
        .asset_id
        .clone()
        .ok_or("Roblox accepted the upload but did not provide an asset ID")?;
    wait_if_paused(job_id).await.map_err(|error| error.to_string())?;
    let mut resolution_error = None;
    if kind == "Mesh" && receipt.mesh_id.is_none() {
        match resolve_model_mesh_id(&asset_id, cookie, api_key, csrf).await {
            Ok(id) => {
                receipt.mesh_id = Some(id);
                cache_write(cache_path, &key, &receipt)?;
            }
            Err(error) => resolution_error = Some(error),
        }
    }
    if kind == "Image" {
        receipt.image_id = Some(asset_id.clone());
        cache_write(cache_path, &key, &receipt)?;
    }
    let actual_id = if kind == "Mesh" { receipt.mesh_id.clone() } else { Some(asset_id.clone()) };
    let moderation = wait_for_moderation(&asset_id, cookie, api_key, csrf).await;
    let permission = match (&data.grant_permissions, actual_id.as_deref()) {
        (Some(grant), Some(id)) => permission_status(app, id, grant, cookie, api_key).await,
        (Some(grant), None) if grant.enabled => {
            json!({"status":"failed","reason":"Game asset ID is not available yet"})
        }
        _ => json!({"status":"not_requested"}),
    };
    let success =
        actual_id.is_some() && moderation != "rejected" && permission["status"] != "failed";
    let error = resolution_error
        .or_else(|| {
            (moderation == "rejected").then(|| "Roblox moderation rejected this asset".into())
        })
        .or_else(|| permission.get("reason").and_then(Value::as_str).map(str::to_owned));
    Ok(
        json!({"id":file.path,"path":file.path,"name":file.name.clone().unwrap_or_else(||path.file_stem().and_then(|value|value.to_str()).unwrap_or("Asset").into()),"type":kind.to_ascii_lowercase(),"assetId":asset_id,"meshId":receipt.mesh_id,"imageId":receipt.image_id,"newId":actual_id,"moderation":moderation,"cacheHit":cache_hit,"sha256":hash,"permission":permission,"success":success,"errorReason":error}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn gltf_dependency_changes_invalidate_fingerprint_and_resources_are_local() {
        let directory = std::env::temp_dir().join(format!("trap-gltf-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&directory).await.expect("directory");
        let source = directory.join("model.gltf");
        let document =
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin","byteLength":4}]}"#;
        tokio::fs::write(directory.join("mesh.bin"), b"1234").await.expect("buffer");
        let first = bundle_gltf(&source, document).await.expect("bundle");
        tokio::fs::write(directory.join("mesh.bin"), b"5678").await.expect("buffer");
        let second = bundle_gltf(&source, document).await.expect("bundle");
        assert_ne!(Sha256::digest(&first), Sha256::digest(&second));
        assert!(bundle_gltf(
            &source,
            br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"https://example.com/mesh.bin"}]}"#
        )
        .await
        .is_err());
        let _ = tokio::fs::remove_dir_all(directory).await;
    }
    #[test]
    fn cache_is_content_creator_and_type_scoped() {
        assert_ne!(
            cache_key("hash", Some("1"), None, "Image"),
            cache_key("hash", Some("2"), None, "Image")
        );
        assert_ne!(
            cache_key("hash", Some("1"), None, "Image"),
            cache_key("hash", Some("1"), Some("2"), "Image")
        );
        let path =
            std::env::temp_dir().join(format!("trap-publish-{}.sqlite3", uuid::Uuid::new_v4()));
        let receipt =
            CachedUpload { operation_path: Some("operations/test".into()), ..Default::default() };
        assert!(cache_read(&path, "key").expect("empty cache").is_none());
        assert!(!path.exists(), "inspection must not create a cache file");
        cache_write(&path, "key", &receipt).expect("save");
        assert_eq!(
            cache_read(&path, "key").expect("read").expect("receipt").operation_path.as_deref(),
            Some("operations/test")
        );
        let _ = std::fs::remove_file(path);
    }
    #[test]
    fn moderation_states_remain_pending_until_explicit_approval() {
        assert_eq!(moderation_from_value(&json!({})), "pending");
        assert_eq!(
            moderation_from_value(
                &json!({"moderationResult":{"moderationState":"MODERATION_STATE_REJECTED"}})
            ),
            "rejected"
        );
    }
    #[test]
    fn extension_and_explicit_type_must_agree() {
        assert_eq!(kind_from_path(Path::new("A.PNG"), Some("image")).expect("type"), "Image");
        assert!(kind_from_path(Path::new("a.mp3"), Some("mesh")).is_err());
        assert!(kind_from_path(Path::new("a.exe"), None).is_err());
    }
}
