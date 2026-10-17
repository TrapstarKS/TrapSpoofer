use crate::commands::AnyValue;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use super::ipc::{read_json_file, write_json_file};

static JOB_MUTEX: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn job_mutex() -> &'static Mutex<HashMap<String, String>> {
    JOB_MUTEX.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_jobs_path(app: &AppHandle) -> crate::error::Result<PathBuf> {
    let dir = app.path().app_data_dir()?;
    Ok(dir.join("job-history.json"))
}

fn sanitize_job(job: &mut Value) -> bool {
    let mut dirty = false;
    if let Some(config) = job.get_mut("config").and_then(Value::as_object_mut) {
        dirty |= config.remove("cookie").is_some();
        dirty |= config.remove("apiKey").is_some();
        dirty |= config.remove("api_key").is_some();
    }
    dirty
}

fn sanitize_job_history(jobs: &mut Value) -> bool {
    let mut dirty = false;
    if let Some(entries) = jobs.as_array_mut() {
        for job in entries {
            dirty |= sanitize_job(job);
        }
    }
    dirty
}

#[tauri::command]
#[specta::specta]
pub async fn get_jobs(app: AppHandle) -> crate::error::Result<AnyValue> {
    let _guard = job_mutex().lock().await;
    let path = get_jobs_path(&app)?;
    let mut jobs = read_json_file(&path).await?;
    if !jobs.is_array() {
        jobs = Value::Array(vec![]);
    }
    if sanitize_job_history(&mut jobs) {
        write_json_file(&path, &jobs).await?;
    }
    Ok(AnyValue(jobs))
}

#[tauri::command]
#[specta::specta]
pub async fn delete_job(app: AppHandle, job_id: String) -> crate::error::Result<bool> {
    let _guard = job_mutex().lock().await;
    let path = get_jobs_path(&app)?;
    let mut jobs = read_json_file(&path).await?;
    if let Some(entries) = jobs.as_array_mut() {
        let before_len = entries.len();
        entries.retain(|job| job.get("id").and_then(Value::as_str) != Some(job_id.as_str()));
        if entries.len() == before_len {
            return Ok(false);
        }
        write_json_file(&path, &jobs).await?;
    }
    Ok(true)
}

pub(super) async fn persist_job(app: &AppHandle, job: Value) -> crate::error::Result<bool> {
    persist_job_at_path(&get_jobs_path(app)?, job).await
}

async fn persist_job_at_path(path: &PathBuf, job: Value) -> crate::error::Result<bool> {
    let known_moderation = job_mutex().lock().await;
    let mut jobs = read_json_file(path).await?;
    if !jobs.is_array() {
        jobs = Value::Array(vec![]);
    }
    let mut sanitized_job = job;
    sanitize_job(&mut sanitized_job);
    apply_job_moderation(&mut sanitized_job, &known_moderation);
    if let Some(entries) = jobs.as_array_mut() {
        entries.insert(0, sanitized_job);
        entries.truncate(250);
    }
    write_json_file(path, &jobs).await?;
    Ok(true)
}

pub(super) fn published_asset_id(asset: &Value) -> Option<String> {
    ["assetId", "newId", "meshId", "imageId"].into_iter().find_map(|key| {
        let id = asset.get(key)?;
        let id = id.as_str().map(str::to_owned).or_else(|| id.as_u64().map(|id| id.to_string()))?;
        (id.bytes().all(|byte| byte.is_ascii_digit()) && id.parse::<u64>().is_ok_and(|id| id > 0))
            .then_some(id)
    })
}

fn apply_asset_moderation(assets: &mut [Value], updates: &HashMap<String, String>) -> bool {
    let mut dirty = false;
    for asset in assets {
        if asset.get("moderation").and_then(Value::as_str) != Some("pending") {
            continue;
        }
        let Some(moderation) = published_asset_id(asset).and_then(|id| updates.get(&id)) else {
            continue;
        };
        if matches!(moderation.as_str(), "approved" | "rejected") {
            asset["moderation"] = Value::String(moderation.clone());
            dirty = true;
        }
    }
    dirty
}

fn apply_job_moderation(job: &mut Value, updates: &HashMap<String, String>) -> bool {
    job.get_mut("assetResults")
        .and_then(Value::as_array_mut)
        .is_some_and(|assets| apply_asset_moderation(assets, updates))
}

