use super::super::{finish_place_write, load_dom, prepare_place_write, write_dom};
use super::*;
use crate::api_dump::ApiDumpProperties;
use crate::commands::AnyValue;
use rbx_dom_weak::types::{BinaryString, CFrame, Content, ContentId, Enum, Matrix3, Vector3};
use serde_json::json;

const ORIGINAL: &str = "1234567890";
const REPLACEMENT: &str = "9876543210";

struct FixtureDir(PathBuf);

impl FixtureDir {
    fn new() -> Self {
        let directory =
            std::env::temp_dir().join(format!("trapspoofer-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("fixture directory");
        Self(directory)
    }
}

impl Drop for FixtureDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn instance<'a>(dom: &'a WeakDom, name: &str) -> &'a Instance {
    dom.descendants().find(|instance| instance.name == name).expect("fixture instance")
}

fn source_dom() -> WeakDom {
    let mut dom = WeakDom::new(InstanceBuilder::new("DataModel"));
    let storage = dom.insert(dom.root_ref(), InstanceBuilder::new("ReplicatedStorage"));
    let animations = dom.insert(storage, InstanceBuilder::new("Folder").with_name("Animations"));
    let animation = dom.insert(
        animations,
        InstanceBuilder::new("Animation")
            .with_name("Walk")
            .with_property("AnimationId", ContentId::from(format!("rbxassetid://{ORIGINAL}")))
            .with_property(
                "Attributes",
                Attributes::new()
                    .with("AnimationAsset", "rbxassetid://3456789012")
                    .with("Speed", 2.5_f32)
                    .with("SharedLabel", "original"),
            )
            .with_property(
                "Tags",
                Tags::from(vec!["original-tag".to_string(), "rbxassetid://4567890123".to_string()]),
            )
            .with_child(
                InstanceBuilder::new("StringValue")
                    .with_name("ExistingChild")
                    .with_property("Value", "kept"),
            ),
    );
    dom.insert(
        animation,
        InstanceBuilder::new("ObjectValue")
            .with_name("ExistingSelfLink")
            .with_property("Value", animation),
    );
    dom.insert(
        storage,
        InstanceBuilder::new("ObjectValue")
            .with_name("ExternalLink")
            .with_property("Value", animation),
    );
    dom.insert(
        storage,
        InstanceBuilder::new("Sound")
            .with_name("Sound")
            .with_property("SoundId", ContentId::from("rbxassetid://2345678901")),
    );
    dom.insert(
        storage,
        InstanceBuilder::new("Script")
            .with_name("Script")
            .with_property("Source", format!("local id = '{ORIGINAL}'\nlocal unchanged = 7")),
    );
    dom
}

fn clip_dom(class: &str, object_content: bool) -> WeakDom {
    let mut dom = WeakDom::new(InstanceBuilder::new("DataModel"));
    let clip = dom.insert(
        dom.root_ref(),
        InstanceBuilder::new(class)
            .with_name("NativeSource")
            .with_property("Loop", true)
            .with_property("Priority", Enum::from_u32(2))
            .with_property(
                "Attributes",
                Attributes::new().with("Author", "native-author").with("SharedLabel", "native"),
            )
            .with_property("Tags", Tags::from(vec!["native-tag".to_string()]))
            .with_property("FutureNativeData", BinaryString::from(vec![0_u8, 31, 128, 255])),
    );
    let data = if class == "KeyframeSequence" {
        dom.insert(
            clip,
            InstanceBuilder::new("Keyframe")
                .with_name("Frame")
                .with_property("Time", 0.125_f32)
                .with_child(
                    InstanceBuilder::new("Pose")
                        .with_name("RootPose")
                        .with_property(
                            "CFrame",
                            CFrame::new(Vector3::new(1.0, 2.0, 3.0), Matrix3::identity()),
                        )
                        .with_property("Weight", 0.75_f32)
                        .with_property("EasingStyle", Enum::from_u32(1))
                        .with_property("EasingDirection", Enum::from_u32(1))
                        .with_child(
                            InstanceBuilder::new("Pose")
                                .with_name("ArmPose")
                                .with_property("Weight", 0.5_f32),
                        ),
                )
                .with_child(
                    InstanceBuilder::new("KeyframeMarker")
                        .with_name("Impact")
                        .with_property("Value", "marker payload"),
                ),
        )
    } else {
        let rig = dom.insert(clip, InstanceBuilder::new("Folder").with_name("Rig"));
        // Opaque byte sentinels prove the exporter does not reconstruct curves.
        dom.insert(
            rig,
            InstanceBuilder::new("FloatCurve")
                .with_name("CurveX")
                .with_property(
                    "ValuesAndTimes",
                    BinaryString::from(vec![1_u8, 0, 0, 0, 255, 27, 128, 64]),
                )
                .with_property("FutureCurveData", BinaryString::from(vec![9_u8, 0, 11, 250])),
        )
    };
    dom.insert(
        clip,
        InstanceBuilder::new("ObjectValue").with_name("ClipSelf").with_property("Value", clip),
    );
    dom.insert(
        clip,
        InstanceBuilder::new("ObjectValue").with_name("DataLink").with_property("Value", data),
    );
    if object_content {
        dom.get_by_ref_mut(clip)
            .expect("clip")
            .properties
            .insert(ustr("NativeContent"), Variant::Content(Content::from_referent(data)));
    }
    dom
}

