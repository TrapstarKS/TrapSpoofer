pub(crate) fn parse_replacements_map(
    replacements_map: &crate::commands::AnyValue,
) -> Vec<serde_json::Value> {
    if let Some(arr) = replacements_map.0.as_array() {
        return arr
            .iter()
            .filter_map(|item| {
                let orig = item.get("originalId")?.as_str()?;
                let new_id = item.get("newId")?.as_str()?;
                if new_id.is_empty() || new_id == orig {
                    return None;
                }
                let mut mapping = serde_json::json!({
                    "originalId": orig,
                    "newId": new_id,
                });
                if let Some(targets) = item.get("targetPaths") {
                    mapping["targetPaths"] = targets.clone();
                }
                Some(mapping)
            })
            .collect();
    }
    replacements_map
        .0
        .as_object()
        .cloned()
        .map(|replacements| {
            replacements
                .into_iter()
                .filter_map(|(original_id, new_id)| {
                    let (new_id_str, target_paths) = if let Some(s) = new_id.as_str() {
                        (s.to_string(), None)
                    } else if let Some(n) = new_id.as_u64() {
                        (n.to_string(), None)
                    } else if let Some(n) = new_id.as_i64() {
                        (n.to_string(), None)
                    } else {
                        let obj = new_id.as_object()?;
                        let new_id_str = if let Some(s) =
                            obj.get("newId").and_then(serde_json::Value::as_str)
                        {
                            s.to_string()
                        } else if let Some(n) = obj.get("newId").and_then(serde_json::Value::as_u64)
                        {
                            n.to_string()
                        } else {
                            let n = obj.get("newId").and_then(serde_json::Value::as_i64)?;
                            n.to_string()
                        };
                        let targets = obj.get("targetPaths").cloned();
                        (new_id_str, targets)
                    };
                    if new_id_str.is_empty() || new_id_str == original_id {
                        return None;
                    }
                    let mut mapping = serde_json::json!({
                        "originalId": original_id,
                        "newId": new_id_str,
                    });
                    if let Some(targets) = target_paths {
                        mapping["targetPaths"] = targets;
                    }
                    Some(mapping)
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[tauri::command]
#[specta::specta]
pub async fn push_to_studio(
    replacements_map: crate::commands::AnyValue,
    session_id: Option<String>,
    operation_id: String,
    animation_mode: Option<String>,
) -> Result<crate::commands::AnyValue, String> {
    let mappings = parse_replacements_map(&replacements_map);
    let session_id = crate::studio_bridge::queue_replace_mappings_internal(
        mappings,
        session_id.as_deref(),
        &operation_id,
        animation_mode.as_deref().unwrap_or("animation"),
    )
    .await?;
    Ok(crate::commands::AnyValue(
        serde_json::json!({"sessionId": session_id, "operationId": operation_id}),
    ))
}

#[tauri::command]
#[specta::specta]
pub async fn set_plugin_batch_size(batch_size: u32) -> Result<(), String> {
    crate::studio_bridge::set_batch_size(batch_size).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_replacements_map_valid_strings() {
        let json = serde_json::json!({
            "123": "456",
            "abc": "def"
        });
        let any_val = crate::commands::AnyValue(json);

        let mut parsed = parse_replacements_map(&any_val);

        parsed.sort_by(|a, b| {
            a["originalId"].as_str().expect("str").cmp(b["originalId"].as_str().expect("str"))
        });

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["originalId"], "123");
        assert_eq!(parsed[0]["newId"], "456");
        assert_eq!(parsed[1]["originalId"], "abc");
        assert_eq!(parsed[1]["newId"], "def");
    }

    #[test]
    fn test_parse_replacements_map_numbers() {
        let json = serde_json::json!({
            "123": 456,
            "789": -100
        });
        let any_val = crate::commands::AnyValue(json);

        let mut parsed = parse_replacements_map(&any_val);
        parsed.sort_by(|a, b| {
            a["originalId"].as_str().expect("str").cmp(b["originalId"].as_str().expect("str"))
        });

        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["originalId"], "123");
        assert_eq!(parsed[0]["newId"], "456");
        assert_eq!(parsed[1]["originalId"], "789");
        assert_eq!(parsed[1]["newId"], "-100");
    }

    #[test]
    fn test_parse_replacements_map_filters_invalid() {
        let json = serde_json::json!({
            "123": "",
            "456": "456",
            "789": null,
            "abc": ["array"],
            "valid": "yes"
        });
        let any_val = crate::commands::AnyValue(json);

        let parsed = parse_replacements_map(&any_val);

        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0]["originalId"], "valid");
        assert_eq!(parsed[0]["newId"], "yes");
    }
}
