use crate::common::*;
use serde_json::{Value, json};
fn contract() -> &'static Value {
    static DATA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../agent-settings.json"))
            .expect("compiled settings contract is valid JSON")
    })
}
pub fn defaults() -> Value {
    contract()["defaults"].clone()
}
pub fn efforts(provider: &str) -> Vec<&'static str> {
    contract()["efforts"][provider]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}
pub fn permissions(provider: &str) -> Value {
    contract()["permissions"]
        .get(provider)
        .cloned()
        .unwrap_or(json!([]))
}
pub fn validate(provider: &str, v: &Value) -> Result<Value> {
    let obj = v
        .as_object()
        .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid agent settings"))?;
    if obj
        .keys()
        .any(|k| !matches!(k.as_str(), "model" | "effort" | "permissions"))
    {
        return err("INVALID_INPUT", "Unknown settings field");
    }
    let mut out = defaults();
    for (k, v) in obj {
        out[k] = v.clone()
    }
    if !out["model"].is_null() {
        let m = text(&out["model"], 256, false)?;
        if m.trim().is_empty() || m.starts_with('-') {
            return err("INVALID_INPUT", "Invalid model");
        }
    }
    if !out["effort"].is_null() && !efforts(provider).contains(&s(&out, "effort")) {
        return err("INVALID_INPUT", "Unsupported effort");
    }
    if !permissions(provider)
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["id"] == out["permissions"])
    {
        return err("INVALID_INPUT", "Unsupported permission mode");
    }
    Ok(out)
}
pub fn codex_policy(mode: &str) -> Value {
    match mode {
        "cli" => json!({}),
        _ => {
            json!({"sandbox":if mode=="yolo"{"danger-full-access"}else if mode=="read-only"{"read-only"}else{"workspace-write"},"approvalPolicy":if mode=="yolo"{"never"}else if mode=="safe"{"untrusted"}else{"on-request"},"approvalsReviewer":"user"})
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_unknown() {
        assert!(validate("codex", &json!({"command":"bad"})).is_err());
        assert!(validate("codex", &json!({"permissions":"bypassPermissions"})).is_err());
        assert_eq!(validate("omp", &json!({})).unwrap(), defaults());
    }
}
