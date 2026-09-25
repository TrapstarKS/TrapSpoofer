//! Offline place/model file mode.
//!
//! Loads `.rbxl`/`.rbxm` (binary) or `.rbxlx`/`.rbxmx` (XML) files into a
//! `WeakDom`, emits the same `StudioRecord`s the Studio plugin scanner would,
//! and can write a spoofed copy of the file by applying `plan_patches` output
//! directly to the DOM. Works without Roblox Studio running.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use rbx_dom_weak::types::{
    BinaryString, Content, ContentId, ContentType, Ref, SharedString, Tags, Variant,
};
use rbx_dom_weak::{ustr, Ustr, WeakDom};
use regex::Regex;
use serde_json::{json, Value};

use crate::api_dump::ApiDumpProperties;
use crate::commands::AnyValue;
use crate::studio_bridge::messages::{analyze_records, plan_patches, StudioRecord};

const MAX_SCRIPT_SOURCE_BYTES: usize = 8_000_000;
const MAX_RECORD_VALUE_BYTES: usize = 1_000_000;
const MAX_RECORD_TEXT_VALUE_BYTES: usize = 100_000;
const MAX_TAGS_PER_OBJECT: usize = 100;
const MAX_TAG_BYTES: usize = 100;

const ATTRIBUTE_PREFIX: &str = "__Attribute__:";
const EMOTES_PROPERTY: &str = "EmotesDataInternal";
const ACCESSORIES_PROPERTY: &str = "AccessoryBlob";

/// Mirrors `EMBEDDED_ASSET_PROPS` in plugin/src/config/runtime.luau.
const EMBEDDED_ASSET_PROPS: [&str; 8] =
    ["Text", "PlaceholderText", "Image", "HoverImage", "PressedImage", "ToolTip", "Video", "Name"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FileFormat {
    Binary,
    Xml,
}

impl FileFormat {
    fn from_path(path: &Path) -> Option<(Self, bool)> {
        let ext = path.extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "rbxl" => Some((Self::Binary, true)),
            "rbxm" => Some((Self::Binary, false)),
            "rbxlx" => Some((Self::Xml, true)),
            "rbxmx" => Some((Self::Xml, false)),
            _ => None,
        }
    }

    const fn as_str(self) -> &'static str {
        match self {
            Self::Binary => "binary",
            Self::Xml => "xml",
        }
    }
}

struct LoadedPlace {
    path: PathBuf,
    modified: Option<SystemTime>,
    len: u64,
    format: FileFormat,
    is_place: bool,
    dom: WeakDom,
    records: Vec<StudioRecord>,
    aliases: AliasMap,
    instance_count: usize,
}

/// Holds the most recently scanned file so the write step can reuse its DOM
/// and records (tokens are `Ref`s, which are only stable within one load).
static PLACE_CACHE: OnceLock<Mutex<Option<LoadedPlace>>> = OnceLock::new();

fn place_cache() -> &'static Mutex<Option<LoadedPlace>> {
    PLACE_CACHE.get_or_init(|| Mutex::new(None))
}

fn file_stamp(path: &Path) -> (Option<SystemTime>, u64) {
    std::fs::metadata(path).map_or((None, 0), |meta| (meta.modified().ok(), meta.len()))
}

fn canonical_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No file path provided".into());
    }
    std::fs::canonicalize(trimmed).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "File does not exist".to_string()
        } else {
            e.to_string()
        }
    })
}

fn load_dom(path: &Path, format: FileFormat) -> Result<WeakDom, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    match format {
        FileFormat::Binary => {
            rbx_binary::from_reader(reader).map_err(|e| format!("Failed to read binary file: {e}"))
        }
        FileFormat::Xml => rbx_xml::from_reader_default(reader)
            .map_err(|e| format!("Failed to read XML file: {e}")),
    }
}

fn load_place(path: &Path, props: &ApiDumpProperties) -> Result<LoadedPlace, String> {
    let (format, is_place) = FileFormat::from_path(path).ok_or_else(|| {
        "Unsupported file extension. Must be .rbxl, .rbxlx, .rbxm, or .rbxmx".to_string()
    })?;
    let (modified, len) = file_stamp(path);
    let dom = load_dom(path, format)?;
    let scan = scan_dom(&dom, props);
    Ok(LoadedPlace {
        path: path.to_path_buf(),
        modified,
        len,
        format,
        is_place,
        dom,
        records: scan.records,
        aliases: scan.aliases,
        instance_count: scan.instance_count,
    })
}

// ---------------------------------------------------------------------------
// Scanning (mirrors plugin/src/scan/*.luau)
// ---------------------------------------------------------------------------

pub(crate) struct DomScan {
    pub records: Vec<StudioRecord>,
    pub aliases: AliasMap,
    pub instance_count: usize,
}

fn asset_reference_patterns() -> &'static [Regex] {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        [
            r"^rbxassetid://(\d+)",
            r"^rbxasset://(\d+)",
            r"^id=(\d+)",
            r"[?&]id=(\d+)",
            r"roblox\.com/asset/\?id=(\d+)",
            r"roblox\.com/library/(\d+)",
            r"roblox\.com/catalog/(\d+)",
            r"create\.roblox\.com/marketplace/asset/(\d+)",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("asset reference pattern is a valid constant"))
        .collect()
    })
}

