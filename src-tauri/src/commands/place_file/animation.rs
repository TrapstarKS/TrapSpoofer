//! Import native animation trees without rebuilding keyframes or curve data.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use futures::{stream, StreamExt};
use rbx_dom_weak::types::{Attributes, ContentType, Ref, Tags, Variant};
use rbx_dom_weak::{ustr, Instance, InstanceBuilder, Ustr, WeakDom};
use serde_json::Value;
use tauri::Manager;

use super::{
    dom_property, json_value_to_text, replace_string_variant, variant_to_string, AliasMap,
    FileFormat,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AnimationMode {
    Id,
    Replace,
    Parent,
    ParentId,
}

impl AnimationMode {
    pub(super) fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("animation") {
            "animation" => Ok(Self::Id),
            "clip_replace" => Ok(Self::Replace),
            "clip_parent" => Ok(Self::Parent),
            "clip_parent_id" => Ok(Self::ParentId),
            _ => Err("Invalid animation replacement mode.".into()),
        }
    }

    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Id => "animation",
            Self::Replace => "clip_replace",
            Self::Parent => "clip_parent",
            Self::ParentId => "clip_parent_id",
        }
    }
}

type ClipKey = (String, String);
pub(super) type ClipResults = HashMap<ClipKey, Result<NativeClip, String>>;

pub(super) struct NativeClip {
    dom: WeakDom,
    root: Ref,
    source_id: String,
}

fn asset_id(value: &str) -> Option<String> {
    let value = value.trim();
    let numeric = |id: &str| {
        !id.is_empty()
            && id.len() <= 20
            && id != "0"
            && id.bytes().all(|byte| byte.is_ascii_digit())
    };
    if numeric(value) {
        return Some(value.to_string());
    }
    let lower = value.to_ascii_lowercase();
    super::asset_reference_patterns().iter().find_map(|pattern| {
        let captures = pattern.captures(&lower)?;
        let id = captures.get(1)?.as_str();
        numeric(id).then(|| id.to_string())
    })
}

fn patch_key(patch: &Value) -> Result<ClipKey, String> {
    let original = patch["expectedValue"]
        .as_str()
        .and_then(asset_id)
        .ok_or("Animation patch has no valid original asset ID")?;
    let replacement = patch
        .get("value")
        .and_then(json_value_to_text)
        .as_deref()
        .and_then(asset_id)
        .ok_or("Animation patch has no valid replacement asset ID")?;
    Ok((original, replacement))
}

fn subtree_refs(dom: &WeakDom, root: Ref) -> Vec<Ref> {
    let mut refs = Vec::new();
    let mut queue = VecDeque::from([root]);
    while let Some(referent) = queue.pop_front() {
        if let Some(instance) = dom.get_by_ref(referent) {
            refs.push(referent);
            queue.extend(instance.children().iter().copied());
        }
    }
    refs
}

fn has_clip_data(dom: &WeakDom, root: Ref) -> bool {
    let Some(clip) = dom.get_by_ref(root) else {
        return false;
    };
    match clip.class.as_str() {
        "KeyframeSequence" => clip.children().iter().any(|referent| {
            dom.get_by_ref(*referent).is_some_and(|instance| instance.class.as_str() == "Keyframe")
        }),
        "CurveAnimation" => subtree_refs(dom, root).iter().any(|referent| {
            dom.get_by_ref(*referent).is_some_and(|instance| {
                matches!(
                    instance.class.as_str(),
                    "FloatCurve" | "Vector3Curve" | "EulerRotationCurve" | "RotationCurve"
                )
            })
        }),
        _ => false,
    }
}

fn existing_clip_parent<'a>(dom: &'a WeakDom, original: &Instance) -> Option<&'a Instance> {
    let parent = dom.get_by_ref(original.parent())?;
    if !matches!(parent.class.as_str(), "KeyframeSequence" | "CurveAnimation") {
        return None;
    }
    let Some(Variant::Attributes(attributes)) = parent.properties.get(&ustr("Attributes")) else {
        return None;
    };
    (attributes.get("TrapSpooferClipContainer") == Some(&Variant::Bool(true))).then_some(parent)
}

