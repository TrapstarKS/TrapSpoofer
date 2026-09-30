use super::messages::StudioRecord;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn annotate_patches(
    mut patches: Vec<Value>,
    records: &[StudioRecord],
    operation_id: Option<&str>,
    animation_mode: &str,
) -> Vec<Value> {
    let animations: HashMap<(&str, &str), &str> = records
        .iter()
        .filter(|record| record.class_name == "Animation")
        .map(|record| ((record.token.as_str(), record.property.as_str()), record.value.as_str()))
        .collect();
    let mut converted = HashSet::new();
    patches.retain_mut(|patch| {
        let token = patch["token"].as_str().unwrap_or_default().to_string();
        let property = patch["property"].as_str().unwrap_or_default().to_string();
        if animation_mode != "animation"
            && patch["action"] == "setProperty"
            && matches!(property.as_str(), "AnimationId" | "AnimationContent")
        {
            if let Some(value) = animations.get(&(token.as_str(), property.as_str())).copied() {
                if !converted.insert(token) {
                    return false;
                }
                patch["action"] = json!("replaceAnimationClip");
                patch["expectedValue"] = json!(value);
            }
        }
        patch["operationId"] = json!(operation_id);
        patch["animationMode"] = json!(animation_mode);
        true
    });
    patches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::studio_bridge::messages::plan_patches;

    #[test]
    fn leaves_native_clip_metadata_out_of_scans_and_replacements() {
        let records = [StudioRecord {
            token: "clip".into(),
            class_name: "KeyframeSequence".into(),
            name: "Clip".into(),
            full_name: "Workspace.Clip".into(),
            property: "__Attribute__:TrapSpooferClipAssetId".into(),
            value: "123456789".into(),
        }];
        let mappings = [json!({"originalId": "123456789", "newId": "987654321"})];
        assert!(plan_patches(&records, &mappings).is_empty());
        let (a, b, c, d, e) = crate::studio_bridge::messages::analyze_records(&records);
        assert!([a, b, c, d, e].iter().all(|store| store.assets.is_empty()));
    }

    #[test]
    fn native_clip_modes_coalesce_animation_properties_and_preserve_other_assets() {
        let records: Vec<StudioRecord> = [
            ("animation", "Animation", "AnimationId"),
            ("animation", "Animation", "AnimationContent"),
            ("sound", "Sound", "SoundId"),
        ]
        .into_iter()
        .map(|(token, class_name, property)| StudioRecord {
            token: token.into(),
            class_name: class_name.into(),
            property: property.into(),
            name: token.into(),
            full_name: format!("Workspace.{token}"),
            value: "rbxassetid://123456789".into(),
        })
        .collect();
        let mappings = [json!({"originalId": "123456789", "newId": "987654321"})];
        for mode in ["clip_replace", "clip_parent"] {
            let patches = annotate_patches(
                plan_patches(&records, &mappings),
                &records,
                Some("operation"),
                mode,
            );
            assert_eq!(patches.len(), 2);
            assert_eq!(
                patches.iter().filter(|patch| patch["action"] == "replaceAnimationClip").count(),
                1
            );
            let clip =
                patches.iter().find(|patch| patch["token"] == "animation").expect("animation");
            assert_eq!(clip["expectedValue"], "rbxassetid://123456789");
            assert_eq!(clip["animationMode"], mode);
            assert_eq!(clip["operationId"], "operation");
            assert_eq!(
                patches.iter().find(|patch| patch["token"] == "sound").expect("sound")["action"],
                "setProperty"
            );
        }
        let normal =
            annotate_patches(plan_patches(&records, &mappings), &records, None, "animation");
        assert!(normal.iter().all(|patch| patch["action"] == "setProperty"));
    }
}