fn encode(dom: &WeakDom, format: FileFormat) -> Vec<u8> {
    let mut bytes = Vec::new();
    match format {
        FileFormat::Binary => {
            rbx_binary::to_writer(&mut bytes, dom, dom.root().children()).expect("binary fixture")
        }
        FileFormat::Xml => rbx_xml::to_writer(
            &mut bytes,
            dom,
            dom.root().children(),
            rbx_xml::EncodeOptions::new()
                .property_behavior(rbx_xml::EncodePropertyBehavior::WriteUnknown),
        )
        .expect("XML fixture"),
    }
    bytes
}

fn mappings() -> AnyValue {
    AnyValue(json!({
        "1234567890": REPLACEMENT,
        "2345678901": "8765432109",
        "3456789012": "7654321098",
        "4567890123": "6543210987",
    }))
}

fn id_of(instance: &Instance) -> Option<String> {
    ["AnimationContent", "AnimationId"]
        .iter()
        .find_map(|key| instance.properties.get(&ustr(key)).and_then(variant_to_string))
        .as_deref()
        .and_then(asset_id)
}

fn assert_native_preserved(expected: &NativeClip, actual: &WeakDom, root: Ref) {
    let mut mapping = HashMap::new();
    let mut queue = VecDeque::from([(expected.root, root)]);
    while let Some((source_ref, dest_ref)) = queue.pop_front() {
        mapping.insert(source_ref, dest_ref);
        let source = expected.dom.get_by_ref(source_ref).expect("source");
        let dest = actual.get_by_ref(dest_ref).expect("destination");
        assert_eq!(source.class, dest.class);
        for child_ref in source.children() {
            let child = expected.dom.get_by_ref(*child_ref).expect("native child");
            let copied = dest
                .children()
                .iter()
                .filter_map(|referent| actual.get_by_ref(*referent))
                .find(|candidate| candidate.name == child.name && candidate.class == child.class)
                .expect("native child retained with hierarchy and class");
            queue.push_back((*child_ref, copied.referent()));
        }
    }
    for (source_ref, dest_ref) in &mapping {
        let source = expected.dom.get_by_ref(*source_ref).expect("source");
        let dest = actual.get_by_ref(*dest_ref).expect("destination");
        for (property, value) in &source.properties {
            if matches!(property.as_str(), "UniqueId" | "HistoryId") {
                continue;
            }
            match value {
                Variant::Attributes(attributes) => {
                    let Some(Variant::Attributes(copied)) = dest.properties.get(property) else {
                        panic!("attributes retained")
                    };
                    for (key, value) in attributes.iter() {
                        assert_eq!(copied.get(key.as_str()), Some(value), "native attribute {key}");
                    }
                }
                Variant::Tags(tags) => {
                    let Some(Variant::Tags(copied)) = dest.properties.get(property) else {
                        panic!("tags retained")
                    };
                    for tag in tags.iter() {
                        assert!(copied.iter().any(|candidate| candidate == tag));
                    }
                }
                _ => {
                    let mut value = value.clone();
                    remap_references(&mut value, &mapping);
                    assert_eq!(
                        dest.properties.get(property),
                        Some(&value),
                        "{}.{}",
                        source.name,
                        property
                    );
                }
            }
        }
    }
}

