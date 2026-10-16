//! Tool catalogue exposed over MCP.
//!
//! Tools are executed by the frontend (it owns profiles, credentials and the
//! scan/spoof state), so this file only describes them. Keep the names in sync
//! with `src/mcp/handlers.ts`.

use serde_json::{json, Value};

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub timeout_secs: u64,
    pub schema: fn() -> Value,
}

const ASSET_TYPES: [&str; 5] = ["Animation", "Sound", "Image", "Mesh", "Video"];

fn empty() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

fn scan_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "studioSessionId": {"type":"string","description":"Connected Studio session from get_status; required if several windows are connected and none selected."},
            "timeoutSeconds": { "type": "integer", "minimum": 10, "maximum": 900, "description": "How long to wait for the Studio scan to finish (default 300)." }
        },
        "additionalProperties": false
    })
}

fn list_assets_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "type": { "type": "string", "enum": ASSET_TYPES, "description": "Only return assets of this type." },
            "search": { "type": "string", "description": "Case-insensitive filter on asset id, name or instance path." },
            "onlyForeign": { "type": "boolean", "description": "Only assets NOT owned by the active profile/group (the ones that need spoofing). Default true." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Max items (default 100)." },
            "offset": { "type": "integer", "minimum": 0 }
        },
        "additionalProperties": false
    })
}

fn spoof_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "assetIds": { "type": "array", "items": { "type": "string" }, "description": "Specific asset ids to spoof. Omit to spoof every foreign asset of the selected types from the last scan." },
            "types": { "type": "array", "items": { "type": "string", "enum": ASSET_TYPES }, "description": "Asset types to include (default: Animation and Sound)." },
            "autoPush": { "type": "boolean", "description": "Apply replacements automatically; defaults to shared UI setting." },
            "grantPermissions": grant_schema(),
            "skipOwned": { "type": "boolean", "description": "Per-call override of the shared skip-owned setting." },
            "keepNameAndDescription": { "type": "boolean", "description": "Per-call override preserving the original name and description." },
            "dry_run": { "type": "boolean", "description": "Preview counts, types, target and estimated quota without uploading or granting permissions." }
        },
        "additionalProperties": false
    })
}

fn job_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "jobId": { "type": "string", "format":"uuid", "description":"Specific job, including persisted historical jobs. Omit for current/latest." },
            "waitSeconds": { "type": "integer", "minimum": 0, "maximum": 600, "description": "Block up to N seconds until the job finishes (default 0 = return current progress immediately)." }
        },
        "additionalProperties": false
    })
}

fn replace_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "mappings": {
                "type": "object",
                "additionalProperties": { "type": "string" },
                "description": "Map of oldAssetId -> newAssetId to replace everywhere in the open Studio place."
            }
        },
        "required": ["mappings"],
        "additionalProperties": false
    })
}

fn profile_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "profile": { "type": "string", "description": "Profile id or name (as returned by list_profiles)." },
            "groupId": { "type": ["string", "null"], "description": "Upload target group id, or null to upload to the user account." }
        },
        "required": ["profile"],
        "additionalProperties": false
    })
}

fn history_schema() -> Value {
    json!({
        "type": "object",
        "properties": { "limit": { "type": "integer", "minimum": 1, "maximum": 50 } },
        "additionalProperties": false
    })
}

fn file_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "Absolute path to a .rbxl, .rbxlx, .rbxm or .rbxmx file." }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn file_write_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string", "description": "Absolute path of the source .rbxl/.rbxm file." },
            "outputPath": { "type": "string", "description": "Where to write the patched copy. Default: '<name>.spoofed.<ext>' next to the source." },
            "mappings": { "type": "object", "additionalProperties": { "type": "string" }, "description": "oldId -> newId. Default: the mappings from the last finished job." }
        },
        "required": ["path"],
        "additionalProperties": false
    })
}

fn grant_schema() -> Value {
    json!({"type":"object","properties":{
        "enabled":{"type":"boolean"},
        "subjectType":{"type":"string","enum":["Universe","Group","User"]},
        "ids":{"type":"array","items":{"type":"string","pattern":"^[1-9]\\d{0,19}$"},"maxItems":100}
    },"required":["enabled","subjectType","ids"],"additionalProperties":false})
}

