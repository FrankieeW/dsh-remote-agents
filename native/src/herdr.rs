use crate::{
    common::*,
    machines::{machine_key, parse_target},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
/// Herdr catalogs use the strict destination grammar.
fn target(t: &str) -> Option<Value> {
    parse_target(t, false)
}
/// Machine configuration that invalidates a preview; probe results are volatile.
fn machine_config(state: &Value) -> Value {
    json!(
        state["machines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let mut m = m.clone();
                m.as_object_mut().unwrap().remove("lastCheck");
                m
            })
            .collect::<Vec<_>>()
    )
}
fn parse(v: &Value, label: &str) -> Result<Value> {
    let source = text(v, 1024 * 1024, true)?;
    if source.len() > 1024 * 1024 {
        return err("INVALID_IMPORT", "Import source exceeds 1 MiB");
    }
    let p: Value = serde_json::from_str(&source)?;
    if !p.is_object() {
        return err("INVALID_IMPORT", format!("{label} must be a JSON object"));
    }
    Ok(p)
}
pub fn preview(input: &Value, state: &Value) -> Result<Value> {
    if input.get("machinesText").is_none() && input.get("sessionText").is_none() {
        return err("INVALID_IMPORT", "Supply machinesText or sessionText");
    }
    let mut machines = vec![];
    let mut projects = vec![];
    let mut warnings = vec![];
    // Address → name of the removed machine using it (None while active).
    let mut known = HashMap::new();
    for m in state["machines"].as_array().unwrap().iter().filter(|m| s(m, "type") == "ssh") {
        let removed = m.get("removedAt").map(|_| s(m, "name").to_owned());
        let entry = known.entry(machine_key(m)).or_insert(removed.clone());
        if removed.is_none() {
            *entry = None
        }
    }
    let mut paths = state["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| json!([p["machineId"], p["cwd"]]).to_string())
        .collect::<HashSet<_>>();
    if let Some(v) = input.get("machinesText") {
        let c = parse(v, "Machine catalog")?;
        if c["version"] != 1 {
            return err(
                "INVALID_IMPORT",
                "Only Herdr machine catalog version 1 is supported",
            );
        }
        let a = c["ssh"]
            .as_array()
            .filter(|a| a.len() <= 64)
            .ok_or_else(|| Error::new("INVALID_IMPORT", "Expected at most 64 SSH profiles"))?;
        if let Some(v) = c.get("selected_profile") {
            if !v.is_null()
                && !v.as_str().is_some_and(|s| {
                    s.len() == 32
                        && s.bytes().all(|c| {
                            c.is_ascii_hexdigit()
                                && (!c.is_ascii_alphabetic() || c.is_ascii_lowercase())
                        })
                })
            {
                return err("INVALID_IMPORT", "Invalid selected profile");
            }
        }
        warnings.push(json!("Credentials, commands, environment and native sessions are not migrated; only static SSH connection metadata is used."));
        for (pn, p) in a.iter().enumerate() {
            let valid = s(p, "id").len() == 32
                && s(p, "id")
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                && text(&p["label"], 128, false).is_ok()
                && s(p, "label").len() <= 128
                && !s(p, "session").is_empty()
                && s(p, "session").len() <= 64
                && ![".", ".."].contains(&s(p, "session"))
                && s(p, "session")
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
                && p["enabled"].is_boolean();
            if !valid || p["enabled"] != true {
                warnings.push(json!(format!(
                    "Machine profile {}: skipped invalid or disabled profile.",
                    pn + 1
                )));
                continue;
            }
            if let Some(mut t) = target(s(p, "target")) {
                let action = match known.get(&machine_key(&t)) {
                    None => {
                        known.insert(machine_key(&t), None);
                        "add"
                    }
                    Some(Some(name)) => {
                        warnings.push(json!(format!(
                            "Machine profile {}: matches the removed machine “{name}”; restore it in Machines & projects instead.",
                            pn + 1
                        )));
                        "duplicate"
                    }
                    Some(None) => "duplicate",
                };
                t["name"] = p["label"].clone();
                t["action"] = json!(action);
                machines.push(t)
            } else {
                warnings.push(json!(format!(
                    "Machine profile {}: skipped unsupported SSH target.",
                    pn + 1
                )))
            }
        }
    }
    if let Some(v) = input.get("sessionText") {
        let dest = s(input, "projectMachineId");
        if !state["machines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| s(m, "id") == dest && m.get("removedAt").is_none())
        {
            return err(
                "INVALID_IMPORT",
                "Session import requires an explicit existing projectMachineId",
            );
        }
        let c = parse(v, "Session snapshot")?;
        if c["version"] != 3 {
            return err(
                "INVALID_IMPORT",
                "Only Herdr session snapshot version 3 is supported",
            );
        }
        let workspaces = c["workspaces"]
            .as_array()
            .filter(|a| a.len() <= 1000)
            .ok_or_else(|| Error::new("INVALID_IMPORT", "Expected at most 1000 workspaces"))?;
        warnings.push(json!("Only static project directories are imported; existing agents, panes and commands are not resumed."));
        for (wi, w) in workspaces.iter().enumerate() {
            let mut candidates = vec![];
            if !s(w, "identity_cwd").is_empty() {
                candidates.push(s(w, "identity_cwd").to_string())
            } else {
                warnings.push(json!(format!(
                    "Workspace {}: no identity_cwd; direct numeric pane directories considered.",
                    wi + 1
                )));
                if let Some(tabs) = w["tabs"].as_array() {
                    for tab in tabs {
                        if let Some(panes) = tab["panes"].as_object() {
                            for (k, pane) in panes {
                                if !k.is_empty() && k.bytes().all(|c| c.is_ascii_digit()) {
                                    candidates.push(s(pane, "cwd").into())
                                }
                            }
                        }
                    }
                }
            }
            for cwd in candidates {
                if absolute(&cwd).is_err() {
                    warnings.push(json!(format!(
                        "Workspace {}: skipped invalid directory.",
                        wi + 1
                    )));
                    continue;
                }
                if projects.len() >= 1000 {
                    return err("INVALID_IMPORT", "Too many project paths");
                }
                let name = if text(&w["custom_name"], 100, false).is_ok() {
                    s(w, "custom_name").to_owned()
                } else {
                    clip(
                        std::path::Path::new(&cwd)
                            .file_name()
                            .and_then(|s| s.to_str())
                            .unwrap_or("Project"),
                        100,
                    )
                };
                let action = if paths.insert(json!([dest, cwd]).to_string()) {
                    "add"
                } else {
                    "duplicate"
                };
                projects.push(json!({"name":name,"cwd":cwd,"machineId":dest,"action":action}));
            }
        }
    }
    let summary = json!({"machines":machines.iter().filter(|m|m["action"]=="add").count(),"projects":projects.iter().filter(|p|p["action"]=="add").count(),"duplicates":machines.iter().chain(projects.iter()).filter(|p|p["action"]=="duplicate").count()});
    warnings.truncate(200);
    let mut result =
        json!({"machines":machines,"projects":projects,"warnings":warnings,"summary":summary});
    let machine_config = machine_config(state);
    let project_config = state["projects"].clone();
    result["digest"]=json!(hash(json!({"format":1,"sourceHashes":[input.get("machinesText").map(|v|hash(s(&json!({"v":v}),"v"))),input.get("sessionText").map(|v|hash(s(&json!({"v":v}),"v")))],"projectMachineId":input["projectMachineId"],"machineConfig":machine_config,"projectConfig":project_config,"preview":result}).to_string()));
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_validation() {
        assert!(target("user@host").is_some());
        assert!(target("ssh://user@[::1]:2222").is_some());
        for bad in ["-oProxyCommand=bad", "a;bad", "ssh://u:p@host", "host/path"] {
            assert!(target(bad).is_none(), "{bad}")
        }
    }
}