fn is_repeating_digits(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() => value.len() > 1 && chars.all(|c| c == first),
        _ => false,
    }
}

/// Port of `stringContainsAssetReference` (which also covers `isAssetFormat`
/// for string values).
fn contains_asset_reference(value: &str) -> bool {
    let lower = value.to_lowercase();
    for pattern in asset_reference_patterns() {
        if let Some(id) = pattern.captures(&lower).and_then(|c| c.get(1)) {
            return !is_repeating_digits(id.as_str());
        }
    }
    let len = lower.len();
    if (7..=20).contains(&len) && lower.chars().all(|c| c.is_ascii_digit()) {
        return !is_repeating_digits(&lower);
    }
    false
}

/// Port of `contentValueToString`, extended with the binary string types that
/// only exist offline.
fn variant_to_string(value: &Variant) -> Option<String> {
    let text = match value {
        Variant::String(s) => s.clone(),
        Variant::ContentId(c) => c.as_str().to_string(),
        Variant::Content(c) => c.as_uri()?.to_string(),
        Variant::BinaryString(b) => std::str::from_utf8(b.as_ref()).ok()?.to_string(),
        Variant::SharedString(s) => std::str::from_utf8(s.data()).ok()?.to_string(),
        _ => return None,
    };
    if text.is_empty() || text == "nil" || text.contains("16666666666666") {
        return None;
    }
    Some(text)
}

fn max_record_bytes(property: &str) -> usize {
    match property {
        "Source" => MAX_SCRIPT_SOURCE_BYTES,
        "Text" | "PlaceholderText" | "ToolTip" | "Value" => MAX_RECORD_TEXT_VALUE_BYTES,
        _ => MAX_RECORD_VALUE_BYTES,
    }
}

/// Instance-level special cases from `scanSpecialInstanceAssets`. The plugin
/// uses `IsA`; offline we match the concrete classes (and their subclasses).
fn special_properties(class: &str) -> &'static [&'static str] {
    match class {
        "HumanoidDescription" => &[
            "Face",
            "Head",
            "LeftArm",
            "LeftLeg",
            "RightArm",
            "RightLeg",
            "Torso",
            "GraphicTShirt",
            "Pants",
            "Shirt",
        ],
        "PackageLink" => &["PackageId", "AssetId"],
        "SurfaceAppearance" | "MaterialVariant" => {
            &["ColorMap", "MetalnessMap", "NormalMap", "RoughnessMap"]
        }
        "CharacterMesh" => &["MeshId", "BaseTextureId", "OverlayTextureId"],
        "Decal" | "Texture" | "ParticleEmitter" | "Beam" | "Trail" => &["Texture"],
        "SpecialMesh" | "FileMesh" => &["MeshId", "TextureId"],
        "MeshPart" => &["MeshId", "MeshContent", "TextureID"],
        "Animation" => &["AnimationId", "AnimationContent"],
        "Sound" => &["SoundId", "AudioContent"],
        "ImageLabel" | "ImageButton" => &["Image", "HoverImage", "PressedImage"],
        "VideoFrame" => &["Video"],
        "AudioPlayer" | "AudioEmitter" | "AudioDeviceInput" => &["Asset", "AssetId"],
        "Shirt" => &["ShirtTemplate"],
        "Pants" => &["PantsTemplate"],
        "ShirtGraphic" => &["Graphic"],
        "Sky" => &[
            "SkyboxBk",
            "SkyboxDn",
            "SkyboxFt",
            "SkyboxLf",
            "SkyboxRt",
            "SkyboxUp",
            "SunTextureId",
            "MoonTextureId",
        ],
        "WrapTarget" | "WrapLayer" => &["ReferenceMeshId", "CageMeshId"],
        _ => &[],
    }
}

fn is_script_class(class: &str) -> bool {
    matches!(class, "Script" | "LocalScript" | "ModuleScript")
}

/// rbx_dom migrates many legacy `ContentId` properties to new `Content`
/// properties when loading a file (e.g. `Sound.SoundId` -> `AudioContent`).
/// Records use the Studio-facing legacy name so the analysis/patch planning
/// behaves exactly like it does for plugin scans.
fn legacy_property_name(class: &str, dom_name: &str) -> String {
    let mapped = match dom_name {
        "AnimationContent" => "AnimationId",
        "AudioContent" if class == "Sound" => "SoundId",
        "AudioContent" => "AudioContent",
        "MeshContent" => "MeshId",
        "TextureContent" => match class {
            "MeshPart" => "TextureID",
            "SpecialMesh" | "FileMesh" | "Tool" | "HopperBin" => "TextureId",
            _ => "Texture",
        },
        "SkyboxBackContent" => "SkyboxBk",
        "SkyboxDownContent" => "SkyboxDn",
        "SkyboxFrontContent" => "SkyboxFt",
        "SkyboxLeftContent" => "SkyboxLf",
        "SkyboxRightContent" => "SkyboxRt",
        "SkyboxUpContent" => "SkyboxUp",
        "SunTextureContent" => "SunTextureId",
        "MoonTextureContent" => "MoonTextureId",
        "BaseTextureContent" => "BaseTextureId",
        "OverlayTextureContent" => "OverlayTextureId",
        "ReferenceMeshContent" => "ReferenceMeshId",
        "CageMeshContent" => "CageMeshId",
        other => match other.strip_suffix("Content") {
            Some(base) if !base.is_empty() => base,
            _ => other,
        },
    };
    mapped.to_string()
}