fn round_trip(extension: &str, format: FileFormat, object_content: bool) {
    let directory = FixtureDir::new();
    let source = directory.0.join(format!("source.{extension}"));
    write_dom(&source_dom(), format, &source).expect("source fixture");
    let original_bytes = std::fs::read(&source).expect("original file bytes");
    for class in ["KeyframeSequence", "CurveAnimation"] {
        for mode in [
            AnimationMode::Id,
            AnimationMode::Replace,
            AnimationMode::Parent,
            AnimationMode::ParentId,
        ] {
            let clip_format = if object_content || format == FileFormat::Xml {
                FileFormat::Binary
            } else {
                FileFormat::Xml
            };
            let bytes = encode(&clip_dom(class, object_content), clip_format);
            let expected = NativeClip::parse(&bytes, ORIGINAL).expect("native fixture");
            let prepared = prepare_place_write(
                source.to_str().expect("path"),
                None,
                &mappings(),
                &ApiDumpProperties::default(),
                mode,
            )
            .expect("prepare");
            let mut clips = ClipResults::new();
            if mode != AnimationMode::Id {
                clips.insert(
                    (ORIGINAL.into(), REPLACEMENT.into()),
                    NativeClip::parse(&bytes, ORIGINAL),
                );
            }
            let result = finish_place_write(prepared, &clips).expect("export");
            assert_eq!(result["patchesFailed"], 0, "{mode:?} {class} {result}");
            assert!(result["patchesApplied"].as_u64().expect("applied count") >= 4);
            let output =
                load_dom(Path::new(result["outputPath"].as_str().expect("output")), format)
                    .expect("reload output");
            let external = instance(&output, "ExternalLink");
            let Some(Variant::Ref(original_ref)) = external.properties.get(&ustr("Value")) else {
                panic!("external reference")
            };
            let target = output.get_by_ref(*original_ref).expect("inbound reference remains live");
            let existing_child = instance(&output, "ExistingChild");
            assert_eq!(existing_child.parent(), target.referent());
            assert_eq!(
                existing_child.properties.get(&ustr("Value")),
                Some(&Variant::String("kept".into()))
            );
            assert_eq!(
                instance(&output, "ExistingSelfLink").properties.get(&ustr("Value")),
                Some(&Variant::Ref(target.referent()))
            );
            let native_root = match mode {
                AnimationMode::Id => {
                    assert_eq!(target.class.as_str(), "Animation");
                    assert_eq!(id_of(target).as_deref(), Some(REPLACEMENT));
                    assert_eq!(
                        output.descendants().filter(|item| item.class.as_str() == class).count(),
                        0
                    );
                    None
                }
                AnimationMode::Replace => {
                    assert_eq!(target.class.as_str(), class);
                    assert!(id_of(target).is_none());
                    assert_eq!(
                        output.get_by_ref(target.parent()).expect("parent").name,
                        "Animations"
                    );
                    Some(target)
                }
                AnimationMode::Parent | AnimationMode::ParentId => {
                    assert_eq!(target.class.as_str(), "Animation");
                    assert_eq!(
                        id_of(target).as_deref(),
                        Some(if mode == AnimationMode::Parent { ORIGINAL } else { REPLACEMENT })
                    );
                    let native = output.get_by_ref(target.parent()).expect("native parent");
                    assert_eq!(native.class.as_str(), class);
                    assert_eq!(
                        output.get_by_ref(native.parent()).expect("outer parent").name,
                        "Animations"
                    );
                    Some(native)
                }
            };
            let metadata = native_root.unwrap_or(target);
            let Some(Variant::Attributes(attributes)) =
                metadata.properties.get(&ustr("Attributes"))
            else {
                panic!("metadata")
            };
            assert_eq!(
                attributes.get("AnimationAsset").and_then(variant_to_string).as_deref(),
                Some("rbxassetid://7654321098")
            );
            assert!(matches!(attributes.get("AnimationAsset"), Some(Variant::BinaryString(_))));
            assert_eq!(attributes.get("Speed"), Some(&Variant::Float32(2.5)));
            let Some(Variant::Tags(tags)) = metadata.properties.get(&ustr("Tags")) else {
                panic!("tags")
            };
            assert!(tags.iter().any(|tag| tag == "rbxassetid://6543210987"));
            assert!(tags.iter().any(|tag| tag == "original-tag"));
            if let Some(native) = native_root {
                assert_native_preserved(&expected, &output, native.referent());
            }
            let sound = instance(&output, "Sound");
            assert!(sound.properties.values().any(
                |value| variant_to_string(value).as_deref() == Some("rbxassetid://8765432109")
            ));
            let script = instance(&output, "Script");
            assert!(variant_to_string(script.properties.get(&ustr("Source")).expect("source"))
                .expect("script text")
                .contains(REPLACEMENT));
            assert_eq!(std::fs::read(&source).expect("source remains"), original_bytes);
        }
    }
}

