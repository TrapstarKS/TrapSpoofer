use axum::{http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::{messages::AssetServerStateData, sessions::StudioSession};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshApplyRequest {
    pub operation_id: String,
    pub mesh_id: String,
    pub instance_path: String,
    pub mesh_part_name: Option<String>,
    pub preserve_size: bool,
}

impl MeshApplyRequest {
    pub fn new(
        mesh_id: String,
        instance_path: String,
        mesh_part_name: Option<String>,
        preserve_size: Option<bool>,
    ) -> Result<Self, String> {
        if mesh_id.is_empty()
            || mesh_id.len() > 20
            || !mesh_id.bytes().all(|byte| byte.is_ascii_digit())
            || !mesh_id.parse::<u64>().is_ok_and(|id| id > 0)
        {
            return Err("meshId must be a positive numeric asset ID.".into());
        }
        let clean_path = instance_path.strip_prefix("game.").unwrap_or(&instance_path);
        let parts: Vec<_> = clean_path.split('.').collect();
        if instance_path.len() > 2048
            || instance_path.chars().any(char::is_control)
            || parts.len() > 100
            || parts.iter().any(|part| part.is_empty())
            || !matches!(
                parts[0],
                "Workspace"
                    | "Lighting"
                    | "MaterialService"
                    | "ReplicatedFirst"
                    | "ReplicatedStorage"
                    | "ServerScriptService"
                    | "ServerStorage"
                    | "StarterGui"
                    | "StarterPack"
                    | "StarterPlayer"
                    | "SoundService"
                    | "Teams"
            )
        {
            return Err("instancePath must be a dot-separated path starting with a supported service such as Workspace.".into());
        }
        if mesh_part_name.as_ref().is_some_and(|name| {
            name.is_empty()
                || name.len() > 100
                || name.chars().any(|character| character.is_control() || character == '.')
        }) {
            return Err(
                "meshPartName must contain 1 to 100 bytes without dots or control characters."
                    .into(),
            );
        }
        Ok(Self {
            operation_id: uuid::Uuid::new_v4().to_string(),
            mesh_id,
            instance_path,
            mesh_part_name,
            preserve_size: preserve_size.unwrap_or(true),
        })
    }

    fn result_path(&self) -> String {
        self.mesh_part_name.as_ref().map_or_else(
            || self.instance_path.clone(),
            |name| format!("{}.{}", self.instance_path, name),
        )
    }
}

#[derive(Debug)]
pub struct PendingMeshApply {
    pub request: MeshApplyRequest,
    pub delivered: bool,
    completion: oneshot::Sender<Result<Value, String>>,
}

pub fn queue_mesh_apply(
    data: &mut AssetServerStateData,
    request: MeshApplyRequest,
) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
    if !data.supports_mesh_apply {
        return Err("Update the Studio plugin before applying a mesh.".into());
    }
    if data.pending_mesh_apply.is_some()
        || data.pending_patch_id.is_some()
        || data.active_scan_id.is_some()
        || data.requested_scan_id.is_some()
    {
        return Err(
            "The selected Studio window is busy. Wait for its current operation to finish.".into(),
        );
    }
    let (completion, receiver) = oneshot::channel();
    data.pending_mesh_apply = Some(PendingMeshApply { request, delivered: false, completion });
    data.notify.notify_waiters();
    Ok(receiver)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeshApplyResult {
    operation_id: String,
    success: bool,
    error: Option<String>,
    instance_path: Option<String>,
    created: Option<bool>,
}

fn complete_mesh_apply(
    data: &mut AssetServerStateData,
    session_id: &str,
    result: MeshApplyResult,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&result.operation_id).is_err()
        || result.error.as_ref().is_some_and(|error| error.len() > 8192)
    {
        return Err("Invalid mesh operation result.".into());
    }
    if data.completed_mesh_apply_id.as_deref() == Some(&result.operation_id) {
        return Ok(());
    }
    let pending = data.pending_mesh_apply.as_ref().ok_or("No mesh operation is pending.")?;
    if pending.request.operation_id != result.operation_id || !pending.delivered {
        return Err("This mesh operation is no longer active in this Studio session.".into());
    }
    if result.success
        && (result.instance_path.as_deref() != Some(pending.request.result_path().as_str())
            || result.created != Some(pending.request.mesh_part_name.is_some())
            || result.error.is_some())
    {
        return Err("The Studio plugin returned an inconsistent mesh operation result.".into());
    }
    if !result.success && result.error.as_deref().is_none_or(str::is_empty) {
        return Err("The Studio plugin did not provide a mesh operation error.".into());
    }
    let pending = data.pending_mesh_apply.take().ok_or("No mesh operation is pending.")?;
    data.completed_mesh_apply_id = Some(result.operation_id.clone());
    let outcome = if result.success {
        Ok(json!({
            "sessionId": session_id,
            "operationId": result.operation_id,
            "instancePath": pending.request.result_path(),
            "meshId": pending.request.mesh_id,
            "created": result.created,
            "preserveSize": pending.request.preserve_size,
        }))
    } else {
        Err(result.error.unwrap_or_else(|| "Studio could not apply the mesh.".into()))
    };
    let _ = pending.completion.send(outcome);
    Ok(())
}