pub(crate) type AliasMap = HashMap<(String, String), Ustr>;

struct Scanner<'a> {
    props: &'a ApiDumpProperties,
    records: Vec<StudioRecord>,
    record_keys: HashSet<(String, String, u64)>,
    /// (token, record property) -> actual DOM property name, when they differ.
    aliases: AliasMap,
}

struct InstanceView<'a> {
    instance: &'a rbx_dom_weak::Instance,
    token: String,
    full_name: &'a str,
    /// legacy (Studio) name -> DOM name for migrated Content properties.
    legacy: HashMap<String, Ustr>,
    scanned: HashSet<Ustr>,
}

impl InstanceView<'_> {
    fn resolve(&self, property: &str) -> Option<Ustr> {
        let direct = ustr(property);
        if self.instance.properties.contains_key(&direct) {
            return Some(direct);
        }
        self.legacy.get(property).copied()
    }
}

impl Scanner<'_> {
    fn add_record(&mut self, view: &InstanceView<'_>, property: &str, value: String) {
        if property.is_empty() || value.is_empty() || value.len() > max_record_bytes(property) {
            return;
        }
        let value_hash = {
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            value.hash(&mut hasher);
            hasher.finish()
        };
        if !self.record_keys.insert((view.token.clone(), property.to_string(), value_hash)) {
            return;
        }
        self.records.push(StudioRecord {
            token: view.token.clone(),
            class_name: view.instance.class.to_string(),
            name: view.instance.name.clone(),
            full_name: view.full_name.to_string(),
            property: property.to_string(),
            value,
        });
    }

    /// Reads `property` (Studio name) and records it. With `require_reference`
    /// the value must look like an asset reference (string-scan semantics);
    /// otherwise any non-empty value is captured (`captureProperty`).
    fn capture(&mut self, view: &mut InstanceView<'_>, property: &str, require_reference: bool) {
        if property == "Name" {
            let name = view.instance.name.clone();
            if !name.is_empty() && (!require_reference || contains_asset_reference(&name)) {
                self.add_record(view, "Name", name);
            }
            return;
        }
        let Some(dom_name) = view.resolve(property) else {
            return;
        };
        if !view.scanned.insert(dom_name) {
            return;
        }
        let Some(text) = view.instance.properties.get(&dom_name).and_then(variant_to_string) else {
            return;
        };
        if require_reference && !contains_asset_reference(&text) {
            return;
        }
        if dom_name.as_str() != property {
            self.aliases.insert((view.token.clone(), property.to_string()), dom_name);
        }
        self.add_record(view, property, text);
    }

    fn process(&mut self, instance: &rbx_dom_weak::Instance, full_name: &str) {
        let class = instance.class.as_str();
        let legacy = instance
            .properties
            .iter()
            .filter(|(_, value)| matches!(value, Variant::Content(_) | Variant::ContentId(_)))
            .filter_map(|(dom_name, _)| {
                let legacy = legacy_property_name(class, dom_name.as_str());
                (legacy != dom_name.as_str()).then_some((legacy, *dom_name))
            })
            .collect();
        let mut view = InstanceView {
            instance,
            token: instance.referent().to_string(),
            full_name,
            legacy,
            scanned: HashSet::new(),
        };

        // Attributes (string values only, like the plugin).
        if let Some(Variant::Attributes(attributes)) = instance.properties.get(&ustr("Attributes"))
        {
            for (key, value) in attributes.iter() {
                if let Some(text) = variant_to_string(value) {
                    if contains_asset_reference(&text) {
                        let property = format!("{ATTRIBUTE_PREFIX}{key}");
                        self.add_record(&view, &property, text);
                    }
                }
            }
        }

        // Tags.
        if let Some(Variant::Tags(tags)) = instance.properties.get(&ustr("Tags")) {
            let list: Vec<&str> = tags.iter().collect();
            let valid = !list.is_empty()
                && list.len() <= MAX_TAGS_PER_OBJECT
                && list.iter().all(|tag| !tag.is_empty() && tag.len() <= MAX_TAG_BYTES);
            if valid && list.iter().any(|tag| contains_asset_reference(tag)) {
                if let Ok(encoded) = serde_json::to_string(&list) {
                    self.add_record(&view, "__Tags__", encoded);
                }
            }
        }

        // HumanoidDescription emotes / accessories (serialized blobs).
        if class == "HumanoidDescription" {
            for (source_prop, pseudo) in
                [(EMOTES_PROPERTY, "__Emotes__"), (ACCESSORIES_PROPERTY, "__Accessories__")]
            {
                let key = ustr(source_prop);
                view.scanned.insert(key);
                if let Some(text) = instance.properties.get(&key).and_then(variant_to_string) {
                    if text.chars().any(|c| c.is_ascii_digit()) {
                        self.add_record(&view, pseudo, text);
                    }
                }
            }
        }

        // Special instance assets + API dump asset properties: captured as-is.
        let props = self.props;
        let from_dump = props.asset_properties.get(class).into_iter().flatten().map(String::as_str);
        for property in special_properties(class).iter().copied().chain(from_dump) {
            self.capture(&mut view, property, false);
        }

        // Bundled string-scan properties: only when they contain an asset reference.
        if let Some(string_props) = props.string_scan_properties.get(class) {
            for property in string_props {
                if !EMBEDDED_ASSET_PROPS.contains(&property.as_str()) {
                    self.capture(&mut view, property, true);
                }
            }
        }

        // Offline extra: any remaining Content / ContentId property is an asset
        // slot by definition (covers properties missing from the API dump).
        let remaining: Vec<String> = instance
            .properties
            .iter()
            .filter(|(dom_name, value)| {
                matches!(value, Variant::Content(_) | Variant::ContentId(_))
                    && !view.scanned.contains(*dom_name)
            })
            .map(|(dom_name, _)| legacy_property_name(class, dom_name.as_str()))
            .collect();
        for property in remaining {
            self.capture(&mut view, &property, false);
        }

        // StringValue.Value
        if class == "StringValue" {
            self.capture(&mut view, "Value", true);
        }

        // Script sources.
        if is_script_class(class) {
            self.capture(&mut view, "Source", false);
        }

        // Embedded string assets (Text, Name, ...). Like the plugin these are
        // checked even if already captured; duplicates are dropped by key.
        for property in EMBEDDED_ASSET_PROPS {
            if property == "Name" {
                self.capture(&mut view, property, true);
                continue;
            }
            let Some(dom_name) = view.resolve(property) else {
                continue;
            };
            if let Some(text) = instance.properties.get(&dom_name).and_then(variant_to_string) {
                if contains_asset_reference(&text) {
                    if dom_name.as_str() != property {
                        self.aliases.insert((view.token.clone(), property.to_string()), dom_name);
                    }
                    self.add_record(&view, property, text);
                }
            }
        }
    }
}