#[test]
fn native_round_trip_rbxm() {
    round_trip("rbxm", FileFormat::Binary, false);
}

#[test]
fn native_round_trip_rbxl() {
    round_trip("rbxl", FileFormat::Binary, false);
}

#[test]
fn native_round_trip_rbxmx() {
    round_trip("rbxmx", FileFormat::Xml, false);
}

#[test]
fn native_round_trip_rbxlx() {
    round_trip("rbxlx", FileFormat::Xml, false);
}

#[test]
fn binary_round_trip_preserves_content_object_references() {
    round_trip("rbxm", FileFormat::Binary, true);
    round_trip("rbxl", FileFormat::Binary, true);
}

#[test]
fn failed_clip_preserves_animation_and_applies_other_mappings() {
    for extension in ["rbxm", "rbxl", "rbxmx", "rbxlx"] {
        let directory = FixtureDir::new();
        let source = directory.0.join(format!("source.{extension}"));
        let (format, _) = FileFormat::from_path(&source).expect("format");
        write_dom(&source_dom(), format, &source).expect("source");
        for mode in [AnimationMode::Replace, AnimationMode::Parent, AnimationMode::ParentId] {
            let prepared = prepare_place_write(
                source.to_str().expect("path"),
                None,
                &mappings(),
                &ApiDumpProperties::default(),
                mode,
            )
            .expect("prepare");
            let clips = HashMap::from([(
                (ORIGINAL.into(), REPLACEMENT.into()),
                Err("fixture download failure".into()),
            )]);
            let result = finish_place_write(prepared, &clips).expect("partial output");
            assert_eq!(result["patchesFailed"], 1, "{result}");
            assert!(result["patchesApplied"].as_u64().expect("applied") > 0);
            assert!(result["warnings"].to_string().contains("fixture download failure"));
            let output = load_dom(Path::new(result["outputPath"].as_str().expect("path")), format)
                .expect("output");
            let original = instance(&output, "Walk");
            assert_eq!(original.class.as_str(), "Animation");
            assert_eq!(id_of(original).as_deref(), Some(ORIGINAL));
            assert_eq!(output.get_by_ref(original.parent()).expect("parent").name, "Animations");
            assert_eq!(instance(&output, "ExistingChild").parent(), original.referent());
        }
    }
}

#[test]
fn xml_reports_content_object_limitation_without_mutation_or_panic() {
    let directory = FixtureDir::new();
    let source = directory.0.join("source.rbxmx");
    write_dom(&source_dom(), FileFormat::Xml, &source).expect("source");
    let bytes = encode(&clip_dom("CurveAnimation", true), FileFormat::Binary);
    for mode in [AnimationMode::Replace, AnimationMode::Parent, AnimationMode::ParentId] {
        let prepared = prepare_place_write(
            source.to_str().expect("path"),
            None,
            &mappings(),
            &ApiDumpProperties::default(),
            mode,
        )
        .expect("prepare");
        let clips = HashMap::from([(
            (ORIGINAL.into(), REPLACEMENT.into()),
            NativeClip::parse(&bytes, ORIGINAL),
        )]);
        let result = finish_place_write(prepared, &clips).expect("partial output");
        assert_eq!(result["patchesFailed"], 1, "{result}");
        assert!(result["warnings"].to_string().contains("Content::Object"));
        let output =
            load_dom(Path::new(result["outputPath"].as_str().expect("path")), FileFormat::Xml)
                .expect("output");
        assert_eq!(id_of(instance(&output, "Walk")).as_deref(), Some(ORIGINAL));
    }
    let protected = directory.0.join("protected.rbxmx");
    std::fs::write(&protected, b"existing output").expect("existing output");
    let error = write_dom(&clip_dom("CurveAnimation", true), FileFormat::Xml, &protected)
        .expect_err("unsupported XML");
    assert!(error.contains("Content::Object"));
    assert_eq!(std::fs::read(&protected).expect("protected output"), b"existing output");
}

