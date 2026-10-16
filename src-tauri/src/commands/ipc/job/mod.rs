#![allow(clippy::needless_pass_by_value)]
pub mod processor;
pub mod publish;
pub mod state;
pub mod types;

use tauri::AppHandle;

use processor::process_spoofer_action;
use state::update_spoofer_control;
use types::SpooferActionRequest;

#[tauri::command]
#[specta::specta]
pub async fn run_spoofer_action(
    app: AppHandle,
    mut data: SpooferActionRequest,
) -> crate::error::Result<()> {
    use validator::Validate;
    if let Err(e) = data.validate() {
        return Err(crate::error::AppError::Custom(format!("Validation failed: {}", e)));
    }
    if data.publish_files.is_some()
        || (data.permission_asset_ids.is_some() && data.assets.is_none())
    {
        return publish::process_publish_action(app, data).await;
    }
    let job_id = data
        .job_id
        .as_deref()
        .and_then(|id| uuid::Uuid::parse_str(id).ok())
        .unwrap_or_else(uuid::Uuid::new_v4)
        .to_string();
    data.job_id = Some(job_id.clone());
    state::begin_spoofer_job(&job_id)?;
    tauri::async_runtime::spawn(async move {
        if let Err(error) = process_spoofer_action(app.clone(), data).await {
            use tauri::Emitter;
            let _ = app.emit(
                "spoofer-result",
                serde_json::json!({
                    "jobId": job_id, "success": false, "error": error.to_string(),
                }),
            );
        }
        state::finish_spoofer_job(&job_id);
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[must_use]
pub fn spoofer_pause(job_id: String) -> bool {
    update_spoofer_control(&job_id, |control| control.paused = true)
}

#[tauri::command]
#[specta::specta]
#[must_use]
pub fn spoofer_resume(job_id: String) -> bool {
    update_spoofer_control(&job_id, |control| control.paused = false)
}

#[tauri::command]
#[specta::specta]
#[must_use]
pub fn spoofer_cancel(job_id: String) -> bool {
    update_spoofer_control(&job_id, |control| control.cancelled = true)
}

#[tauri::command]
#[specta::specta]
pub fn force_reset_spoofer_job() {
    if let Ok(mut control) = state::spoofer_control().lock() {
        *control = state::SpooferControl::default();
    }
}