/// Walks every instance under the DOM root (depth-first, same order as the
/// plugin) and emits plugin-compatible records. `fullName` is dotted like
/// `Instance:GetFullName()` (the DataModel root is omitted).
pub(crate) fn scan_dom(dom: &WeakDom, props: &ApiDumpProperties) -> DomScan {
    let mut scanner = Scanner {
        props,
        records: Vec::new(),
        record_keys: HashSet::new(),
        aliases: HashMap::new(),
    };
    let mut instance_count = 0usize;

    let mut stack: Vec<(Ref, String)> = dom
        .root()
        .children()
        .iter()
        .rev()
        .filter_map(|child| dom.get_by_ref(*child).map(|inst| (*child, inst.name.clone())))
        .collect();

    while let Some((referent, full_name)) = stack.pop() {
        let Some(instance) = dom.get_by_ref(referent) else {
            continue;
        };
        instance_count += 1;
        scanner.process(instance, &full_name);

        for child in instance.children().iter().rev() {
            if let Some(child_inst) = dom.get_by_ref(*child) {
                stack.push((*child, format!("{full_name}.{}", child_inst.name)));
            }
        }
    }

    DomScan { records: scanner.records, aliases: scanner.aliases, instance_count }
}

fn stores_json(records: &[StudioRecord]) -> Value {
    let (anims, sounds, images, meshes, script_refs) = analyze_records(records);
    json!({
        "anims": anims,
        "sounds": sounds,
        "images": images,
        "meshes": meshes,
        "scriptRefs": script_refs,
    })
}

fn scan_summary(loaded: &LoadedPlace) -> Value {
    json!({
        "fileName": loaded.path.file_name().map(|n| n.to_string_lossy().to_string()),
        "filePath": loaded.path.to_string_lossy(),
        "format": loaded.format.as_str(),
        "kind": if loaded.is_place { "place" } else { "model" },
        "instanceCount": loaded.instance_count,
        "recordCount": loaded.records.len(),
        "stores": stores_json(&loaded.records),
    })
}

