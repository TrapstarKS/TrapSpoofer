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
            "autoPush": { "type": "boolean", "description": "Push the new ids into Studio automatically when the job finishes (default true)." }
        },
        "additionalProperties": false
    })
}

fn job_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
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

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "get_status",
        description: "Overview of TrapSpoofer: Studio connection, open place, active profile and upload target, last scan summary and the running job.",
        timeout_secs: 20,
        schema: empty,
    },
    ToolDef {
        name: "scan_studio",
        description: "Scan the place currently open in Roblox Studio (requires the TrapSpoofer plugin) and wait for the result. Returns counts per asset type.",
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
        description: "Progress and results (oldId -> newId, failures) of the current or last spoof job.",
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