pub(super) async fn reconcile_asset_moderation(assets: &mut [Value]) {
    let mut known_moderation = job_mutex().lock().await;
    for asset in assets.iter() {
        let Some(state) = asset
            .get("moderation")
            .and_then(Value::as_str)
            .filter(|state| matches!(*state, "approved" | "rejected"))
        else {
            continue;
        };
        if let Some(id) = published_asset_id(asset) {
            known_moderation.entry(id).or_insert_with(|| state.to_owned());
        }
    }
    apply_asset_moderation(assets, &known_moderation);
}

async fn update_moderation_at_path(
    path: &PathBuf,
    updates: &HashMap<String, String>,
) -> crate::error::Result<()> {
    let mut known_moderation = job_mutex().lock().await;
    for (id, moderation) in updates {
        if matches!(moderation.as_str(), "approved" | "rejected") {
            known_moderation.insert(id.clone(), moderation.clone());
        }
    }
    let mut jobs = read_json_file(path).await?;
    let mut dirty = false;
    if let Some(entries) = jobs.as_array_mut() {
        for job in entries {
            dirty |= apply_job_moderation(job, updates);
        }
    }
    if dirty {
        sanitize_job_history(&mut jobs);
        write_json_file(path, &jobs).await?;
    }
    Ok(())
}

pub(super) async fn update_asset_moderation(
    app: &AppHandle,
    updates: &HashMap<String, String>,
) -> crate::error::Result<()> {
    if !updates.is_empty() {
        update_moderation_at_path(&get_jobs_path(app)?, updates).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn open_job_log(app: AppHandle, log_path: String) -> crate::error::Result<bool> {
    let logs_dir = app.path().app_data_dir()?.join("trapspoofer_logs");
    let canonical_logs_dir = tokio::fs::canonicalize(logs_dir).await?;
    let canonical_log_path = tokio::fs::canonicalize(log_path).await?;

    if !canonical_log_path.starts_with(canonical_logs_dir) {
        return Err("Job log path is outside the logs directory.".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(canonical_log_path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|err| err.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn moderation_updates_preserve_history_and_use_model_ids() {
        let directory =
            std::env::temp_dir().join(format!("trapspoofer-jobs-{}", uuid::Uuid::new_v4()));
        let path = directory.join("job-history.json");
        let original = json!([{
            "id":"job", "status":"finished", "config":{"kind":"publish"},
            "assetResults":[
                {"id":"mesh.fbx","assetId":"100","meshId":"101","newId":"101","moderation":"pending","success":true,"permission":{"status":"granted"}},
                {"id":"image.png","assetId":"200","moderation":"pending","warnings":["keep"]},
                {"id":"final.png","assetId":"300","moderation":"rejected"}
            ]
        }]);
        write_json_file(&path, &original).await.expect("history");
        let mesh_updates = HashMap::from([
            ("100".into(), "approved".into()),
            ("101".into(), "rejected".into()),
            ("300".into(), "approved".into()),
        ]);
        let image_updates = HashMap::from([("200".into(), "rejected".into())]);
        let (mesh_result, image_result) = tokio::join!(
            update_moderation_at_path(&path, &mesh_updates),
            update_moderation_at_path(&path, &image_updates),
        );
        mesh_result.expect("mesh update");
        image_result.expect("image update");
        let actual = read_json_file(&path).await.expect("updated history");
        let mut expected = original;
        expected[0]["assetResults"][0]["moderation"] = json!("approved");
        expected[0]["assetResults"][1]["moderation"] = json!("rejected");
        assert_eq!(actual, expected);
        tokio::fs::remove_dir_all(directory).await.expect("cleanup");
    }

    #[tokio::test]
    async fn rechecked_active_moderation_cannot_regress_when_job_is_persisted() {
        let directory =
            std::env::temp_dir().join(format!("trapspoofer-jobs-{}", uuid::Uuid::new_v4()));
        let path = directory.join("job-history.json");
        let asset_id = (uuid::Uuid::new_v4().as_u128() as u64).to_string();
        update_moderation_at_path(&path, &HashMap::from([(asset_id.clone(), "approved".into())]))
            .await
            .expect("recheck before history exists");
        let pending =
            json!({"assetId":asset_id,"meshId":"101","moderation":"pending","success":true});
        let mut active = vec![pending.clone()];
        reconcile_asset_moderation(&mut active).await;
        assert_eq!(active[0]["moderation"], "approved");
        persist_job_at_path(&path, json!({"id":"active","assetResults":[pending]}))
            .await
            .expect("persist completed job");
        let history = read_json_file(&path).await.expect("history");
        assert_eq!(history[0]["assetResults"][0]["moderation"], "approved");
        assert_eq!(history[0]["assetResults"][0]["success"], true);
        tokio::fs::remove_dir_all(directory).await.expect("cleanup");
    }
}