#[test]
fn rejects_empty_ambiguous_and_externally_referencing_clips() {
    for format in [FileFormat::Binary, FileFormat::Xml] {
        let mut empty = WeakDom::new(InstanceBuilder::new("DataModel"));
        empty.insert(
            empty.root_ref(),
            InstanceBuilder::new("KeyframeSequence").with_child(InstanceBuilder::new("Folder")),
        );
        assert!(NativeClip::parse(&encode(&empty, format), ORIGINAL)
            .err()
            .expect("invalid clip")
            .contains("empty"));
        let mut ambiguous = clip_dom("KeyframeSequence", false);
        ambiguous.insert(
            ambiguous.root_ref(),
            InstanceBuilder::new("CurveAnimation").with_child(InstanceBuilder::new("FloatCurve")),
        );
        assert!(NativeClip::parse(&encode(&ambiguous, format), ORIGINAL)
            .err()
            .expect("ambiguous clip")
            .contains("found 2"));
        let mut external = clip_dom("KeyframeSequence", false);
        let outside = external
            .insert(external.root_ref(), InstanceBuilder::new("Folder").with_name("Outside"));
        let link = instance(&external, "DataLink").referent();
        external
            .get_by_ref_mut(link)
            .expect("link")
            .properties
            .insert(ustr("Value"), Variant::Ref(outside));
        assert!(NativeClip::parse(&encode(&external, format), ORIGINAL)
            .err()
            .expect("external ref")
            .contains("outside the native clip"));
    }
    assert!(NativeClip::parse(b"not an animation", ORIGINAL).is_err());
}

#[test]
fn cache_prefers_native_original_bytes_and_accepts_xml_with_binary_extension() {
    let directory = FixtureDir::new();
    std::fs::write(
        directory.0.join(format!("{ORIGINAL}.rbxm")),
        encode(&clip_dom("CurveAnimation", false), FileFormat::Xml),
    )
    .expect("native cache");
    std::fs::write(
        directory.0.join(format!("{ORIGINAL}.xml")),
        encode(&clip_dom("KeyframeSequence", false), FileFormat::Xml),
    )
    .expect("preview cache");
    let cached = cached_clip(&directory.0, ORIGINAL).expect("cache read").expect("cached clip");
    assert_eq!(
        cached.dom.get_by_ref(cached.root).expect("native root").class.as_str(),
        "CurveAnimation"
    );
    assert!(cached_clip(&directory.0, REPLACEMENT).expect("missing cache").is_none());
}

#[test]
fn rejects_unknown_mode_and_explains_replacement_asset_fallback() {
    assert_eq!(AnimationMode::parse(None).expect("legacy mode"), AnimationMode::Id);
    assert!(AnimationMode::parse(Some("clip_typo")).is_err());
    let bytes = encode(&clip_dom("KeyframeSequence", false), FileFormat::Binary);
    let clips = HashMap::from([(
        (ORIGINAL.into(), REPLACEMENT.into()),
        NativeClip::parse(&bytes, REPLACEMENT),
    )]);
    let warnings = fallback_warnings(&clips);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].contains(ORIGINAL) && warnings[0].contains(REPLACEMENT));
}