fn settings_schema() -> Value {
    let mut grant = grant_schema();
    grant.as_object_mut().expect("schema").remove("required");
    json!({"type":"object","properties":{
        "grantPermissions":grant,
        "skipOwned":{"type":"boolean"},"keepNameAndDescription":{"type":"boolean"},
        "animationMode":{"type":"string","enum":["animation","clip_replace","clip_parent","clip_parent_id"]},
        "enableArchiveRecovery":{"type":"boolean"},"autoPush":{"type":"boolean"}
    },"additionalProperties":false})
}

fn publish_schema() -> Value {
    json!({"type":"object","properties":{
        "files":{"type":"array","minItems":1,"maxItems":1000,"items":{"type":"object","properties":{
            "path":{"type":"string","minLength":1,"description":"Absolute local file path. Type inferred from extension: png/jpg/bmp/tga, ogg/mp3/wav/flac, fbx/obj/gltf/glb/mesh."},
            "type":{"type":"string","enum":["Image","Audio","Mesh"]},
            "name":{"type":"string","minLength":1,"maxLength":100},
            "description":{"type":"string","maxLength":1000}
        },"required":["path"],"additionalProperties":false}},
        "profile":{"type":"string","description":"Saved profile id or name; defaults to active profile."},
        "groupId":{"type":["string","null"],"description":"Target group; omit for active group, null for personal uploads."},
        "grantPermissions":grant_schema(),
        "studioPathMap":{"type":"object","additionalProperties":{"type":"string"},"description":"Absolute local path -> rbxasset://relative/path. Local refs from last Studio scan are inferred automatically."},
        "pushToStudio":{"type":"boolean","description":"Apply published IDs to local references in the selected Studio. Default false."},
        "studioSessionId":{"type":"string","description":"Explicit connected Studio session id from get_status."},
        "dry_run":{"type":"boolean","description":"Inspect files, destination, cache hits and quota estimate without uploading, granting permissions or modifying Studio."}
    },"required":["files"],"additionalProperties":false})
}

fn folder_schema() -> Value {
    let mut schema = publish_schema();
    let properties = schema["properties"].as_object_mut().expect("schema");
    properties.remove("files");
    properties.insert(
        "dir".into(),
        json!({"type":"string","minLength":1,"description":"Absolute folder path."}),
    );
    properties.insert("recursive".into(), json!({"type":"boolean","default":false}));
    properties.insert(
        "glob".into(),
        json!({"type":"string","description":"Optional relative-path glob, e.g. **/*.png."}),
    );
    schema["required"] = json!(["dir"]);
    schema
}

fn permission_assets_schema() -> Value {
    json!({"type":"object","properties":{
        "assetIds":{"type":"array","minItems":1,"maxItems":1000,"items":{"type":"string","pattern":"^[1-9]\\d{0,19}$"}}
    },"required":["assetIds"],"additionalProperties":false})
}

fn permission_grant_schema() -> Value {
    let mut schema = permission_assets_schema();
    schema["properties"]["subjectType"] =
        json!({"type":"string","enum":["Universe","Group","User"]});
    schema["properties"]["ids"] = json!({"type":"array","minItems":1,"maxItems":100,"items":{"type":"string","pattern":"^[1-9]\\d{0,19}$"}});
    schema["properties"]["dry_run"] = json!({"type":"boolean"});
    schema["required"] = json!(["assetIds", "subjectType", "ids"]);
    schema
}

