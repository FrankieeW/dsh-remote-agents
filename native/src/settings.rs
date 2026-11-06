use crate::common::*;
use serde_json::{Value, json};
pub fn defaults() -> Value {
    json!({"model":null,"effort":null,"permissions":"cli"})
}
pub fn efforts(provider: &str) -> Vec<&'static str> {
    match provider {
        "codex" => vec!["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        "claude" => vec!["low", "medium", "high", "xhigh", "max"],
        "omp" => vec![
            "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto",
        ],
        _ => vec![],
    }
}
pub fn permissions(provider: &str) -> Value {
    let options = match provider {
        "codex" => vec![
            ("cli", "Follow CLI"),
            ("read-only", "Read only"),
            ("workspace-write", "Workspace write"),
            ("safe", "Ask before running"),
            ("yolo", "Full access · YOLO"),
        ],
        "claude" => vec![
            ("cli", "Follow CLI"),
            ("default", "Default"),
            ("acceptEdits", "Accept edits"),
            ("plan", "Plan"),
            ("auto", "Auto"),
            ("dontAsk", "Don’t ask"),
            ("bypassPermissions", "Bypass permissions · YOLO"),
        ],
        "omp" => vec![
            ("cli", "Follow CLI"),
            ("always-ask", "Always ask"),
            ("always-ask-cached", "Ask and remember"),
            ("write", "Workspace write"),
            ("yolo", "YOLO"),
        ],
        _ => vec![],
    };
    json!(
        options
            .into_iter()
            .map(|(id, label)| json!({"id":id,"label":label}))
            .collect::<Vec<_>>()
    )
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
