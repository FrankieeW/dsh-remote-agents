//! OMP model configuration, with field-scoped YAML edits and write-only credentials.
use crate::{common::*, hosts::Host, providers::Registry};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    str::FromStr,
    sync::OnceLock,
};
use yaml_edit::Document;

const MAX: u64 = 4 * 1024 * 1024;
const SETTINGS: &[&str] = &[
    "modelRoles",
    "modelPresets",
    "modelTags",
    "cycleOrder",
    "defaultThinkingLevel",
    "modelRoleStorage",
];
const MODEL_FIELDS: &[&str] = &[
    "name",
    "api",
    "kind",
    "reasoning",
    "input",
    "thinking",
    "contextWindow",
    "maxContextWindow",
    "maxTokens",
    "cost",
    "supportsTools",
];
pub fn spec() -> &'static Value {
    static S: OnceLock<Value> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(include_str!("../omp-config-spec.json")).unwrap())
}
#[derive(Clone)]
struct Config {
    logical: String,
    path: String,
    raw: String,
    value: Value,
    exists: bool,
}
impl Config {
    fn revision(&self) -> String {
        hash(format!("{}\0{}\0{}", self.path, self.exists, self.raw))
    }
    fn info(&self) -> Value {
        json!({"path":self.logical,"resolvedPath":self.path,"revision":self.revision(),"exists":self.exists})
    }
}
fn parse(raw: &str) -> Result<Value> {
    let v: Value = serde_yaml_ng::from_str(raw).map_err(|_| {
        Error::new(
            "INVALID_CONFIG",
            "Configuration YAML could not be parsed; the original file was left unchanged",
        )
    })?;
    if v.is_null() {
        Ok(json!({}))
    } else if v.is_object() {
        Ok(v)
    } else {
        err(
            "INVALID_CONFIG",
            "Configuration must contain a YAML mapping",
        )
    }
}
const READ: &str = r#"set -eu
p=$1
if [ -e "$p" ] || [ -L "$p" ]; then
 p=$(realpath "$p")
 [ -f "$p" ] || exit 72
 [ "$(wc -c < "$p")" -le 4194304 ] || exit 72
 printf '%s\n1\n' "$p"
 base64 < "$p"
else
 if [ -d "$(dirname "$p")" ]; then p="$(realpath "$(dirname "$p")")/$(basename "$p")"; fi
 printf '%s\n0\n' "$p"