#[test]
fn reopened_parent_reuses_edited_native_data_across_modes_without_downloading() {
    for extension in ["rbxm", "rbxl", "rbxmx", "rbxlx"] {
        for class in ["KeyframeSequence", "CurveAnimation"] {
            let directory = FixtureDir::new();
            let source = directory.0.join(format!("source.{extension}"));
            let (format, _) = FileFormat::from_path(&source).expect("format");
            write_dom(&source_dom(), format, &source).expect("source");
            let bytes = encode(&clip_dom(class, format == FileFormat::Binary), FileFormat::Binary);
            let clips = HashMap::from([(
                (ORIGINAL.into(), REPLACEMENT.into()),
                NativeClip::parse(&bytes, ORIGINAL),
            )]);
            let prepared = prepare_place_write(
                source.to_str().expect("path"),
                None,
                &mappings(),
                &ApiDumpProperties::default(),
                AnimationMode::Parent,
            )
            .expect("prepare parent");
            let result = finish_place_write(prepared, &clips).expect("first parent");
            assert_eq!(result["patchesFailed"], 0);
            let mut path = PathBuf::from(result["outputPath"].as_str().expect("output path"));
            let mut edited = load_dom(&path, format).expect("reopen parent");
            let target = edited
                .descendants()
                .find(|instance| instance.class.as_str() == "Animation")
                .expect("Animation")
                .referent();
            let wrapper = edited.get_by_ref(target).expect("Animation").parent();
            let storage = instance(&edited, "ReplicatedStorage").referent();
            let native = edited.get_by_ref_mut(wrapper).expect("native parent");
            native.name = "EditedNative".into();
            native.properties.insert(ustr("Loop"), Variant::Bool(false));
            if let Some(Variant::Attributes(attributes)) =
                native.properties.get_mut(&ustr("Attributes"))
            {
                attributes.insert("Author".to_string(), Variant::String("edited-author".into()));
                attributes
                    .insert("EditorNote".to_string(), Variant::String("preserve this edit".into()));
            }
            native
                .properties
                .insert(ustr("Tags"), Variant::Tags(Tags::from(vec!["edited-tag".to_string()])));
            edited.insert(
                wrapper,
                InstanceBuilder::new("StringValue")
                    .with_name("WrapperNote")
                    .with_property("Value", "edited child"),
            );
            edited.insert(
                storage,
                InstanceBuilder::new("ObjectValue")
                    .with_name("WrapperLink")
                    .with_property("Value", wrapper),
            );
            if format == FileFormat::Binary {
                let holder = edited.get_by_ref_mut(storage).expect("storage");
                holder.properties.insert(
                    ustr("AnimationLinkContent"),
                    Variant::Content(Content::from_referent(target)),
                );
                holder.properties.insert(
                    ustr("WrapperLinkContent"),
                    Variant::Content(Content::from_referent(wrapper)),
                );
            }
            write_dom(&edited, format, &path).expect("save native edits");
            for mode in [AnimationMode::Parent, AnimationMode::ParentId, AnimationMode::Replace] {
                let map = if mode == AnimationMode::Replace {
                    AnyValue(json!({ "9876543210": "8765432199" }))
                } else {
                    AnyValue(json!({ "1234567890": REPLACEMENT }))
                };
                let prepared = prepare_place_write(
                    path.to_str().expect("path"),
                    None,
                    &map,
                    &ApiDumpProperties::default(),
                    mode,
                )
                .expect("prepare reexport");
                assert!(
                    clip_requests(&prepared.loaded.dom, &prepared.patches).is_empty(),
                    "local wrapper never downloads"
                );
                let result = finish_place_write(prepared, &ClipResults::new())
                    .expect("reexport without cache/network");
                assert_eq!(result["patchesFailed"], 0, "{extension} {class} {mode:?}: {result}");
                // The final replacement also updates the fixture's script,
                // which already contains the first replacement asset ID.
                assert_eq!(
                    result["patchesApplied"],
                    if mode == AnimationMode::Replace { 2 } else { 1 },
                    "{result}"
                );
                path = PathBuf::from(result["outputPath"].as_str().expect("output"));
                let output = load_dom(&path, format).expect("reopen reexport");
                assert_eq!(
                    output
                        .descendants()
                        .filter(|instance| matches!(
                            instance.class.as_str(),
                            "KeyframeSequence" | "CurveAnimation"
                        ))
                        .count(),
                    1
                );
                let native = instance(&output, "EditedNative");
                assert_eq!(native.class.as_str(), class);
                assert_eq!(native.properties.get(&ustr("Loop")), Some(&Variant::Bool(false)));
                assert_eq!(instance(&output, "WrapperNote").parent(), native.referent());
                assert_eq!(
                    instance(&output, "WrapperLink").properties.get(&ustr("Value")),
                    Some(&Variant::Ref(native.referent()))
                );
                assert_eq!(
                    instance(&output, "ClipSelf").properties.get(&ustr("Value")),
                    Some(&Variant::Ref(native.referent()))
                );
                let Some(Variant::Attributes(attributes)) =
                    native.properties.get(&ustr("Attributes"))
                else {
                    panic!("native attributes")
                };
                assert_eq!(
                    attributes.get("Author").and_then(variant_to_string).as_deref(),
                    Some("edited-author")
                );
                assert_eq!(
                    attributes.get("EditorNote").and_then(variant_to_string).as_deref(),
                    Some("preserve this edit")
                );
                let Some(Variant::Tags(tags)) = native.properties.get(&ustr("Tags")) else {
                    panic!("native tags")
                };
                assert!(tags.iter().any(|tag| tag == "edited-tag"));
                let retained_target = if mode == AnimationMode::Replace {
                    assert!(!output
                        .descendants()
                        .any(|instance| instance.class.as_str() == "Animation"));
                    assert_eq!(
                        attributes.get("TrapSpooferClipContainer"),
                        Some(&Variant::Bool(false))
                    );
                    native
                } else {
                    let animation = output
                        .descendants()
                        .find(|instance| instance.class.as_str() == "Animation")
                        .expect("retained Animation");
                    assert_eq!(animation.parent(), native.referent());
                    assert_eq!(
                        id_of(animation).as_deref(),
                        Some(if mode == AnimationMode::Parent { ORIGINAL } else { REPLACEMENT })
                    );
                    animation
                };
                assert_eq!(
                    instance(&output, "ExternalLink").properties.get(&ustr("Value")),
                    Some(&Variant::Ref(retained_target.referent()))
                );
                assert_eq!(instance(&output, "ExistingChild").parent(), retained_target.referent());
                assert_eq!(
                    instance(&output, "ExistingSelfLink").properties.get(&ustr("Value")),
                    Some(&Variant::Ref(retained_target.referent()))
                );
                if format == FileFormat::Binary {
                    let storage = instance(&output, "ReplicatedStorage");
                    assert_eq!(
                        storage.properties.get(&ustr("AnimationLinkContent")),
                        Some(&Variant::Content(Content::from_referent(retained_target.referent())))
                    );
                    assert_eq!(
                        storage.properties.get(&ustr("WrapperLinkContent")),
                        Some(&Variant::Content(Content::from_referent(native.referent())))
                    );
                }
            }
        }
    }
}