pub async fn handle_mesh_apply_result(
    StudioSession(state): StudioSession,
    Json(result): Json<MeshApplyResult>,
) -> (StatusCode, Json<Value>) {
    let mut guard = state.data.write().await;
    match complete_mesh_apply(&mut guard, &state.session_id, result) {
        Ok(()) => (StatusCode::OK, Json(json!({"success": true}))),
        Err(error) => (StatusCode::CONFLICT, Json(json!({"success": false, "error": error}))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(path: &str, name: Option<&str>) -> MeshApplyRequest {
        MeshApplyRequest::new("123456789".into(), path.into(), name.map(str::to_string), None)
            .expect("valid request")
    }

    fn result(request: &MeshApplyRequest) -> MeshApplyResult {
        MeshApplyResult {
            operation_id: request.operation_id.clone(),
            success: true,
            error: None,
            instance_path: Some(request.result_path()),
            created: Some(request.mesh_part_name.is_some()),
        }
    }

    #[test]
    fn validates_mesh_paths_names_and_ids() {
        for path in
            ["", "game", "Workspace..Part", "Workspace.Part.", "Workspace.\nPart", "Players.Player"]
        {
            assert!(MeshApplyRequest::new("123".into(), path.into(), None, None).is_err());
        }
        for id in ["0", "-1", "1e9", "rbxassetid://123", "18446744073709551616"] {
            assert!(MeshApplyRequest::new(id.into(), "Workspace.Part".into(), None, None).is_err());
        }
        assert!(MeshApplyRequest::new(
            "123".into(),
            "Workspace.Model".into(),
            Some("A.B".into()),
            None
        )
        .is_err());
        assert_eq!(
            request("game.Workspace.Model", Some("Mesh")).result_path(),
            "game.Workspace.Model.Mesh"
        );
        assert!(request("Workspace.Mesh", None).preserve_size);
    }

    #[tokio::test]
    async fn correlates_results_and_keeps_sessions_isolated() {
        let mut first = AssetServerStateData { supports_mesh_apply: true, ..Default::default() };
        let mut second = AssetServerStateData { supports_mesh_apply: true, ..Default::default() };
        let operation = request("Workspace.Model", Some("Mesh"));
        let response = result(&operation);
        let receiver = queue_mesh_apply(&mut first, operation).expect("queued");
        assert!(second.pending_mesh_apply.is_none());
        assert!(complete_mesh_apply(&mut second, "second", response).is_err());
        let pending = first.pending_mesh_apply.as_mut().expect("pending");
        let mut response = result(&pending.request);
        pending.delivered = true;
        response.instance_path = Some("Workspace.Wrong".into());
        assert!(complete_mesh_apply(&mut first, "first", response).is_err());
        let response = result(&first.pending_mesh_apply.as_ref().expect("pending").request);
        complete_mesh_apply(&mut first, "first", response).expect("completed");
        let value = receiver.await.expect("sender").expect("success");
        assert_eq!(value["sessionId"], "first");
        assert_eq!(value["instancePath"], "Workspace.Model.Mesh");
        assert!(first.pending_mesh_apply.is_none());
    }

    #[test]
    fn rejects_old_plugins_and_competing_operations() {
        let mut data = AssetServerStateData::default();
        assert!(queue_mesh_apply(&mut data, request("Workspace.Mesh", None)).is_err());
        data.supports_mesh_apply = true;
        data.pending_patch_id = Some("busy".into());
        assert!(queue_mesh_apply(&mut data, request("Workspace.Mesh", None)).is_err());
        data.pending_patch_id = None;
        let _receiver =
            queue_mesh_apply(&mut data, request("Workspace.Mesh", None)).expect("queued");
        assert!(queue_mesh_apply(&mut data, request("Workspace.Mesh", None)).is_err());
    }

    #[tokio::test]
    async fn reports_plugin_errors_and_acknowledges_duplicate_results() {
        let mut data = AssetServerStateData { supports_mesh_apply: true, ..Default::default() };
        let operation = request("Workspace.Mesh", None);
        let operation_id = operation.operation_id.clone();
        let receiver = queue_mesh_apply(&mut data, operation).expect("queued");
        data.pending_mesh_apply.as_mut().expect("pending").delivered = true;
        let failure = || MeshApplyResult {
            operation_id: operation_id.clone(),
            success: false,
            error: Some("Asset permission denied".into()),
            instance_path: None,
            created: None,
        };
        complete_mesh_apply(&mut data, "studio", failure()).expect("failure received");
        assert_eq!(receiver.await.expect("sender"), Err("Asset permission denied".into()));
        complete_mesh_apply(&mut data, "studio", failure()).expect("retry acknowledged");
        assert!(data.pending_mesh_apply.is_none());
    }

    #[test]
    fn rejects_malformed_http_results() {
        assert!(serde_json::from_value::<MeshApplyResult>(json!({
            "operationId": uuid::Uuid::new_v4().to_string(),
            "success": "true",
        }))
        .is_err());
        assert!(serde_json::from_value::<MeshApplyResult>(json!({
            "operationId": uuid::Uuid::new_v4().to_string(),
            "success": true,
            "extra": "untrusted",
        }))
        .is_err());
    }
}