fn validate_references(value: &Variant, inside: &HashSet<Ref>) -> Result<(), String> {
    let reference = match value {
        Variant::Ref(reference) => Some(*reference),
        Variant::Content(content) => content.as_object(),
        Variant::Attributes(attributes) => {
            for (_, value) in attributes.iter() {
                validate_references(value, inside)?;
            }
            None
        }
        _ => None,
    };
    if reference.is_some_and(|reference| reference.is_some() && !inside.contains(&reference)) {
        return Err(
            "references an instance outside the native clip; cannot import it losslessly".into()
        );
    }
    Ok(())
}

fn remap_references(value: &mut Variant, mapping: &HashMap<Ref, Ref>) {
    match value {
        Variant::Ref(reference) => {
            if let Some(replacement) = mapping.get(reference) {
                *reference = *replacement;
            }
        }
        Variant::Content(content) => {
            if let ContentType::Object(reference) = content.value_mut() {
                if let Some(replacement) = mapping.get(reference) {
                    *reference = *replacement;
                }
            }
        }
        Variant::Attributes(attributes) => {
            let mut remapped = Attributes::new();
            for (key, value) in attributes.iter() {
                let mut value = value.clone();
                remap_references(&mut value, mapping);
                remapped.insert(key.clone(), value);
            }
            *attributes = remapped;
        }
        _ => {}
    }
}

impl NativeClip {
    fn parse(bytes: &[u8], source_id: &str) -> Result<Self, String> {
        let dom = if bytes.starts_with(b"<roblox!") {
            rbx_binary::from_reader(bytes)
                .map_err(|error| format!("Invalid binary animation: {error}"))?
        } else {
            rbx_xml::from_reader(
                bytes,
                rbx_xml::DecodeOptions::new()
                    .property_behavior(rbx_xml::DecodePropertyBehavior::ReadUnknown),
            )
            .map_err(|error| format!("Invalid XML animation: {error}"))?
        };
        let candidates: Vec<Ref> = dom
            .descendants()
            .filter(|instance| {
                matches!(instance.class.as_str(), "KeyframeSequence" | "CurveAnimation")
            })
            .map(Instance::referent)
            .collect();
        let [root] = candidates.as_slice() else {
            return Err(format!("Expected one native animation clip, found {}", candidates.len()));
        };
        let root = *root;
        let refs = subtree_refs(&dom, root);
        if !has_clip_data(&dom, root) {
            return Err("Roblox returned an empty native animation clip".into());
        }
        let inside: HashSet<Ref> = refs.into_iter().collect();
        for referent in &inside {
            let instance = dom.get_by_ref(*referent).ok_or("Native clip descendant is missing")?;
            for (name, value) in &instance.properties {
                validate_references(value, &inside)
                    .map_err(|error| format!("{}.{} {error}", instance.name, name))?;
            }
        }
        Ok(Self { dom, root, source_id: source_id.to_string() })
    }

    /// Stage the entire native subtree before touching the destination. The
    /// library clones every property and child and rewrites Ref properties;
    /// Content::Object additionally needs explicit remapping in rbx_dom_weak 4.
    fn stage(&self) -> (WeakDom, Ref) {
        let mut staged = WeakDom::new(InstanceBuilder::new("DataModel"));
        let root = self.dom.clone_into_external(self.root, &mut staged);
        staged.transfer_within(root, staged.root_ref());
        let mut mapping = HashMap::new();
        let mut queue = VecDeque::from([(self.root, root)]);
        while let Some((source, dest)) = queue.pop_front() {
            mapping.insert(source, dest);
            let original = self.dom.get_by_ref(source).expect("validated source subtree");
            let copy = staged.get_by_ref(dest).expect("cloned subtree");
            queue.extend(original.children().iter().copied().zip(copy.children().iter().copied()));
        }
        for referent in mapping.values() {
            let instance = staged.get_by_ref_mut(*referent).expect("cloned subtree");
            for value in instance.properties.values_mut() {
                remap_references(value, &mapping);
            }
        }
        (staged, root)
    }
}

fn cached_clip(directory: &Path, id: &str) -> Result<Option<NativeClip>, String> {
    let mut errors = Vec::new();
    for extension in ["rbxm", "rbxmx", "xml"] {
        let path = directory.join(format!("{id}.{extension}"));
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(error.to_string());
                continue;
            }
        };
        match NativeClip::parse(&bytes, id) {
            Ok(clip) => return Ok(Some(clip)),
            Err(error) => errors.push(error),
        }
    }
    if errors.is_empty() {
        Ok(None)
    } else {
        Err(errors.join("; "))
    }
}