fi"#;
async fn read(host: &Host, path: &str) -> Result<Config> {
    absolute(path)?;
    let (resolved, exists, bytes) = if host.remote() {
        let text = host
            .run(
                "sh",
                &["-c".into(), READ.into(), "dsh-config".into(), path.into()],
                None,
                15,
                6 * 1024 * 1024,
            )
            .await?;
        let mut lines = text.lines();
        let resolved = lines.next().unwrap_or("").to_owned();
        absolute(&resolved)?;
        let exists = lines.next() == Some("1");
        let data = STANDARD
            .decode(lines.collect::<String>())
            .map_err(|_| Error::new("INVALID_CONFIG", "Invalid remote configuration response"))?;
        (resolved, exists, data)
    } else {
        match fs::symlink_metadata(path) {
            Ok(_) => {
                let p = fs::canonicalize(path)?;
                (
                    p.to_string_lossy().into_owned(),
                    true,
                    read_bounded(&p, MAX)?,
                )
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let p = Path::new(path);
                let resolved = fs::canonicalize(p.parent().unwrap())
                    .map(|d| d.join(p.file_name().unwrap()))
                    .unwrap_or_else(|_| p.to_owned());
                (resolved.to_string_lossy().into_owned(), false, vec![])
            }
            Err(e) => return Err(e.into()),
        }
    };
    let raw = String::from_utf8(bytes)
        .map_err(|_| Error::new("INVALID_CONFIG", "Configuration is not UTF-8"))?;
    let value = parse(&raw)?;
    Ok(Config {
        logical: path.into(),
        path: resolved,
        raw,
        value,
        exists,
    })
}
async fn choose(host: &Host, root: &str, name: &str) -> Result<Config> {
    let first = read(host, &format!("{root}/{name}.yml")).await?;
    if first.exists {
        return Ok(first);
    }
    let other = read(host, &format!("{root}/{name}.yaml")).await?;
    Ok(if other.exists { other } else { first })
}
fn selected(v: &Value, keys: &[&str]) -> Value {
    let mut out = json!({});
    for k in keys {
        if let Some(x) = v.get(k) {
            out[*k] = x.clone()
        }
    }
    out
}
fn settings_view(v: &Value) -> Value {
    let mut out = json!({});
    for k in ["defaultThinkingLevel", "modelRoleStorage"] {
        if v[k].is_string() {
            out[k] = v[k].clone();
        }
    }
    if let Some(order) = v["cycleOrder"].as_array() {
        out["cycleOrder"] = json!(order.iter().filter(|v| v.is_string()).collect::<Vec<_>>());
    }
    if let Some(roles) = v["modelRoles"].as_object() {
        out["modelRoles"] = json!(
            roles
                .iter()
                .filter(|(_, v)| v.is_string())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<serde_json::Map<_, _>>()
        );
    }
    if let Some(presets) = v["modelPresets"].as_object() {
        out["modelPresets"] = json!(
            presets
                .iter()
                .map(|(k, p)| (
                    k.clone(),
                    selected(
                        &settings_view(&selected(p, &["modelRoles", "defaultThinkingLevel"])),
                        &["modelRoles", "defaultThinkingLevel"]
                    )
                ))
                .collect::<serde_json::Map<_, _>>()
        );
    }
    if let Some(tags) = v["modelTags"].as_object() {
        out["modelTags"] = json!(
            tags.iter()
                .map(|(k, t)| {
                    let mut tag = json!({});
                    for field in ["name", "color"] {
                        if t[field].is_string() {
                            tag[field] = t[field].clone();
                        }
                    }
                    if t["hidden"].is_boolean() {
                        tag["hidden"] = t["hidden"].clone();
                    }
                    (k.clone(), tag)
                })
                .collect::<serde_json::Map<_, _>>()
        );
    }
    out
}
fn private_url(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| s.contains('?') || s.contains('@') || s.contains('#'))
}
fn model_view(v: &Value) -> Value {
    let mut out = selected(v, MODEL_FIELDS);
    for k in ["name", "api", "kind"] {
        if out.get(k).is_some_and(|v| !v.is_string()) {
            out.as_object_mut().unwrap().remove(k);
        }
    }
    if let Some(t) = v.get("thinking") {
        out["thinking"] = selected(
            t,
            &[
                "mode",
                "efforts",
                "defaultLevel",
                "effortMap",
                "supportsDisplay",
                "requiresEffort",
                "minLevel",
                "maxLevel",
                "levels",
            ],
        );
        for key in ["mode", "defaultLevel", "minLevel", "maxLevel"] {
            if out["thinking"].get(key).is_some_and(|x| !x.is_string()) {
                out["thinking"].as_object_mut().unwrap().remove(key);
            }
        }
        for key in ["efforts", "levels"] {
            if out["thinking"]
                .get(key)
                .is_some_and(|x| !x.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
            {
                out["thinking"].as_object_mut().unwrap().remove(key);
            }
        }
    }
    if out
        .get("input")
        .is_some_and(|x| !x.as_array().is_some_and(|a| a.iter().all(Value::is_string)))
    {
        out.as_object_mut().unwrap().remove("input");
    }
    if let Some(cost) = v.get("cost") {
        out["cost"] = selected(cost, &["input", "output", "cacheRead", "cacheWrite"]);
    }
    out["id"] = v["id"].clone();
    out["advancedFieldsPreserved"] = json!(v.as_object().is_some_and(|m| {
        m.keys()
            .any(|k| k != "id" && !MODEL_FIELDS.contains(&k.as_str()))
    }));
    out
}
fn provider_view(id: &str, p: &Value) -> Value {
    let mut out = selected(
        p,
        &[
            "baseUrl",
            "api",
            "auth",
            "authHeader",
            "disableStrictTools",
            "discovery",
        ],
    );
    if private_url(&out["baseUrl"]) {
        out.as_object_mut().unwrap().remove("baseUrl");
        out["privateEndpoint"] = json!(true);
    }
    let key = s(p, "apiKey");
    if let Some(d) = p.get("discovery") {
        out["discovery"] = selected(d, &["type", "timeoutMs", "injectV1", "advertisedReasoning"]);
    }
    out["credential"] = json!({"configured":!key.is_empty(),"kind":if key.starts_with('!'){"command"}else{"stored"},"reference":""});
    out["id"] = json!(id);
    out["models"] = json!(
        p["models"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["id"].is_string())
            .map(model_view)
            .collect::<Vec<_>>()
    );
    out["overrides"] = json!(
        p["modelOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(id, v)| {
                let mut m = model_view(v);
                m["id"] = json!(id);
                m
            })
            .collect::<Vec<_>>()
    );
    out["advancedFieldsPreserved"] = json!(p.as_object().is_some_and(|m| m.keys().any(|k| {
        ![
            "baseUrl",
            "api",
            "auth",
            "apiKey",
            "authHeader",
            "disableStrictTools",
            "discovery",
            "models",
            "modelOverrides",
        ]
        .contains(&k.as_str())
    })));
    out
}
async fn context(host: &Host, registry: &Registry, p: &Value) -> Result<(String, String, String)> {
    let executable = registry.resolve(host, "omp").await?;
    let version = host
        .run(&executable, &["--version".into()], None, 5, 4096)
        .await?;
    if !version.contains("18.18.") {
        return err(
            "UNSUPPORTED",
            "Model configuration management currently requires OMP 18.18.x",
        );
    }
    let cwd = host
        .directory(
            p.get("cwd")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("~/"),
        )
        .await?;
    let root = host
        .run(
            &executable,
            &["config".into(), "path".into()],
            Some(&cwd),
            10,
            8192,
        )
        .await?
        .trim()
        .to_owned();
    absolute(&root)?;
    Ok((executable, cwd, root))
}
pub async fn snapshot(host: &Host, registry: &Registry, p: &Value) -> Result<Value> {
    let (executable, cwd, root) = context(host, registry, p).await?;
    let project_path = format!("{cwd}/.omp/config.yml");
    let (global, project) =
        tokio::try_join!(choose(host, &root, "config"), read(host, &project_path))?;
    let run = |args: Vec<String>| {
        let file = &executable;
        let dir = &cwd;
        async move {
            let raw = host
                .run(file, &args, Some(dir), 25, 16 * 1024 * 1024)
                .await?;
            serde_json::from_str::<Value>(&raw).map_err(Error::from)
        }
    };
    let (effective, catalog) = tokio::join!(
        run(vec!["config".into(), "list".into(), "--json".into()]),
        run(vec![
            "models".into(),
            "--kind".into(),
            "all".into(),
            "--json".into(),
            "--no-extensions".into()
        ])
    );
    let catalog_error = catalog
        .as_ref()
        .err()
        .map(|_| "OMP could not load its model catalog. Check provider definitions.");
    let effective_error = effective
        .as_ref()
        .err()
        .map(|_| "OMP could not resolve its current settings.");
    let catalog = catalog.unwrap_or(json!({}));
    let models = choose(host, &root, "models").await?;
    let effective = effective.unwrap_or(json!({}));
    let mut resolved = json!({});
    for k in SETTINGS {
        if let Some(v) = effective[*k].get("value") {
            resolved[*k] = v.clone();
        }
    }
    let public_models = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            selected(
                m,
                &[
                    "provider",
                    "id",
                    "selector",
                    "name",
                    "kind",
                    "contextWindow",
                    "maxTokens",
                    "reasoning",
                    "thinking",
                    "input",
                    "cost",
                ],
            )
        })
        .collect::<Vec<_>>();
    Ok(
        json!({"machineId":host.machine["id"],"cwd":cwd,"files":{"global":global.info(),"project":project.info(),"providers":models.info()},"global":settings_view(&global.value),"project":settings_view(&project.value),"effective":settings_view(&resolved),"catalogError":catalog_error,"effectiveError":effective_error,"catalog":public_models,"providers":models.value["providers"].as_object().into_iter().flatten().map(|(id,v)|provider_view(id,v)).collect::<Vec<_>>(),"spec":spec()}),
    )
}
fn valid_name(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && t.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-./".contains(&c))
        && !["__proto__", "constructor", "prototype"].contains(&t)
}
fn check_keys(v: &Value, keys: &[&str]) -> Result<()> {
    let o = v
        .as_object()
        .ok_or_else(|| Error::new("INVALID_INPUT", "Expected a configuration patch"))?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return err("INVALID_INPUT", "Unsupported configuration field");
    }
    Ok(())
}
fn clean_text(v: &Value, max: usize) -> Result<()> {
    text(v, max, false).map(|_| ())
}
fn url(v: &Value) -> Result<()> {
    let t = v.as_str().unwrap_or("");
    if !(t.starts_with("https://") || t.starts_with("http://"))
        || private_url(v)
        || t.chars().any(char::is_whitespace)
        || t.split_once("://")
            .is_none_or(|(_, rest)| rest.split('/').next().unwrap_or("").is_empty())
    {
        return err(
            "INVALID_INPUT",
            "Use an HTTP(S) endpoint without embedded credentials, query or fragment",
        );
    };
    clean_text(v, 2048)
}
fn validate_model(v: &Value, provider: &Value) -> Result<()> {
    for k in ["contextWindow", "maxContextWindow", "maxTokens"] {
        if let Some(x) = v.get(k) {
            if !x.as_u64().is_some_and(|n| n > 0 && n <= 100_000_000) {
                return err(
                    "INVALID_INPUT",
                    "Model token limits must be positive integers",
                );
            }
        }
    }
    if v["maxContextWindow"]
        .as_u64()
        .is_some_and(|n| n < v["contextWindow"].as_u64().unwrap_or(0))
    {
        return err(
            "INVALID_INPUT",
            "Maximum context cannot be smaller than context window",
        );
    }
    for k in ["name", "api", "kind"] {
        if let Some(x) = v.get(k) {
            clean_text(x, 256)?;
        }
    }
    for k in ["reasoning", "supportsTools"] {
        if v.get(k).is_some_and(|x| !x.is_boolean()) {
            return err("INVALID_INPUT", "Model flags must be booleans");
        }
    }
    if let Some(x) = v.get("input") {
        if !x
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(|v| v == "text" || v == "image"))
        {
            return err("INVALID_INPUT", "Choose text and/or image input");
        }
    }
    if let Some(x) = v.get("cost") {
        check_keys(x, &["input", "output", "cacheRead", "cacheWrite"])?;
        if ["input", "output", "cacheRead", "cacheWrite"]
            .iter()
            .any(|k| !x[*k].as_f64().is_some_and(|n| n >= 0.0 && n.is_finite()))
        {
            return err(
                "INVALID_INPUT",
                "All four cost values must be nonnegative numbers",
            );
        }
    }
    if let Some(t) = v.get("thinking") {
        check_keys(
            t,
            &[
                "mode",
                "efforts",
                "defaultLevel",
                "effortMap",
                "supportsDisplay",
                "requiresEffort",
                "minLevel",
                "maxLevel",
                "levels",
            ],
        )?;
        if !spec()["thinkingModes"]
            .as_array()
            .unwrap()
            .contains(&t["mode"])
        {
            return err("INVALID_INPUT", "Unsupported thinking mode");
        }
        if let Some(e) = t.get("efforts") {
            if !e.as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.iter().all(|v| {
                        spec()["efforts"].as_array().unwrap().contains(v)
                            && v != "off"
                            && v != "auto"
                    })
            }) {
                return err("INVALID_INPUT", "Choose supported thinking efforts");
            }
        }
        if t.get("efforts").is_none()
            && t.get("levels").is_none()
            && !(t.get("minLevel").is_some() && t.get("maxLevel").is_some())
        {
            return err(
                "INVALID_INPUT",
                "Thinking controls need supported effort levels",
            );
        }
        for k in ["supportsDisplay", "requiresEffort"] {
            if t.get(k).is_some_and(|v| !v.is_boolean()) {
                return err("INVALID_INPUT", "Thinking flags must be booleans");
            }
        }
        if let Some(map) = t.get("effortMap") {
            check_keys(map, &["minimal", "low", "medium", "high", "xhigh", "max"])?;
            for value in map.as_object().unwrap().values() {
                clean_text(value, 128)?;
            }
        }
        if t.get("defaultLevel").is_some()
            && t.get("efforts").is_some()
            && !t["efforts"]
                .as_array()
                .unwrap()
                .contains(&t["defaultLevel"])
        {
            return err(
                "INVALID_INPUT",
                "Default thinking must be one of its supported efforts",
            );
        }
    }
    let api = v.get("api").unwrap_or(&provider["api"]);
    if !api.is_null()
        && !spec()["providerApis"].as_array().unwrap().contains(api)
        && !spec()["runnerApis"]
            .get(api.as_str().unwrap_or(""))
            .is_some()
    {
        return err("INVALID_INPUT", "Unsupported model API");
    }
    if let Some(kind) = v.get("kind") {
        if ![
            "chat",
            "tiny",
            "image",
            "tts",
            "stt",
            "judge",
            "embedding",
            "rerank",
            "video",
        ]
        .contains(&kind.as_str().unwrap_or(""))
        {
            return err("INVALID_INPUT", "Unsupported model kind");
        }
        let expected = &spec()["runnerApis"][api.as_str().unwrap_or("")];
        if !expected.is_null() && kind != expected {
            return err("INVALID_INPUT", "Model kind does not match its API");
        }
        if expected.is_null()
            && !api.is_null()
            && kind != "chat"
            && kind != "tiny"
            && !(kind == "image"
                && [
                    "google-generative-ai",
                    "google-gemini-cli",
                    "openai-responses",
                    "openai-codex-responses",
                ]
                .contains(&api.as_str().unwrap_or("")))
        {
            return err("INVALID_INPUT", "Model kind does not match its API");
        }
    }
    Ok(())
}
fn validate_provider(v: &Value) -> Result<()> {
    if let Some(x) = v.get("baseUrl") {
        clean_text(x, 2048)?;
    }
    if let Some(x) = v.get("api") {
        if !spec()["providerApis"].as_array().unwrap().contains(x) {
            return err("INVALID_INPUT", "Unsupported provider API");
        }
    }
    if let Some(x) = v.get("auth") {
        if ![json!("apiKey"), json!("none"), json!("oauth")].contains(x) {
            return err("INVALID_INPUT", "Unsupported authentication mode");
        }
    }
    for k in ["authHeader", "disableStrictTools"] {
        if v.get(k).is_some_and(|x| !x.is_boolean()) {
            return err("INVALID_INPUT", "Provider flags must be booleans");
        }
    }
    if let Some(d) = v.get("discovery") {
        check_keys(d, &["type", "timeoutMs", "injectV1", "advertisedReasoning"])?;
        if !spec()["discoveryTypes"]
            .as_array()
            .unwrap()
            .contains(&d["type"])
        {
            return err("INVALID_INPUT", "Unsupported discovery method");
        }
        if d["type"] != "proxy" && !v["api"].is_string() {
            return err("INVALID_INPUT", "Discovery requires a provider API");
        }
        if d.get("timeoutMs")
            .is_some_and(|x| !x.as_u64().is_some_and(|n| n > 0 && n <= 120000))
        {
            return err(
                "INVALID_INPUT",
                "Discovery timeout must be between 1 and 120000 ms",
            );
        }
        if d.get("injectV1").is_some() && d["type"] != "openai-models-list" {
            return err(
                "INVALID_INPUT",
                "injectV1 only applies to OpenAI model discovery",
            );
        }
        for k in ["injectV1", "advertisedReasoning"] {
            if d.get(k).is_some_and(|v| !v.is_boolean()) {
                return err("INVALID_INPUT", "Discovery flags must be booleans");
            }
        }
        if d.get("advertisedReasoning").is_some()
            && !["openai-models-list", "lm-studio", "proxy"].contains(&s(d, "type"))
        {
            return err(
                "INVALID_INPUT",
                "advertisedReasoning does not apply to this discovery method",
            );
        }
    }
    let models = v["models"].as_array().cloned().unwrap_or_default();
    if models.is_empty()
        && v["auth"] != "none"
        && ![
            "baseUrl",
            "headers",
            "compat",
            "apiKey",
            "disableStrictTools",
            "guardrailIdentifier",
            "requestMetadata",
            "remoteCompaction",
            "modelOverrides",
            "discovery",
        ]
        .iter()
        .any(|key| v.get(*key).is_some_and(|x| !x.is_null() && x != false))
    {
        return err(
            "INVALID_INPUT",
            "Set an endpoint, credential, discovery or model override for this provider",
        );
    }
    if !models.is_empty() {
        if !v["baseUrl"].is_string() {
            return err("INVALID_INPUT", "Custom models need a provider endpoint");
        }
        if !v["apiKey"].is_string() && v["auth"] != "none" && v["auth"] != "oauth" {
            return err(
                "INVALID_INPUT",
                "Choose credentials, existing OAuth, or explicit no authentication",
            );
        }
        for m in models {
            if !m["api"].is_string() && !v["api"].is_string() {
                return err("INVALID_INPUT", "Custom models need an API protocol");
            };
            validate_model(&m, v)?;
        }
    }
    Ok(())
}
fn merge(current: &Value, patch: &Value) -> Value {
    let mut out = if current.is_object() {
        current.clone()
    } else {
        json!({})
    };
    for (k, v) in patch.as_object().unwrap() {
        if v.is_null() {
            out.as_object_mut().unwrap().remove(k);
        } else {
            out[k] = v.clone()
        }
    }
    out
}
fn set(doc: &Document, path: &[String], value: Option<&Value>) -> Result<()> {
    let mut map = doc
        .as_mapping()
        .ok_or_else(|| Error::new("INVALID_CONFIG", "YAML root must be a mapping"))?;
    for key in &path[..path.len() - 1] {
        if map.get(key.as_str()).is_none() {
            let empty = Document::new_mapping();
            map.set(key.as_str(), empty.as_mapping().unwrap());
        }
        map = map.get_mapping(key.as_str()).ok_or_else(|| {
            Error::new(
                "INVALID_CONFIG",
                "This field uses an unsupported YAML alias or shape; edit it in OMP",
            )
        })?;
    }
    let key = path.last().unwrap();
    if let Some(v) = value {
        let snippet = Document::from_str(&format!("value: {}\n", v))
            .map_err(|_| Error::new("INVALID_INPUT", "Cannot encode configuration value"))?;
        map.set(key.as_str(), snippet.get("value").unwrap());
    } else {
        map.remove(key.as_str());
    }
    Ok(())
}
fn change(config: &Config, p: &Value) -> Result<String> {
    let doc = if config.raw.trim().is_empty() {
        Document::new_mapping()
    } else {
        Document::from_str(&config.raw)
            .map_err(|_| Error::new("INVALID_CONFIG", "Cannot edit this YAML document safely"))?
    };
    let kind = s(p, "kind");
    if kind == "roles" {
        let patch = &p["patch"];
        check_keys(
            patch,
            &[
                "modelRoles",
                "defaultThinkingLevel",
                "cycleOrder",
                "modelPresets",
            ],
        )?;
        for (k, v) in patch.as_object().unwrap() {
            if k == "modelRoles" || k == "modelPresets" {
                let entries = v
                    .as_object()
                    .ok_or_else(|| Error::new("INVALID_INPUT", "Expected role/preset entries"))?;
                for (id, value) in entries {
                    if (k == "modelRoles" && !valid_name(id))
                        || (k == "modelPresets" && text(&json!(id), 128, false).is_err())
                    {
                        return err("INVALID_INPUT", "Invalid role/preset name");
                    }
                    if !value.is_null() {
                        if k == "modelRoles" {
                            clean_text(value, 512)?;
                        } else {
                            check_keys(value, &["modelRoles", "defaultThinkingLevel"])?;
                            for (role, selector) in
                                value["modelRoles"].as_object().ok_or_else(|| {
                                    Error::new("INVALID_INPUT", "Preset needs role assignments")
                                })?
                            {
                                if !valid_name(role) {
                                    return err("INVALID_INPUT", "Invalid role name");
                                };
                                clean_text(selector, 512)?;
                            }
                            if value.get("defaultThinkingLevel").is_some()
                                && !spec()["efforts"]
                                    .as_array()
                                    .unwrap()
                                    .contains(&value["defaultThinkingLevel"])
                            {
                                return err("INVALID_INPUT", "Invalid preset thinking level");
                            }
                        }
                    }
                    set(
                        &doc,
                        &[k.clone(), id.clone()],
                        if value.is_null() { None } else { Some(value) },
                    )?;
                }
            } else {
                if !v.is_null() {
                    if k == "defaultThinkingLevel"
                        && !spec()["efforts"].as_array().unwrap().contains(v)
                    {
                        return err("INVALID_INPUT", "Invalid thinking level");
                    };
                    if k == "cycleOrder"
                        && !v.as_array().is_some_and(|a| {
                            a.len() <= 64 && a.iter().all(|x| x.as_str().is_some_and(valid_name))
                        })
                    {
                        return err("INVALID_INPUT", "Invalid role cycle");
                    }
                }
                set(&doc, &[k.clone()], if v.is_null() { None } else { Some(v) })?;
            }
        }
    } else {
        let id = required(p, "provider", 128)?;
        if !valid_name(&id) || id.contains('/') {
            return err("INVALID_INPUT", "Invalid provider id");
        }
        let old = &config.value["providers"][&id];
        if kind == "provider" {
            if p["remove"] == true {
                set(&doc, &["providers".into(), id], None)?;
            } else {
                let patch = &p["patch"];
                check_keys(
                    patch,
                    &[
                        "baseUrl",
                        "api",
                        "auth",
                        "authHeader",
                        "disableStrictTools",
                        "discovery",
                        "credential",
                    ],
                )?;
                let mut fields = patch.clone();
                fields.as_object_mut().unwrap().remove("credential");
                if let Some(value) = fields.get("baseUrl").filter(|v| !v.is_null()) {
                    url(value)?;
                }
                if let Some(c) = patch.get("credential") {
                    check_keys(c, &["mode", "value"])?;
                    match s(c, "mode") {
                        "keep" => (),
                        "remove" => fields["apiKey"] = Value::Null,
                        "env" => {
                            let name = required(c, "value", 128)?;
                            if !name.as_bytes()[0].is_ascii_uppercase()
                                || !name.bytes().all(|c| {
                                    c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'
                                })
                            {
                                return err(
                                    "INVALID_INPUT",
                                    "Use an uppercase environment variable name",
                                );
                            };
                            fields["apiKey"] = json!(name);
                        }
                        "key" => {
                            let key = required(c, "value", 8192)?;
                            if key.trim_start().starts_with('!') {
                                return err(
                                    "INVALID_INPUT",
                                    "Shell commands cannot be entered as API keys here",
                                );
                            };
                            fields["apiKey"] = json!(key);
                        }
                        _ => return err("INVALID_INPUT", "Invalid credential action"),
                    }
                }
                let merged = merge(old, &fields);
                validate_provider(&merged)?;
                for (k, v) in fields.as_object().unwrap() {
                    set(
                        &doc,
                        &["providers".into(), id.clone(), k.clone()],
                        if v.is_null() { None } else { Some(v) },
                    )?;
                }
            }
        } else if kind == "model" || kind == "override" {
            if !old.is_object() && kind != "override" {
                return err("INVALID_INPUT", "Save the provider first");
            }
            let mid = required(p, "model", 256)?;
            let mut provider = old.clone();
            let patch = &p["patch"];
            if p["remove"] != true {
                check_keys(patch, MODEL_FIELDS)?;
            }
            if kind == "override" {
                let changed = if p["remove"] == true {
                    None
                } else {
                    let v = merge(&old["modelOverrides"][&mid], patch);
                    validate_model(&v, old)?;
                    Some(v)
                };
                set(
                    &doc,
                    &["providers".into(), id, "modelOverrides".into(), mid],
                    changed.as_ref(),
                )?;
            } else {
                let mut rows = old["models"].as_array().cloned().unwrap_or_default();
                let index = rows.iter().position(|m| m["id"] == mid);
                if p["remove"] == true {
                    if let Some(i) = index {
                        rows.remove(i);
                    }
                } else {
                    let mut v = merge(index.map(|i| &rows[i]).unwrap_or(&Value::Null), patch);
                    v["id"] = json!(mid);
                    validate_model(&v, old)?;
                    if let Some(i) = index {
                        rows[i] = v
                    } else {
                        rows.push(v)
                    }
                }
                provider["models"] = json!(rows);
                validate_provider(&provider)?;
                set(
                    &doc,
                    &["providers".into(), id, "models".into()],
                    Some(&provider["models"]),
                )?;
            }
        } else {
            return err("INVALID_INPUT", "Unknown model configuration action");
        }
    }
    let result = doc.to_string();
    parse(&result)?;
    if result.len() > MAX as usize {
        return err("STATE_LIMIT", "Model configuration exceeds 4 MiB");
    };
    Ok(result)
}
const WRITE: &str = r#"set -eu
umask 077
logical=$1; p=$2; expected=$3; existed=$4; backup=$5
mkdir -p "$(dirname "$p")"
[ "$(realpath "$(dirname "$logical")")/$(basename "$logical")" = "$p" ] || { [ -e "$logical" ] && [ "$(realpath "$logical")" = "$p" ]; } || exit 73
lock="$p.dsh-lock"
mkdir "$lock" 2>/dev/null || exit 74
tmp="$lock/new"
trap 'rm -f "$tmp"; rmdir "$lock"' EXIT HUP INT TERM
digest() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }
check() { if [ "$existed" = 1 ]; then [ -f "$p" ] && [ "$(digest "$p")" = "$expected" ]; else [ ! -e "$p" ] && [ ! -L "$p" ]; fi; }
check || exit 73
cat > "$tmp"
if [ "$existed" = 1 ]; then cp "$p" "$backup"; chmod 600 "$backup"; fi
check || exit 73
mv "$tmp" "$p"
printf 'saved\n'"#;
async fn write(host: &Host, old: &Config, raw: &str) -> Result<String> {
    let latest = read(host, &old.logical).await?;
    if latest.revision() != old.revision() {
        return err(
            "CONFLICT",
            "OMP configuration changed. Reload before saving",
        );
    }
    let backup = format!("{}.dsh-backup-{}", old.path, id());
    if host.remote() {
        host.run_with_input(
            "sh",
            &[
                "-c".into(),
                WRITE.into(),
                "dsh-config".into(),
                old.logical.clone(),
                old.path.clone(),
                hash(&old.raw),
                if old.exists { "1" } else { "0" }.into(),
                backup.clone(),
            ],
            None,
            20,
            8192,
            Some(raw.as_bytes().to_vec()),
        )
        .await
        .map_err(|e| {
            if e.code == "73" {
                Error::new(
                    "CONFLICT",
                    "OMP configuration changed. Reload before saving",
                )
            } else if e.code == "74" {
                Error::new("BUSY", "Another configuration save is running")
            } else {
                e
            }
        })?;
    } else {
        let path = Path::new(&old.path);
        let parent = path.parent().unwrap();
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        let lock = path.with_file_name(format!(
            "{}.dsh-lock",
            path.file_name().unwrap().to_string_lossy()
        ));
        fs::create_dir(&lock)
            .map_err(|_| Error::new("BUSY", "Another configuration save is running"))?;
        let result = (|| -> Result<()> {
            let current = if old.exists {
                fs::canonicalize(&old.logical)?
            } else {
                PathBuf::from(&old.logical)
            };
            if current != path {
                return err("CONFLICT", "Configuration target changed");
            }
            if fs::canonicalize(parent)? != parent {
                return err("CONFLICT", "Configuration directory target changed");
            }
            let bytes = if old.exists {
                read_bounded(path, MAX)?
            } else {
                if path.exists() {
                    return err("CONFLICT", "Configuration was created by another process");
                };
                vec![]
            };
            if hash(&bytes) != hash(&old.raw) {
                return err("CONFLICT", "Configuration changed before save");
            }
            if old.exists {
                atomic_write(Path::new(&backup), &bytes)?;
            }
            if old.exists && hash(read_bounded(path, MAX)?) != hash(&old.raw) {
                return err("CONFLICT", "Configuration changed before save");
            }
            atomic_write(path, raw.as_bytes())?;
            Ok(())
        })();
        let _ = fs::remove_dir(lock);
        result?;
    }
    let saved = read(host, &old.logical).await?;
    if saved.raw != raw {
        return err(
            "CONFLICT",
            "Configuration changed during save; inspect it before retrying",
        );
    };
    Ok(if old.exists { backup } else { String::new() })
}
pub async fn save(host: &Host, registry: &Registry, p: &Value) -> Result<Value> {
    let (_, cwd, root) = context(host, registry, p).await?;
    let old = if s(p, "kind") == "roles" {
        match s(p, "scope") {
            "global" => choose(host, &root, "config").await?,
            "project" => read(host, &format!("{cwd}/.omp/config.yml")).await?,
            _ => return err("INVALID_INPUT", "Choose global or project scope"),
        }
    } else {
        choose(host, &root, "models").await?
    };
    if p["revision"] != old.revision() {
        return err(
            "CONFLICT",
            "OMP configuration changed. Reload before saving",
        );
    }
    let raw = change(&old, p)?;
    if s(p, "kind") == "roles" {
        let changed = parse(&raw)?;
        let global = if s(p, "scope") == "global" {
            changed.clone()
        } else {
            choose(host, &root, "config").await?.value
        };
        let project = if s(p, "scope") == "project" {
            changed
        } else {
            read(host, &format!("{cwd}/.omp/config.yml")).await?.value
        };
        let mut roles = global["modelRoles"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        for (k, v) in project["modelRoles"].as_object().into_iter().flatten() {
            if v.is_string() {
                roles.insert(k.clone(), v.clone());
            }
        }
        validate_roles(&roles)?;
    }
    let backup = write(host, &old, &raw).await?;
    Ok(
        json!({"saved":true,"path":old.logical,"backupPath":backup,"revision":read(host,&old.logical).await?.revision()}),
    )
}

fn validate_roles(roles: &serde_json::Map<String, Value>) -> Result<()> {
    if roles.len() > 256 {
        return err("INVALID_INPUT", "Too many configured model roles");
    }
    for first in roles.keys() {
        let mut seen = std::collections::HashSet::new();
        let mut at = first.as_str();
        while let Some(value) = roles.get(at).and_then(Value::as_str) {
            if !seen.insert(at.to_owned()) {
                return err("INVALID_INPUT", "Model role aliases contain a cycle");
            }
            let selector = value
                .rsplit_once(':')
                .filter(|(_, level)| {
                    spec()["efforts"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(level))
                })
                .map(|(model, _)| model)
                .unwrap_or(value);
            at = if selector == "*" {
                "default"
            } else if let Some(role) = selector
                .strip_prefix('@')
                .or_else(|| selector.strip_prefix("pi/"))
            {
                role
            } else {
                break;
            };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(raw: &str) -> Config {
        Config {
            logical: "/tmp/config.yml".into(),
            path: "/tmp/config.yml".into(),
            exists: true,
            raw: raw.into(),
            value: parse(raw).unwrap(),
        }
    }
    #[test]
    fn roles_preserve_other_settings_and_comments() {
        let old = config(
            "# keep me\nother: 42 # unrelated\nmodelRoles:\n  default: old/model\n  designer: custom/model\n",
        );
        let updated=change(&old,&json!({"kind":"roles","patch":{"modelRoles":{"default":"new/model","smol":"@default"}}})).unwrap();
        assert!(updated.contains("# keep me"));
        assert!(updated.contains("other: 42 # unrelated"));
        assert_eq!(
            parse(&updated).unwrap()["modelRoles"]["designer"],
            "custom/model"
        );
    }
    #[test]
    fn credentials_are_write_only_and_unknown_fields_survive() {
        let old = config(
            "providers:\n  custom:\n    apiKey: test-key-marker\n    headers: {Authorization: private-header}\n    baseUrl: https://example.com/v1\n    compat: {supportsStore: false}\n",
        );
        let public = provider_view("custom", &old.value["providers"]["custom"]).to_string();
        assert!(!public.contains("test-key-marker"));
        assert!(!public.contains("private-header"));
        let updated=change(&old,&json!({"kind":"provider","provider":"custom","patch":{"baseUrl":"http://localhost:1234/v1","credential":{"mode":"keep"}}})).unwrap();
        let p = &parse(&updated).unwrap()["providers"]["custom"];
        assert_eq!(p["apiKey"], "test-key-marker");
        assert_eq!(p["headers"]["Authorization"], "private-header");
        assert_eq!(p["compat"]["supportsStore"], false);
    }
    #[test]
    fn invalid_model_limits_rejected() {
        assert!(validate_model(&json!({"contextWindow":0}), &json!({})).is_err());
        assert!(validate_model(&json!({"api":"openai-speech","kind":"chat"}), &json!({})).is_err());
        assert!(url(&json!("http://")).is_err());
        assert!(url(&json!("https://bad host/v1")).is_err());
        assert!(change(&config("{}"),&json!({"kind":"provider","provider":"test","patch":{"credential":{"mode":"key","value":"  !printf forbidden"}}})).is_err());
    }
    #[test]
    fn uppercase_literals_are_not_exposed_as_environment_names() {
        let v = provider_view(
            "x",
            &json!({"apiKey":"NOT_AN_ENVIRONMENT_VARIABLE_TOKEN","baseUrl":"https://user:pass@example.com/v1?private=1","discovery":{"type":"proxy","unknownSecret":"hidden"}}),
        );
        let raw = v.to_string();
        assert!(!raw.contains("NOT_AN_ENVIRONMENT"));
        assert!(!raw.contains("user:pass"));
        assert!(!raw.contains("hidden"));
        assert_eq!(v["credential"]["configured"], true);
    }
    #[test]
    fn circular_aliases_are_rejected() {
        let roles = json!({"default":"@slow:high","slow":"@default"});
        assert!(validate_roles(roles.as_object().unwrap()).is_err());
    }
    #[tokio::test]
    async fn local_save_preserves_symlink_and_rejects_stale_revision() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("actual.yml");
        let link = dir.path().join("config.yml");
        fs::write(&target, "# untouched comment\nother: keep\n").unwrap();
        symlink(&target, &link).unwrap();
        let host = Host {
            machine: json!({"id":"local","type":"local"}),
        };
        let original = read(&host, link.to_str().unwrap()).await.unwrap();
        let next = change(
            &original,
            &json!({"kind":"roles","patch":{"modelRoles":{"default":"demo/model"}}}),
        )
        .unwrap();
        let backup = write(&host, &original, &next).await.unwrap();
        assert_eq!(fs::read_to_string(&backup).unwrap(), original.raw);
        assert!(
            fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            write(&host, &original, "wrong").await.unwrap_err().code,
            "CONFLICT"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), next);
    }
    #[tokio::test]
    async fn remote_transfer_script_keeps_payload_off_argv_and_checks_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config with spaces.yml");
        fs::write(&p, "old: value\n").unwrap();
        let path = fs::canonicalize(&p).unwrap().to_string_lossy().into_owned();
        let backup = dir.path().join("backup.yml").to_string_lossy().into_owned();
        let host = Host {
            machine: json!({"id":"local","type":"local"}),
        };
        let args = vec![
            "-c".into(),
            WRITE.into(),
            "dsh-config".into(),
            path.clone(),
            path.clone(),
            hash("old: value\n"),
            "1".into(),
            backup.clone(),
        ];
        let body = b"literal: '$(printf not-executed)'\n".to_vec();
        host.run_with_input("sh", &args, None, 10, 8192, Some(body.clone()))
            .await
            .unwrap();
        assert_eq!(fs::read(&p).unwrap(), body);
        assert_eq!(fs::read_to_string(backup).unwrap(), "old: value\n");
        assert_eq!(
            host.run_with_input("sh", &args, None, 10, 8192, Some(body))
                .await
                .unwrap_err()
                .code,
            "73"
        );
    }
}
