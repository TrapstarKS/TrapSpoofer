use super::messages::{infer_category_from_property, StudioRecord};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioLocalUsage {
    pub token: String,
    pub full_name: String,
    pub class_name: String,
    pub property: String,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
pub struct StudioLocalReference {
    pub uri: String,
    pub path: Option<String>,
    #[serde(rename = "type")]
    pub asset_type: String,
    pub usages: Vec<StudioLocalUsage>,
}

pub(crate) fn local_uri_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)rbxasset://[^\s\"'`<>\[\](){};,]+"#)
            .expect("Local URI pattern is a compile-time constant")
    })
}

pub(crate) fn is_local_asset_uri(value: &str) -> bool {
    value.get(..11).is_some_and(|prefix| prefix.eq_ignore_ascii_case("rbxasset://"))
        && value
            .get(11..)
            .is_some_and(|path| !path.is_empty() && !path.bytes().all(|byte| byte.is_ascii_digit()))
}

fn relative_content_path(uri: &str) -> Option<PathBuf> {
    if !is_local_asset_uri(uri) {
        return None;
    }
    let decoded = urlencoding::decode(&uri[11..]).ok()?;
    if decoded.contains(['\\', ':', '\0', '?', '#']) {
        return None;
    }
    let parts: Vec<&str> = decoded.split('/').collect();
    if parts.iter().any(|part| part.is_empty() || matches!(*part, "." | "..")) {
        return None;
    }
    Some(parts.iter().collect())
}

fn resolve_from_roots(uri: &str, roots: &[PathBuf]) -> Option<String> {
    let relative = relative_content_path(uri)?;
    roots.iter().find_map(|root| {
        let canonical_root = root.canonicalize().ok()?;
        let candidate = canonical_root.join(&relative).canonicalize().ok()?;
        (candidate.starts_with(&canonical_root) && candidate.is_file())
            .then(|| candidate.to_string_lossy().into_owned())
    })
}

fn content_roots() -> Vec<PathBuf> {
    let mut roots =
        vec![PathBuf::from("/Applications/RobloxStudio.app/Contents/Resources/content")];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        roots.push(home.join("Applications/RobloxStudio.app/Contents/Resources/content"));
        roots.push(home.join("Library/Application Support/Roblox/content"));
    }
    for base in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
        let Some(base) = std::env::var_os(base).map(PathBuf::from) else { continue };
        roots.push(base.join("Roblox/content"));
        let versions = base.join("Roblox/Versions");
        if let Ok(entries) = std::fs::read_dir(versions) {
            let mut versions: Vec<_> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("version-"))
                .map(|entry| entry.path().join("content"))
                .collect();
            versions.sort();
            roots.extend(versions);
        }
    }
    roots
}

fn infer_local_type(uri: &str, property: &str) -> &'static str {
    let extension = Path::new(uri).extension().and_then(|ext| ext.to_str()).unwrap_or("");
    match extension.to_ascii_lowercase().as_str() {
        "mesh" => "mesh",
        "png" | "jpg" | "jpeg" | "dds" | "bmp" | "tga" | "webp" | "ktx" | "ktx2" => "image",
        "wav" | "mp3" | "ogg" | "flac" => "sound",
        _ => infer_category_from_property(property).unwrap_or("unknown"),
    }
}

pub fn collect_local_references(records: &[StudioRecord]) -> Vec<StudioLocalReference> {
    collect_with_roots(records, &content_roots())
}

fn collect_with_roots(records: &[StudioRecord], roots: &[PathBuf]) -> Vec<StudioLocalReference> {
    let mut references = BTreeMap::<String, StudioLocalReference>::new();
    let mut seen = HashSet::new();
    for record in records {
        for found in local_uri_pattern().find_iter(&record.value) {
            let uri = found.as_str();
            if !is_local_asset_uri(uri)
                || !seen.insert((uri.to_string(), record.token.clone(), record.property.clone()))
            {
                continue;
            }
            let reference =
                references.entry(uri.to_string()).or_insert_with(|| StudioLocalReference {
                    uri: uri.to_string(),
                    path: resolve_from_roots(uri, roots),
                    asset_type: infer_local_type(uri, &record.property).into(),
                    usages: Vec::new(),
                });
            if reference.asset_type == "unknown" {
                reference.asset_type = infer_local_type(uri, &record.property).into();
            }
            reference.usages.push(StudioLocalUsage {
                token: record.token.clone(),
                full_name: record.full_name.clone(),
                class_name: record.class_name.clone(),
                property: record.property.clone(),
            });
        }
    }
    references.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(property: &str, value: &str) -> StudioRecord {
        StudioRecord {
            token: "1".into(),
            class_name: "ModuleScript".into(),
            name: "Assets".into(),
            full_name: "ReplicatedStorage.Assets".into(),
            property: property.into(),
            value: value.into(),
        }
    }

    #[test]
    fn collects_content_uris_and_script_references_without_numeric_ids() {
        let references = collect_with_roots(&[
            record("ColorMap", "rbxasset://textures/face.png"),
            record("Source", "local uri = Content.fromUri('rbxasset://textures/face.png')\nlocal mesh = 'rbxasset://models/body.mesh'\nlocal id = 'rbxasset://12345'"),
        ], &[]);
        assert_eq!(references.len(), 2);
        assert_eq!(references[0].asset_type, "mesh");
        assert_eq!(references[1].asset_type, "image");
        assert_eq!(references[1].usages.len(), 2);
        assert!(references[1].path.is_none());
    }

    #[test]
    fn resolves_only_files_inside_content_roots() {
        let root =
            std::env::temp_dir().join(format!("trapspoofer-content-{}", uuid::Uuid::new_v4()));
        let content = root.join("content");
        std::fs::create_dir_all(content.join("textures")).expect("content directory");
        std::fs::write(content.join("textures/face.png"), b"png").expect("fixture");
        std::fs::write(root.join("outside.png"), b"png").expect("outside fixture");
        let roots = [content.clone()];
        assert!(resolve_from_roots("rbxasset://textures/face.png", &roots).is_some());
        for uri in [
            "rbxasset://../outside.png",
            "rbxasset://%2e%2e/outside.png",
            "rbxasset:///outside.png",
            "rbxasset://C:/outside.png",
            "rbxasset://textures%5cface.png",
        ] {
            assert!(resolve_from_roots(uri, &roots).is_none(), "{uri}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside.png"), content.join("escape.png"))
                .expect("symlink");
            assert!(resolve_from_roots("rbxasset://escape.png", &roots).is_none());
        }
        std::fs::remove_dir_all(root).expect("cleanup");
    }
}