async fn load_clip(
    app: &tauri::AppHandle,
    id: &str,
    cookie: Option<String>,
    place_id: Option<String>,
) -> Result<NativeClip, String> {
    let directory = app.path().app_data_dir().ok().map(|path| path.join("downloads/animations"));
    if let Some(directory) = directory {
        let cache_id = id.to_string();
        if let Ok(Ok(Some(clip))) =
            tokio::task::spawn_blocking(move || cached_clip(&directory, &cache_id)).await
        {
            return Ok(clip);
        }
    }
    let xml =
        crate::commands::assets::fetch_animation_xml(app.clone(), id.to_string(), cookie, place_id)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!("Roblox did not return an accessible animation clip for {id}")
            })?;
    let id = id.to_string();
    tokio::task::spawn_blocking(move || NativeClip::parse(xml.as_bytes(), &id))
        .await
        .map_err(|error| format!("Animation decode task failed: {error}"))?
}

fn clip_requests(dom: &WeakDom, patches: &[Value]) -> HashSet<ClipKey> {
    let animations: HashMap<String, &Instance> = dom
        .descendants()
        .filter(|instance| instance.class.as_str() == "Animation")
        .map(|instance| (instance.referent().to_string(), instance))
        .collect();
    patches
        .iter()
        .filter(|patch| patch["action"] == "replaceAnimationClip")
        .filter(|patch| {
            animations
                .get(patch["token"].as_str().unwrap_or_default())
                .is_some_and(|original| existing_clip_parent(dom, original).is_none())
        })
        .filter_map(|patch| patch_key(patch).ok())
        .collect()
}

pub(super) async fn resolve_clips(
    app: &tauri::AppHandle,
    dom: &WeakDom,
    patches: &[Value],
    cookie: Option<String>,
    place_id: Option<String>,
) -> ClipResults {
    // Previously exported containers already hold the authoritative, possibly
    // edited native data. Incompatible containers fail locally during apply.
    let keys = clip_requests(dom, patches);
    stream::iter(keys).map(|key| {
        let cookie = cookie.clone();
        let place_id = place_id.clone();
        async move {
            let result = match load_clip(app, &key.0, cookie.clone(), place_id.clone()).await {
                Ok(clip) => Ok(clip),
                Err(original_error) if key.0 != key.1 => {
                    load_clip(app, &key.1, cookie, place_id).await.map_err(|replacement_error| {
                        format!("Original clip {}: {original_error}; replacement clip {}: {replacement_error}. Original Animation preserved.", key.0, key.1)
                    })
                }
                Err(error) => Err(error),
            };
            (key, result)
        }
    }).buffer_unordered(4).collect().await
}

pub(super) fn fallback_warnings(clips: &ClipResults) -> Vec<String> {
    clips.iter().filter_map(|((original, _), result)| {
        let clip = result.as_ref().ok()?;
        (clip.source_id != *original).then(|| format!(
            "Original animation {original} was unavailable; native data came from replacement asset {}.", clip.source_id
        ))
    }).collect()
}

/// rbx_xml 3.0 panics on Content::Object instead of returning an encoder
/// error. Reject it before opening the output or mutating an Animation.
pub(crate) fn ensure_xml_serializable(dom: &WeakDom) -> Result<(), String> {
    fn has_object_content(value: &Variant) -> bool {
        match value {
            Variant::Content(content) => content.as_object().is_some(),
            Variant::Attributes(attributes) => {
                attributes.iter().any(|(_, value)| has_object_content(value))
            }
            _ => false,
        }
    }
    for instance in dom.descendants() {
        for (property, value) in &instance.properties {
            if has_object_content(value) {
                return Err(format!(
                    "{}.{} contains Content::Object, which the XML encoder cannot preserve. Use RBXM/RBXL for this clip; original Animation preserved.",
                    instance.name, property
                ));
            }
        }
    }
    Ok(())
}