fn retry_schema() -> Value {
    json!({"type":"object","properties":{"jobId":{"type":"string","format":"uuid"}},"required":["jobId"],"additionalProperties":false})
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef { name: "get_settings", description: "Read automatic permissions and upload behavior from the same persistent settings used by the UI. Contains no credentials.", timeout_secs: 20, schema: empty },
    ToolDef { name: "update_settings", description: "Patch automatic permissions and upload behavior in the UI's shared settings. Omitted fields stay unchanged. Example: {grantPermissions:{enabled:true,subjectType:Group,ids:[764544807]}} (IDs must be strings).", timeout_secs: 20, schema: settings_schema },
    ToolDef { name: "publish_assets", description: "Publish local image/audio/mesh files as new assets through the shared job pipeline. Detects types, converts Roblox .mesh v2-7, caches SHA256+profile/group, waits for moderation, returns imageId or model assetId plus actual meshId. dry_run previews without writes. Follow with get_job(jobId).", timeout_secs: 60, schema: publish_schema },
    ToolDef { name: "publish_folder", description: "Publish supported files from a local folder using the same cache, jobs, permissions and Studio path replacement as publish_assets. Supports recursive traversal and relative glob filtering.", timeout_secs: 60, schema: folder_schema },
    ToolDef { name: "grant_permissions", description: "Grant Use permission on existing assets to Universe, Group or User IDs. Batch runs through the shared job queue; get_job returns per-asset permission status and failure reasons. dry_run performs no grants.", timeout_secs: 60, schema: permission_grant_schema },
    ToolDef { name: "get_permissions", description: "Read existing recipients and Use permissions for each asset. Partial failures are returned per asset. Uses the active profile without exposing credentials.", timeout_secs: 620, schema: permission_assets_schema },
    ToolDef { name: "retry_failed", description: "Retry failed uploads or permission grants from the given historical job. Completed local uploads are recovered from cache rather than uploaded again.", timeout_secs: 60, schema: retry_schema },
    ToolDef {
        name: "get_status",
        description: "Overview of TrapSpoofer: every connected Studio session, place, placeId and game owner (User or Group), active upload target, last scan and job. Compare game owner to upload target before publishing.",
        timeout_secs: 20,
        schema: empty,
    },
    ToolDef {
        name: "scan_studio",
        description: "Scan the place currently open in Roblox Studio (requires the TrapSpoofer plugin) and wait for the result. Returns counts per asset type and local rbxasset:// references (including Content URIs) with corresponding disk paths and usages.",
        timeout_secs: 900,
        schema: scan_schema,
    },
    ToolDef {
        name: "list_assets",
        description: "List assets found by the last scan (Studio or file). Each item has id, type, name, owner and whether it still needs spoofing.",
        timeout_secs: 30,
        schema: list_assets_schema,
    },
    ToolDef {
        name: "spoof_assets",
        description: "Start a spoof job: download the assets and re-upload them to the active profile/group. Returns immediately; follow progress with get_job.",
        timeout_secs: 60,
        schema: spoof_schema,
    },
    ToolDef {
        name: "get_job",
        description: "Progress/results of spoof, publish or permission jobs: per-asset IDs, cache hits, moderation, permission status (granted/failed/not_requested), path mappings and failures. Accepts historical jobId.",
        timeout_secs: 620,
        schema: job_schema,
    },
    ToolDef {
        name: "cancel_job",
        description: "Cancel the running spoof job.",
        timeout_secs: 20,
        schema: empty,
    },
    ToolDef {
        name: "push_to_studio",
        description: "Send the id replacements of the last finished job to Studio so the place starts using the new assets.",
        timeout_secs: 60,
        schema: empty,
    },
    ToolDef {
        name: "replace_ids",
        description: "Replace arbitrary asset ids in the open Studio place (properties, attributes and scripts).",
        timeout_secs: 60,
        schema: replace_schema,
    },
    ToolDef {
        name: "list_profiles",
        description: "List saved Roblox profiles and the groups each one can upload to.",
        timeout_secs: 30,
        schema: empty,
    },
    ToolDef {
        name: "select_profile",
        description: "Choose the profile (and optionally the group) that receives the uploads.",
        timeout_secs: 30,
        schema: profile_schema,
    },
    ToolDef {
        name: "get_history",
        description: "Recent spoof jobs with their counts and timestamps.",
        timeout_secs: 20,
        schema: history_schema,
    },
    ToolDef {
        name: "scan_file",
        description: "Scan a .rbxl/.rbxlx/.rbxm/.rbxmx file from disk without Studio. The result becomes the current asset list.",
        timeout_secs: 300,
        schema: file_schema,
    },
    ToolDef {
        name: "write_spoofed_file",
        description: "Write a copy of a place/model file with asset ids replaced (defaults to the results of the last job).",
        timeout_secs: 300,
        schema: file_write_schema,
    },
];

pub fn find(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|tool| tool.name == name)
}

pub fn list_json() -> Value {
    Value::Array(
        TOOLS
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": (tool.schema)(),
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalogue_names_are_unique_and_schemas_are_closed() {
        let mut names = std::collections::HashSet::new();
        for tool in TOOLS {
            assert!(names.insert(tool.name));
            let schema = (tool.schema)();
            assert_eq!(schema["type"], "object");
            assert_eq!(schema["additionalProperties"], false);
            assert!(!tool.description.is_empty());
        }
        for name in [
            "get_settings",
            "update_settings",
            "publish_assets",
            "publish_folder",
            "grant_permissions",
            "get_permissions",
            "retry_failed",
        ] {
            assert!(find(name).is_some());
        }
        assert_eq!(spoof_schema()["properties"]["grantPermissions"], grant_schema());
        assert_eq!(folder_schema()["required"], json!(["dir"]));
    }
}