#[test]
fn incompatible_local_container_fails_without_downloading_or_changing_animation() {
    for extension in ["rbxm", "rbxl", "rbxmx", "rbxlx"] {
        let directory = FixtureDir::new();
        let source = directory.0.join(format!("source.{extension}"));
        let (format, _) = FileFormat::from_path(&source).expect("format");
        let mut dom = source_dom();
        let target = instance(&dom, "Walk").referent();
        let parent = dom.get_by_ref(target).expect("Animation").parent();
        let bytes = encode(&clip_dom("KeyframeSequence", false), FileFormat::Binary);
        let (mut staged, root) = NativeClip::parse(&bytes, ORIGINAL).expect("clip").stage();
        let native = staged.get_by_ref_mut(root).expect("native");
        native.properties.insert(
            ustr("Attributes"),
            Variant::Attributes(
                Attributes::new()
                    .with("TrapSpooferClipContainer", true)
                    .with("TrapSpooferClipAssetId", "1234509876"),
            ),
        );
        staged.transfer(root, &mut dom, parent);
        dom.transfer_within(target, root);
        write_dom(&dom, format, &source).expect("incompatible source");
        for mode in [AnimationMode::Parent, AnimationMode::ParentId, AnimationMode::Replace] {
            let prepared = prepare_place_write(
                source.to_str().expect("path"),
                None,
                &AnyValue(json!({ "1234567890": REPLACEMENT })),
                &ApiDumpProperties::default(),
                mode,
            )
            .expect("prepare");
            assert!(clip_requests(&prepared.loaded.dom, &prepared.patches).is_empty());
            let result =
                finish_place_write(prepared, &ClipResults::new()).expect("preserved output");
            assert_eq!(result["patchesFailed"], 1, "{result}");
            assert!(result["warnings"].to_string().contains("different asset"));
            let output =
                load_dom(Path::new(result["outputPath"].as_str().expect("output")), format)
                    .expect("reopen output");
            let animation = instance(&output, "Walk");
            assert_eq!(animation.class.as_str(), "Animation");
            assert_eq!(id_of(animation).as_deref(), Some(ORIGINAL));
            assert_eq!(output.get_by_ref(animation.parent()).expect("parent").name, "NativeSource");
            assert_eq!(
                output
                    .descendants()
                    .filter(|instance| instance.class.as_str() == "KeyframeSequence")
                    .count(),
                1
            );
        }
    }
}