/// Keep the original download before the upload pipeline removes its working
/// file. This is also used for custom download directories: the export cache
/// remains in the existing app-data animation cache, so no new IPC path is needed.
pub(crate) async fn cache_animation_source(
    app: &tauri::AppHandle,
    source: &str,
    id: &str,
) -> Result<(), String> {
    let id = asset_id(id).ok_or("Invalid original animation asset ID")?;
    let directory =
        app.path().app_data_dir().map_err(|error| error.to_string())?.join("downloads/animations");
    let source = PathBuf::from(source);
    let parse_id = id.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(source).map_err(|error| error.to_string())?;
        NativeClip::parse(&bytes, &parse_id)?;
        Ok::<_, String>(bytes)
    })
    .await
    .map_err(|error| format!("Animation cache task failed: {error}"))??;
    tokio::fs::create_dir_all(&directory).await.map_err(|error| error.to_string())?;
    let output = directory.join(format!("{id}.rbxm"));
    let temporary = directory.join(format!("{id}.{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        tokio::fs::write(&temporary, bytes).await?;
        tokio::fs::rename(&temporary, output).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result.map_err(|error| error.to_string())
}

struct AnimationMetadata {
    name: String,
    properties: HashMap<Ustr, Variant>,
}

impl From<&Instance> for AnimationMetadata {
    fn from(instance: &Instance) -> Self {
        Self {
            name: instance.name.clone(),
            properties: instance
                .properties
                .iter()
                .map(|(key, value)| (*key, value.clone()))
                .collect(),
        }
    }
}

fn inherit_metadata(
    clip: &mut Instance,
    original: &AnimationMetadata,
    replacement: bool,
    asset: &str,
    fresh: bool,
) {
    if fresh {
        clip.name = original.name.clone();
    }
    if replacement {
        for (name, value) in &original.properties {
            if !matches!(name.as_str(), "AnimationId" | "AnimationContent" | "Attributes" | "Tags")
                && (fresh || !clip.properties.contains_key(name))
            {
                clip.properties.insert(*name, value.clone());
            }
        }
    }
    let mut attributes = match clip.properties.get(&ustr("Attributes")) {
        Some(Variant::Attributes(attributes)) => attributes.clone(),
        _ => Attributes::new(),
    };
    if let Some(Variant::Attributes(original)) = original.properties.get(&ustr("Attributes")) {
        for (key, value) in original.iter() {
            if attributes.get(key.as_str()).is_none() {
                attributes.insert(key.clone(), value.clone());
            }
        }
    }
    attributes.insert("TrapSpooferClipAssetId".to_string(), Variant::String(asset.to_string()));
    attributes.insert("TrapSpooferClipContainer".to_string(), Variant::Bool(!replacement));
    clip.properties.insert(ustr("Attributes"), Variant::Attributes(attributes));
    let mut tags = match clip.properties.get(&ustr("Tags")) {
        Some(Variant::Tags(tags)) => tags.iter().map(str::to_string).collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    if let Some(Variant::Tags(original)) = original.properties.get(&ustr("Tags")) {
        for tag in original.iter() {
            if !tags.iter().any(|existing| existing == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    if !tags.is_empty() {
        clip.properties.insert(ustr("Tags"), Variant::Tags(Tags::from(tags)));
    }
}

fn reuse_clip_parent(
    dom: &mut WeakDom,
    target: Ref,
    wrapper: Ref,
    key: &ClipKey,
    mode: AnimationMode,
    id_updates: Vec<(Ustr, Variant)>,
    format: FileFormat,
) -> Result<(), String> {
    let parent = dom.get_by_ref(wrapper).ok_or("Native clip parent is missing")?;
    let tracked_asset = match parent.properties.get(&ustr("Attributes")) {
        Some(Variant::Attributes(attributes)) => attributes
            .get("TrapSpooferClipAssetId")
            .and_then(variant_to_string)
            .as_deref()
            .and_then(asset_id),
        _ => None,
    };
    if tracked_asset.as_ref() != Some(&key.0) && tracked_asset.as_ref() != Some(&key.1) {
        return Err(
            "Existing native clip belongs to a different asset; original Animation preserved"
                .into(),
        );
    }
    if !has_clip_data(dom, wrapper) {
        return Err(
            "Existing native clip has no animation data; original Animation preserved".into()
        );
    }
    if format == FileFormat::Xml {
        ensure_xml_serializable(dom)?;
    }
    let original = dom.get_by_ref(target).ok_or("Animation instance is missing")?;
    let metadata = AnimationMetadata::from(original);
    let children = original.children().to_vec();
    inherit_metadata(
        dom.get_by_ref_mut(wrapper).expect("validated parent"),
        &metadata,
        mode == AnimationMode::Replace,
        &key.1,
        false,
    );
    if mode == AnimationMode::Replace {
        for child in children {
            dom.transfer_within(child, wrapper);
        }
        let mapping = HashMap::from([(target, wrapper)]);
        let referents = dom.descendants().map(Instance::referent).collect::<Vec<_>>();
        for referent in referents {
            for value in
                dom.get_by_ref_mut(referent).expect("live instance").properties.values_mut()
            {
                remap_references(value, &mapping);
            }
        }
        dom.destroy(target);
    } else {
        let original = dom.get_by_ref_mut(target).expect("validated Animation");
        for (property, value) in id_updates {
            original.properties.insert(property, value);
        }
    }
    Ok(())
}

pub(super) fn apply_clip_patch(
    dom: &mut WeakDom,
    target: Ref,
    patch: &Value,
    aliases: &AliasMap,
    clips: &ClipResults,
    format: FileFormat,
) -> Result<(), String> {
    let mode = AnimationMode::parse(patch["animationMode"].as_str())?;
    if mode == AnimationMode::Id {
        return Err("Native clip patch requires a clip replacement mode".into());
    }
    let key = patch_key(patch)?;
    let original = dom.get_by_ref(target).ok_or("Animation instance not found")?;
    if original.class.as_str() != "Animation" {
        return Err("Target is not an Animation; scan the file again".into());
    }
    let token = patch["token"].as_str().unwrap_or_default();
    let property = patch["property"].as_str().unwrap_or("AnimationId");
    let property = dom_property(aliases, token, property);
    let current_id = original
        .properties
        .get(&ustr(&property))
        .and_then(variant_to_string)
        .as_deref()
        .and_then(asset_id);
    if current_id.as_ref() != Some(&key.0) && current_id.as_ref() != Some(&key.1) {
        return Err("Animation changed since the scan; original Animation preserved".into());
    }
    let original_parent = original.parent();
    if dom.get_by_ref(original_parent).is_none() {
        return Err("Animation parent is missing".into());
    }
    let mut id_updates = Vec::new();
    if mode == AnimationMode::ParentId {
        for name in ["AnimationId", "AnimationContent"] {
            if let Some(existing) = original.properties.get(&ustr(name)) {
                let replacement =
                    replace_string_variant(existing, &format!("rbxassetid://{}", key.1))
                        .ok_or_else(|| {
                            format!(
                                "Animation {name} cannot be updated; original Animation preserved"
                            )
                        })?;
                id_updates.push((ustr(name), replacement));
            }
        }
        if id_updates.is_empty() {
            return Err("Animation has no writable animation ID".into());
        }
    }
    if let Some(parent) = existing_clip_parent(dom, original) {
        return reuse_clip_parent(dom, target, parent.referent(), &key, mode, id_updates, format);
    }
    let clip = clips
        .get(&key)
        .ok_or("Native clip was not loaded; original Animation preserved")?
        .as_ref()
        .map_err(Clone::clone)?;
    let (mut staged, staged_root) = clip.stage();
    if mode == AnimationMode::Replace {
        let root_mapping = HashMap::from([(staged_root, target)]);
        for referent in subtree_refs(&staged, staged_root) {
            for value in
                staged.get_by_ref_mut(referent).expect("staged subtree").properties.values_mut()
            {
                remap_references(value, &root_mapping);
            }
        }
    }
    let staged_clip = staged.get_by_ref_mut(staged_root).expect("staged clip root");
    inherit_metadata(
        staged_clip,
        &AnimationMetadata::from(original),
        mode == AnimationMode::Replace,
        &key.1,
        true,
    );
    if format == FileFormat::Xml {
        ensure_xml_serializable(&staged)?;
    }

    // Everything fallible is complete. Transfers preserve the entire native
    // subtree, including opaque curve payloads and internal property references.
    if mode == AnimationMode::Replace {
        let staged_clip = staged.get_by_ref(staged_root).expect("staged clip root");
        let target_clip = dom.get_by_ref_mut(target).expect("validated Animation");
        target_clip.class = staged_clip.class;
        target_clip.properties = staged_clip.properties.clone();
        let children = staged_clip.children().to_vec();
        for child in children {
            staged.transfer(child, dom, target);
        }
        // Keep the original referent and children. ObjectValue/Content references
        // from elsewhere in the file now resolve to the native clip itself.
    } else {
        staged.transfer(staged_root, dom, original_parent);
        let original = dom.get_by_ref_mut(target).expect("validated Animation");
        for (property, value) in id_updates {
            original.properties.insert(property, value);
        }
        dom.transfer_within(target, staged_root);
    }
    Ok(())
}

#[cfg(test)]
mod tests;