pub(crate) fn scan_place_file_inner(
    path: &str,
    props: &ApiDumpProperties,
) -> Result<Value, String> {
    let canonical = canonical_path(path)?;
    let loaded = load_place(&canonical, props)?;
    let summary = scan_summary(&loaded);
    if let Ok(mut guard) = place_cache().lock() {
        *guard = Some(loaded);
    }
    Ok(summary)
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ApplyReport {
    applied: usize,
    failed: usize,
    warnings: Vec<String>,
}

impl ApplyReport {
    fn fail(&mut self, message: String) {
        self.failed += 1;
        if self.warnings.len() < 200 {
            self.warnings.push(message);
        }
    }
}

/// Replaces a string-like property while preserving its original variant
/// type (String vs ContentId vs Content vs BinaryString vs SharedString).
fn replace_string_variant(existing: &Variant, value: &str) -> Option<Variant> {
    Some(match existing {
        Variant::String(_) => Variant::String(value.to_string()),
        Variant::ContentId(_) => Variant::ContentId(ContentId::from(value)),
        Variant::Content(content) => match content.value() {
            ContentType::Uri(_) | ContentType::None => Variant::Content(Content::from_uri(value)),
            _ => return None,
        },
        Variant::BinaryString(_) => Variant::BinaryString(BinaryString::from(value.as_bytes())),
        Variant::SharedString(_) => {
            Variant::SharedString(SharedString::new(value.as_bytes().to_vec()))
        }
        _ => return None,
    })
}

fn set_string_property(
    instance: &mut rbx_dom_weak::Instance,
    property: &str,
    value: &str,
) -> Result<(), String> {
    if property == "Name" {
        instance.name = value.to_string();
        return Ok(());
    }
    let key = ustr(property);
    let existing =
        instance.properties.get(&key).ok_or_else(|| format!("property {property} not present"))?;
    let replacement = replace_string_variant(existing, value)
        .ok_or_else(|| format!("property {property} has an unsupported value type"))?;
    instance.properties.insert(key, replacement);
    Ok(())
}

fn json_value_to_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn dom_property(aliases: &AliasMap, token: &str, property: &str) -> String {
    aliases
        .get(&(token.to_string(), property.to_string()))
        .map_or_else(|| property.to_string(), |name| name.as_str().to_string())
}

/// Sets every existing DOM property among `candidates` (deduplicated).
fn set_first_existing(
    instance: &mut rbx_dom_weak::Instance,
    candidates: &[String],
    value: &str,
) -> Result<bool, String> {
    let mut seen = HashSet::new();
    let mut any = false;
    for property in candidates {
        if seen.insert(property.as_str()) && instance.properties.contains_key(&ustr(property)) {
            set_string_property(instance, property, value)?;
            any = true;
        }
    }
    Ok(any)
}

fn apply_single_patch(
    instance: &mut rbx_dom_weak::Instance,
    patch: &Value,
    aliases: &AliasMap,
    touched_mesh_parts: &mut usize,
) -> Result<(), String> {
    let action = patch.get("action").and_then(Value::as_str).unwrap_or_default();
    let token = patch.get("token").and_then(Value::as_str).unwrap_or_default();
    let text = patch.get("value").and_then(json_value_to_text);
    match action {
        "setProperty" => {
            let property = patch
                .get("property")
                .and_then(Value::as_str)
                .ok_or("setProperty without property")?;
            let dom_name = dom_property(aliases, token, property);
            set_string_property(instance, &dom_name, &text.ok_or("setProperty without value")?)
        }
        "replaceScriptSource" => {
            set_string_property(instance, "Source", &text.ok_or("missing script source")?)
        }
        "replaceEmotes" => {
            set_string_property(instance, EMOTES_PROPERTY, &text.ok_or("missing emotes")?)
        }
        "replaceAccessories" => {
            set_string_property(instance, ACCESSORIES_PROPERTY, &text.ok_or("missing accessories")?)
        }
        "replaceTags" => {
            let encoded = text.ok_or("missing tags")?;
            let tags: Vec<String> =
                serde_json::from_str(&encoded).map_err(|e| format!("invalid tags JSON: {e}"))?;
            instance.properties.insert(ustr("Tags"), Variant::Tags(Tags::from(tags)));
            Ok(())
        }
        "replaceAttribute" => {
            let name = patch
                .get("property")
                .and_then(Value::as_str)
                .ok_or("replaceAttribute without attribute name")?;
            let new_text = text.ok_or("missing attribute value")?;
            let key = ustr("Attributes");
            let Some(Variant::Attributes(attributes)) = instance.properties.get(&key) else {
                return Err("instance has no attributes".into());
            };
            let existing =
                attributes.get(name).ok_or_else(|| format!("attribute {name} not present"))?;
            let replacement = replace_string_variant(existing, &new_text)
                .ok_or_else(|| format!("attribute {name} is not a string"))?;
            let mut updated = attributes.clone();
            updated.insert(name.to_string(), replacement);
            instance.properties.insert(key, Variant::Attributes(updated));
            Ok(())
        }
        "replaceMeshPart" => {
            let mut changed = false;
            if let Some(mesh_id) = patch.get("meshId").and_then(json_value_to_text) {
                let candidates = [
                    dom_property(aliases, token, "MeshId"),
                    dom_property(aliases, token, "MeshContent"),
                    "MeshId".to_string(),
                    "MeshContent".to_string(),
                ];
                if !set_first_existing(instance, &candidates, &format!("rbxassetid://{mesh_id}"))? {
                    return Err("MeshPart has no MeshId property".into());
                }
                changed = true;
            }
            if let Some(texture_id) = patch.get("textureId").and_then(json_value_to_text) {
                let candidates = [
                    dom_property(aliases, token, "TextureID"),
                    "TextureID".to_string(),
                    "TextureContent".to_string(),
                ];
                let uri = format!("rbxassetid://{texture_id}");
                if !set_first_existing(instance, &candidates, &uri)? {
                    return Err("MeshPart has no TextureID property".into());
                }
                changed = true;
            }
            if changed {
                *touched_mesh_parts += 1;
                Ok(())
            } else {
                Err("replaceMeshPart without ids".into())
            }
        }
        other => Err(format!("unsupported patch action {other}")),
    }
}

fn apply_patches(dom: &mut WeakDom, patches: &[Value], aliases: &AliasMap) -> ApplyReport {
    let mut report = ApplyReport::default();
    let tokens: HashMap<String, Ref> =
        dom.descendants().map(|inst| (inst.referent().to_string(), inst.referent())).collect();
    let mut touched_mesh_parts = 0usize;

    for patch in patches {
        let token = patch.get("token").and_then(Value::as_str).unwrap_or_default();
        let full_name = patch.get("fullName").and_then(Value::as_str).unwrap_or(token);
        let action = patch.get("action").and_then(Value::as_str).unwrap_or("?");
        let Some(instance) = tokens.get(token).and_then(|r| dom.get_by_ref_mut(*r)) else {
            report.fail(format!("{action} on {full_name}: instance not found"));
            continue;
        };
        match apply_single_patch(instance, patch, aliases, &mut touched_mesh_parts) {
            Ok(()) => report.applied += 1,
            Err(error) => report.fail(format!("{action} on {full_name}: {error}")),
        }
    }

    if touched_mesh_parts > 0 {
        report.warnings.push(format!(
            "{touched_mesh_parts} MeshPart(s) had MeshId/TextureID replaced offline. Collision/physics data is not regenerated; open the file in Studio (or re-run the plugin) if collisions look wrong."
        ));
    }
    report
}

fn default_output_path(source: &Path) -> PathBuf {
    let stem = source.file_stem().map_or_else(|| "place".into(), |s| s.to_string_lossy());
    let ext = source.extension().map_or_else(|| "rbxl".into(), |e| e.to_string_lossy());
    source.with_file_name(format!("{stem}.spoofed.{ext}"))
}

fn resolve_output_path(source: &Path, output_path: Option<&str>) -> Result<PathBuf, String> {
    let Some(raw) = output_path.map(str::trim).filter(|p| !p.is_empty()) else {
        return Ok(default_output_path(source));
    };
    let candidate = PathBuf::from(raw);
    if candidate.is_dir() {
        let file_name = default_output_path(source)
            .file_name()
            .map(std::ffi::OsStr::to_os_string)
            .ok_or("Invalid source file name")?;
        return Ok(candidate.join(file_name));
    }
    Ok(candidate)
}

fn write_dom(dom: &WeakDom, format: FileFormat, output: &Path) -> Result<(), String> {
    if let Some(parent) = output.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp_name = output.file_name().map(std::ffi::OsStr::to_os_string).unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = output.with_file_name(tmp_name);

    let result = (|| {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(file);
        let refs = dom.root().children();
        match format {
            FileFormat::Binary => rbx_binary::to_writer(&mut writer, dom, refs)
                .map_err(|e| format!("Failed to encode binary file: {e}"))?,
            FileFormat::Xml => rbx_xml::to_writer_default(&mut writer, dom, refs)
                .map_err(|e| format!("Failed to encode XML file: {e}"))?,
        }
        std::io::Write::flush(&mut writer).map_err(|e| e.to_string())?;
        drop(writer);
        std::fs::rename(&tmp, output).map_err(|e| e.to_string())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// `plan_patches` re-emits whole-text rewrites (script sources, tags, ...)
/// whenever the text contains any id-looking number, even if nothing mapped.
/// Offline we drop those so `patchesApplied` only counts real changes.
fn drop_noop_patches(records: &[StudioRecord], patches: Vec<Value>) -> Vec<Value> {
    let originals: HashMap<(&str, &str), &str> = records
        .iter()
        .map(|r| ((r.token.as_str(), r.property.as_str()), r.value.as_str()))
        .collect();
    patches
        .into_iter()
        .filter(|patch| {
            let property = match patch.get("action").and_then(Value::as_str) {
                Some("replaceScriptSource") => "Source",
                Some("replaceTags") => "__Tags__",
                Some("replaceEmotes") => "__Emotes__",
                Some("replaceAccessories") => "__Accessories__",
                _ => return true,
            };
            let token = patch.get("token").and_then(Value::as_str).unwrap_or_default();
            let new_value = patch.get("value").and_then(Value::as_str);
            originals.get(&(token, property)).copied() != new_value
        })
        .collect()
}

fn take_cached_place(path: &Path) -> Option<LoadedPlace> {
    let mut guard = place_cache().lock().ok()?;
    let cached = guard.as_ref()?;
    let (modified, len) = file_stamp(path);
    if cached.path == path && cached.modified == modified && cached.len == len {
        return guard.take();
    }
    None
}

pub(crate) fn write_spoofed_place_file_inner(
    path: &str,
    output_path: Option<&str>,
    mappings: &AnyValue,
    props: &ApiDumpProperties,
) -> Result<Value, String> {
    let source = canonical_path(path)?;
    let parsed_mappings = crate::commands::studio::parse_replacements_map(mappings);
    if parsed_mappings.is_empty() {
        return Err("No valid id mappings were provided".into());
    }

    let output = resolve_output_path(&source, output_path)?;
    let output_is_source = std::fs::canonicalize(&output).is_ok_and(|existing| existing == source);
    if output_is_source && output_path.is_none() {
        return Err("Refusing to overwrite the source file".into());
    }

    let mut warnings = Vec::new();
    let mut loaded = match take_cached_place(&source) {
        Some(cached) => cached,
        None => load_place(&source, props)?,
    };

    if let Some((out_format, _)) = FileFormat::from_path(&output) {
        if out_format != loaded.format {
            warnings.push(format!(
                "Output extension does not match the input format; the file was written as {} anyway.",
                loaded.format.as_str()
            ));
        }
    }

    let patches =
        drop_noop_patches(&loaded.records, plan_patches(&loaded.records, &parsed_mappings));
    let report = apply_patches(&mut loaded.dom, &patches, &loaded.aliases);
    warnings.extend(report.warnings);

    if report.applied == 0 {
        warnings.push("No patches applied; none of the mapped ids were found in this file.".into());
    }

    write_dom(&loaded.dom, loaded.format, &output)?;

    Ok(json!({
        "outputPath": output.to_string_lossy(),
        "patchesApplied": report.applied,
        "patchesFailed": report.failed,
        "warnings": warnings,
    }))
}

/// Scans a place/model file offline and returns the same asset stores the
/// Studio bridge exposes through `get_studio_asset_snapshots`.
#[tauri::command]
#[specta::specta]
pub async fn scan_place_file_assets(path: String) -> crate::error::Result<AnyValue> {
    let props = crate::api_dump::get_api_dump_properties().await;
    let result = tokio::task::spawn_blocking(move || scan_place_file_inner(&path, &props))
        .await
        .map_err(|e| format!("Place scan task failed: {e}"))??;
    Ok(AnyValue(result))
}

/// Writes a copy of the place/model file with the given id mappings applied.
/// Defaults to `<stem>.spoofed.<ext>` next to the source file.
#[tauri::command]
#[specta::specta]
pub async fn write_spoofed_place_file(
    path: String,
    output_path: Option<String>,
    mappings: AnyValue,
) -> crate::error::Result<AnyValue> {
    let props = crate::api_dump::get_api_dump_properties().await;
    let result = tokio::task::spawn_blocking(move || {
        write_spoofed_place_file_inner(&path, output_path.as_deref(), &mappings, &props)
    })
    .await
    .map_err(|e| format!("Place write task failed: {e}"))??;
    Ok(AnyValue(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rbx_dom_weak::types::Attributes;
    use rbx_dom_weak::InstanceBuilder;

    fn sample_dom() -> WeakDom {
        let attributes = Attributes::new()
            .with("RunAnim", Variant::String("rbxassetid://5550001111".to_string()))
            .with("Speed", Variant::Float32(3.0));
        let mut dom = WeakDom::new(InstanceBuilder::new("DataModel"));
        let root = dom.root_ref();
        dom.insert(
            root,
            InstanceBuilder::new("Workspace").with_name("Workspace").with_children([
                InstanceBuilder::new("Animation")
                    .with_name("Wave")
                    .with_property("AnimationId", ContentId::from("rbxassetid://1234567890"))
                    .with_property("Attributes", attributes),
                InstanceBuilder::new("Sound")
                    .with_name("Music")
                    .with_property("SoundId", ContentId::from("rbxassetid://2345678901")),
                InstanceBuilder::new("MeshPart")
                    .with_name("Rock")
                    .with_property("MeshId", ContentId::from("rbxassetid://4445556667"))
                    .with_property("TextureID", ContentId::from("rbxassetid://7778889990")),
                InstanceBuilder::new("Decal")
                    .with_name("Logo")
                    .with_property("Texture", ContentId::from("rbxassetid://6667778889"))
                    .with_property("Tags", Tags::from(vec!["rbxassetid://3334445556".to_string()])),
                InstanceBuilder::new("StringValue")
                    .with_name("AnimRef")
                    .with_property("Value", "rbxassetid://1234567890"),
            ]),
        );
        dom.insert(
            root,
            InstanceBuilder::new("ServerScriptService").with_name("ServerScriptService").with_child(
                InstanceBuilder::new("Script").with_name("Main").with_property(
                    "Source",
                    "local anim = Instance.new('Animation')\nanim.AnimationId = \"rbxassetid://1234567890\"\nlocal id = 123\n",
                ),
            ),
        );
        dom
    }

    fn write_sample(dir: &Path, name: &str, format: FileFormat) -> PathBuf {
        let dom = sample_dom();
        let path = dir.join(name);
        write_dom(&dom, format, &path).expect("write sample");
        path
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("trapspoofer-place-file-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn find<'a>(records: &'a [StudioRecord], full_name: &str, property: &str) -> &'a StudioRecord {
        records
            .iter()
            .find(|r| r.full_name == full_name && r.property == property)
            .unwrap_or_else(|| panic!("missing record {full_name} {property}"))
    }

    #[test]
    fn scan_emits_plugin_style_records() {
        let dom = sample_dom();
        let scan = scan_dom(&dom, &ApiDumpProperties::default());
        assert_eq!(scan.instance_count, 8);

        let anim = find(&scan.records, "Workspace.Wave", "AnimationId");
        assert_eq!(anim.class_name, "Animation");
        assert_eq!(anim.value, "rbxassetid://1234567890");
        let attr = find(&scan.records, "Workspace.Wave", "__Attribute__:RunAnim");
        assert_eq!(attr.value, "rbxassetid://5550001111");
        find(&scan.records, "Workspace.Music", "SoundId");
        find(&scan.records, "ServerScriptService.Main", "Source");
        assert!(!scan.records.iter().any(|r| r.property == "__Attribute__:Speed"));
    }

    #[test]
    fn contains_asset_reference_matches_plugin_rules() {
        assert!(contains_asset_reference("rbxassetid://1234"));
        assert!(contains_asset_reference("https://www.roblox.com/asset/?id=987654"));
        assert!(contains_asset_reference("1234567890"));
        assert!(!contains_asset_reference("1111111111"));
        assert!(!contains_asset_reference("123456"));
        assert!(!contains_asset_reference("hello world"));
    }

    fn round_trip(format: FileFormat, file_name: &str) {
        let dir = temp_dir(format.as_str());
        let source = write_sample(&dir, file_name, format);
        let props = ApiDumpProperties::default();

        let summary =
            scan_place_file_inner(source.to_str().expect("utf8 path"), &props).expect("scan");
        assert_eq!(summary["format"], format.as_str());
        let stores = &summary["stores"];
        assert_eq!(stores["anims"]["complete"], true);
        assert_eq!(stores["anims"]["scanning"], false);
        let anim_ids: Vec<&str> = stores["anims"]["assets"]
            .as_array()
            .expect("anims array")
            .iter()
            .filter_map(|a| a["assetId"].as_str())
            .collect();
        assert!(anim_ids.contains(&"1234567890"), "anims: {anim_ids:?}");
        assert!(stores["sounds"]["assets"]
            .as_array()
            .expect("sounds array")
            .iter()
            .any(|a| a["assetId"] == "2345678901"));

        let mappings = AnyValue(json!({
            "1234567890": "9876543210",
            "2345678901": "8765432109",
            "5550001111": "5550002222",
            "4445556667": "4445556668",
            "6667778889": "6667778880",
            "3334445556": "3334445557",
        }));
        let result =
            write_spoofed_place_file_inner(source.to_str().expect("utf8"), None, &mappings, &props)
                .expect("write");
        assert_eq!(result["patchesFailed"], 0, "{result}");
        assert!(result["patchesApplied"].as_u64().unwrap_or(0) >= 5, "{result}");
        let output = PathBuf::from(result["outputPath"].as_str().expect("output path"));
        assert_ne!(output, source);
        assert!(output.file_name().expect("name").to_string_lossy().contains(".spoofed."));

        let dom = load_dom(&output, format).expect("reload output");
        let scan = scan_dom(&dom, &props);
        assert_eq!(
            find(&scan.records, "Workspace.Wave", "AnimationId").value,
            "rbxassetid://9876543210"
        );
        assert_eq!(
            find(&scan.records, "Workspace.Music", "SoundId").value,
            "rbxassetid://8765432109"
        );
        assert_eq!(
            find(&scan.records, "Workspace.Wave", "__Attribute__:RunAnim").value,
            "rbxassetid://5550002222"
        );
        assert_eq!(
            find(&scan.records, "Workspace.Rock", "MeshId").value,
            "rbxassetid://4445556668"
        );
        assert_eq!(
            find(&scan.records, "Workspace.Logo", "Texture").value,
            "rbxassetid://6667778880"
        );
        assert_eq!(
            find(&scan.records, "Workspace.Logo", "__Tags__").value,
            r#"["rbxassetid://3334445557"]"#
        );
        assert_eq!(
            find(&scan.records, "Workspace.AnimRef", "Value").value,
            "rbxassetid://9876543210"
        );
        let source_text = &find(&scan.records, "ServerScriptService.Main", "Source").value;
        assert!(source_text.contains("rbxassetid://9876543210"));
        assert!(!source_text.contains("1234567890"));
        assert!(source_text.contains("local id = 123"));

        // Types are preserved (the loaded DOM stores AnimationContent as Content).
        let wave = dom.descendants().find(|inst| inst.name == "Wave").expect("wave instance");
        assert!(matches!(
            wave.properties.get(&ustr("AnimationContent")),
            Some(Variant::Content(_))
        ));
        assert!(result["warnings"]
            .as_array()
            .expect("warnings")
            .iter()
            .any(|w| w.as_str().is_some_and(|w| w.contains("MeshPart"))));

        // Source untouched.
        let original = load_dom(&source, format).expect("reload source");
        let original_scan = scan_dom(&original, &props);
        assert_eq!(
            find(&original_scan.records, "Workspace.Wave", "AnimationId").value,
            "rbxassetid://1234567890"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn round_trip_binary_place() {
        round_trip(FileFormat::Binary, "sample.rbxl");
    }

    #[test]
    fn round_trip_xml_model() {
        round_trip(FileFormat::Xml, "sample.rbxmx");
    }

    #[test]
    fn write_without_cache_reloads_file_and_accepts_array_mappings() {
        let dir = temp_dir("nocache");
        let source = write_sample(&dir, "array.rbxm", FileFormat::Binary);
        let out = dir.join("custom-out.rbxm");
        let mappings = AnyValue(json!([{ "originalId": "2345678901", "newId": "1112223334" }]));
        let result = write_spoofed_place_file_inner(
            source.to_str().expect("utf8"),
            Some(out.to_str().expect("utf8")),
            &mappings,
            &ApiDumpProperties::default(),
        )
        .expect("write");
        assert_eq!(result["patchesApplied"], 1, "{result}");
        let dom = load_dom(&out, FileFormat::Binary).expect("reload");
        let scan = scan_dom(&dom, &ApiDumpProperties::default());
        assert_eq!(
            find(&scan.records, "Workspace.Music", "SoundId").value,
            "rbxassetid://1112223334"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unknown_extension_and_empty_mappings() {
        let dir = temp_dir("errors");
        let bogus = dir.join("file.txt");
        std::fs::write(&bogus, "hello").expect("write bogus");
        let props = ApiDumpProperties::default();
        assert!(scan_place_file_inner(bogus.to_str().expect("utf8"), &props).is_err());
        assert_eq!(
            scan_place_file_inner(dir.join("missing.rbxl").to_str().expect("utf8"), &props)
                .expect_err("missing"),
            "File does not exist"
        );
        let source = write_sample(&dir, "e.rbxl", FileFormat::Binary);
        assert!(write_spoofed_place_file_inner(
            source.to_str().expect("utf8"),
            None,
            &AnyValue(json!({})),
            &props
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
