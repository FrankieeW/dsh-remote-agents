use crate::{common::*, hosts::Host, machines::machine_key, protocol::Wire, settings};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
#[derive(Clone)]
pub struct Found {
    pub public: Value,
    pub executable: Option<String>,
}
/// Inspections are cached per machine and address, so a result from an
/// address that changed meanwhile is never served for the new one.
fn cache_key(host: &Host) -> String {
    format!("{}\n{}", s(&host.machine, "id"), machine_key(&host.machine))
}
/// An update that is planned, or one that is already running.
pub enum Prepared {
    Running(Value),
    Ready { provider: String, plan: Value },
}
pub struct Registry {
    pub config: Value,
    cache: Mutex<HashMap<String, (Instant, Vec<Found>)>>,
    pub jobs: Mutex<HashMap<String, Value>>,
}
impl Registry {
    pub fn new(config: Value) -> Arc<Self> {
        Arc::new(Self {
            config,
            cache: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        })
    }
    pub async fn inspect(&self, host: &Host, provider: &str) -> Found {
        let label = match provider {
            "claude" => "Claude Code",
            "codex" => "Codex",
            _ => "OMP · Oh My Pi",
        };
        let mut public = json!({"id":provider,"label":label,"capabilities":{"local":true,"remote":true,"streamingText":true,"tools":true,"approvals":true,"questions":false,"attachments":false,"models":true,"settings":true},"available":false});
        let configured = self
            .config
            .get(format!("{provider}Executable"))
            .and_then(Value::as_str);
        let executable = match host.executable(provider, configured).await {
            Ok(p) => p,
            Err(_) => {
                public["reason"] = json!(format!(
                    "Could not check {label}. Check SSH connectivity and PATH."
                ));
                return Found {
                    public,
                    executable: None,
                };
            }
        };
        let Some(ref file) = executable else {
            public["reason"] = json!(format!(
                "{provider} was not found. Install it and sign in using its native CLI."
            ));
            return Found { public, executable };
        };
        match host
            .run(
                file,
                &["--version".into()],
                None,
                if host.remote() { 15 } else { 5 },
                4096,
            )
            .await
        {
            Ok(v) => {
                let parsed = v
                    .split(|c: char| !c.is_ascii_digit() && c != '.')
                    .find_map(|w| {
                        let n = w.split('.').collect::<Vec<_>>();
                        if n.len() != 3 {
                            return None;
                        }
                        Some((
                            n[0].parse::<u64>().ok()?,
                            n[1].parse::<u64>().ok()?,
                            n[2].parse::<u64>().ok()?,
                        ))
                    });
                if let Some((a, b, c)) = parsed {
                    let compatible = match provider {
                        "codex" => a == 0 && b == 167,
                        "omp" => a == 18 && b >= 17,
                        _ => a == 2 && (b > 1 || b == 1 && c >= 318),
                    };
                    public["version"] = json!(format!("{a}.{b}.{c}"));
                    public["available"] = json!(compatible);
                    if !compatible {
                        public["reason"] = json!(format!(
                            "Unsupported version: {a}.{b}.{c}. Requires {}.",
                            match provider {
                                "codex" => "Codex 0.167.x (app-server v2)",
                                "omp" => "OMP 18.17.x–18.x (RPC v2)",
                                _ => "Claude Code ≥2.1.318 and <3",
                            }
                        ))
                    }
                } else {
                    public["reason"] = json!("CLI version check returned an unknown format")
                }
            }
            Err(e) => {
                public["reason"] = json!(if e.code == "TIMEOUT" {
                    "CLI version check timed out; check startup and SSH, then refresh versions."
                } else {
                    "CLI version check failed; check its installation and PATH."
                })
            }
        }
        Found { public, executable }
    }
    pub async fn inspect_host(&self, host: &Host, refresh: bool) -> Vec<Found> {
        let key = cache_key(host);
        {
            let cache = self.cache.lock().await;
            if !refresh {
                if let Some((at, items)) = cache.get(&key) {
                    if at.elapsed() < Duration::from_secs(60) {
                        return items.clone();
                    }
                }
            }
        }
        let (a, b, c) = tokio::join!(
            self.inspect(host, "claude"),
            self.inspect(host, "codex"),
            self.inspect(host, "omp")
        );
        let items = vec![a, b, c];
        self.cache
            .lock()
            .await
            .insert(key, (Instant::now(), items.clone()));
        items
    }
    pub async fn descriptions(&self, host: &Host, refresh: bool) -> Value {
        let mut items = self.inspect_host(host, refresh).await;
        let jobs = self.jobs.lock().await;
        for item in &mut items {
            if let Some(job) = jobs
                .values()
                .filter(|j| {
                    j["machineId"] == host.machine["id"] && j["provider"] == item.public["id"]
                })
                .max_by_key(|j| s(j, "startedAt"))
            {
                item.public["update"] = job.clone()
            }
        }
        json!(items.into_iter().map(|i| i.public).collect::<Vec<_>>())
    }
    pub async fn resolve(&self, host: &Host, provider: &str) -> Result<String> {
        if self.jobs.lock().await.values().any(|j| {
            j["machineId"] == host.machine["id"]
                && j["provider"] == provider
                && j["status"] == "running"
        }) {
            return err("BUSY", "This remote CLI is updating");
        };
        let found = self
            .inspect_host(host, false)
            .await
            .into_iter()
            .find(|i| i.public["id"] == provider)
            .ok_or_else(|| Error::new("UNSUPPORTED", "Unknown provider"))?;
        if found.public["available"] != true {
            return err("UNSUPPORTED", s(&found.public, "reason"));
        }
        found
            .executable
            .ok_or_else(|| Error::new("UNSUPPORTED", "CLI executable missing"))
    }
    pub async fn options(&self, host: &Host, session: &Value, refresh: bool) -> Result<Value> {
        if refresh {
            self.cache.lock().await.remove(&cache_key(host));
        }
        let provider = s(session, "provider");
        let file = self.resolve(host, provider).await?;
        let cwd = s(session, "cwd");
        let mut models = vec![];
        let defaults;
        let mut restrictions = Value::Null;
        if provider == "omp" {
            let file_ref = &file;
            let run = |args: Vec<String>| async move {
                let text = host
                    .run(file_ref, &args, Some(cwd), 25, 8 * 1024 * 1024)
                    .await?;
                Ok::<Value, Error>(serde_json::from_str(&text)?)
            };
            let (a, b, c, d) = tokio::join!(
                run(vec!["models".into(), "--json".into()]),
                run(vec![
                    "config".into(),
                    "get".into(),
                    "modelRoles".into(),
                    "--json".into()
                ]),
                run(vec![
                    "config".into(),
                    "get".into(),
                    "defaultThinkingLevel".into(),
                    "--json".into()
                ]),
                run(vec![
                    "config".into(),
                    "get".into(),
                    "tools.approvalMode".into(),
                    "--json".into()
                ])
            );
            let catalog = a?;
            for m in catalog["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m.get("kind").is_none() || m["kind"] == "chat")
            {
                models.push(json!({"id":m.get("selector").cloned().unwrap_or(json!(format!("{}/{}",s(m,"provider"),s(m,"id")))),"label":m.get("name").unwrap_or(&m["id"]),"provider":m["provider"],"efforts":if m["reasoning"]==true{json!(settings::efforts("omp"))}else{json!(["off"])}}))
            }
            defaults = json!({"model":b?["value"]["default"],"effort":c?["value"],"permissions":d?["value"]});
        } else {
            let args = if provider == "codex" {
                vec!["app-server", "--listen", "stdio://"]
            } else {
                vec![
                    "--print",
                    "--input-format",
                    "stream-json",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--no-session-persistence",
                    "--setting-sources",
                    "user,project,local",
                ]
            }
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
            let mut wire = Wire::spawn(
                host,
                &file,
                &args,
                cwd,
                if provider == "codex" {
                    "codex"
                } else {
                    "claude-options"
                },
            )?;
            let init=wire.request("initialize",if provider=="codex"{json!({"clientInfo":{"name":"dsh_remote_agents","version":env!("CARGO_PKG_VERSION")},"capabilities":null})}else{json!({})}).await?;
            if provider == "codex" {
                wire.send(json!({"method":"initialized","params":{}}))
                    .await?;
                let result = wire
                    .request("config/read", json!({"cwd":cwd,"includeLayers":false}))
                    .await?;
                let c = &result["config"];
                defaults = json!({"model":c["model"],"effort":c["model_reasoning_effort"],"permissions":c["approval_policy"],"sandbox":c["sandbox_mode"]});
                restrictions =
                    wire.request("configRequirements/read", json!({})).await?["requirements"]
                        .clone();
                let mut cursor = Value::Null;
                let mut cursors = std::collections::HashSet::new();
                loop {
                    let page = wire
                        .request("model/list", json!({"limit":100,"cursor":cursor}))
                        .await?;
                    for m in page["data"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|m| m["hidden"] != true)
                    {
                        models.push(json!({"id":m["model"],"label":m["displayName"],"efforts":m["supportedReasoningEfforts"].as_array().into_iter().flatten().filter_map(|e|e["reasoningEffort"].as_str()).filter(|e|settings::efforts("codex").contains(e)).collect::<Vec<_>>()}))
                    }
                    cursor = page["nextCursor"].clone();
                    if cursor.is_null() || models.len() >= 1000 {
                        break;
                    }
                    if !cursors.insert(cursor.to_string()) {
                        return err("PROTOCOL_ERROR", "Repeated model catalog cursor");
                    }
                }
            } else {
                for m in init["models"].as_array().into_iter().flatten() {
                    models.push(json!({"id":m["value"],"label":m["displayName"],"efforts":m["supportedEffortLevels"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|e|settings::efforts("claude").contains(e)).collect::<Vec<_>>()}))
                }
                let result = wire.request("get_settings", json!({})).await?;
                let a = &result["applied"];
                let e = result
                    .get("effective")
                    .or(result.get("settings"))
                    .unwrap_or(&Value::Null);
                defaults = json!({"model":a.get("model").unwrap_or(&e["model"]),"effort":a.get("effort").unwrap_or(&e["effortLevel"]),"permissions":a.get("permissionMode").unwrap_or(&e["permissions"]["defaultMode"])});
            }
            wire.close().await;
        }
        models.retain(|m| {
            m["id"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
        });
        models.truncate(1000);
        let mut permissions = settings::permissions(provider);
        for p in permissions.as_array_mut().unwrap() {
            if provider == "codex" && p["id"] != "cli" {
                let options = settings::codex_policy(s(p, "id"));
                let blocked = [
                    ("allowedSandboxModes", "sandbox"),
                    ("allowedApprovalPolicies", "approvalPolicy"),
                ]
                .iter()
                .any(|(key, option)| {
                    restrictions[key]
                        .as_array()
                        .is_some_and(|a| !a.contains(&options[option]))
                });
                if blocked {
                    p["disabled"] = json!(true);
                    p["reason"] = json!("Restricted by CLI policy")
                }
            }
        }
        Ok(
            json!({"provider":provider,"defaults":defaults,"models":models,"permissions":permissions,"efforts":settings::efforts(provider),"source":format!("{provider} CLI"),"loadedAt":now()}),
        )
    }
    pub async fn plan(&self, host: &Host, provider: &str, refresh: bool) -> Result<Value> {
        if !host.remote() || !matches!(provider, "claude" | "codex" | "omp") {
            return err("INVALID_INPUT", "Select a remote CLI");
        }
        let items = self.inspect_host(host, refresh).await;
        let found = items.iter().find(|p| p.public["id"] == provider).unwrap();
        let (package, target) = match provider {
            "codex" => ("@openai/codex", "0.167.0"),
            "claude" => ("@anthropic-ai/claude-code", "2.1.318"),
            _ => ("@oh-my-pi/pi-coding-agent", "18.17.0"),
        };
        let mut plan = json!({"provider":provider,"machineId":host.machine["id"],"targetVersion":target,"beforeVersion":found.public["version"],"canUpdate":false,"method":"manual","reason":format!("Install {package}@{target} using the existing installation method, then refresh versions.")});
        if found.public["available"] == true {
            plan["method"] = json!("none");
            plan["reason"] = json!(format!(
                "Installed {} is compatible; no update needed.",
                s(&found.public, "version")
            ));
            return Ok(plan);
        }
        let Some(file) = &found.executable else {
            return Ok(plan);
        };
        let Some(node) = host.executable("node", None).await? else {
            return Ok(plan);
        };
        let result=host.run(&node,&["-e".into(),"console.log(JSON.stringify({path:require('fs').realpathSync(process.argv[1])}))".into(),file.clone()],None,15,8192).await;
        let Ok(out) = result else { return Ok(plan) };
        let path: Value = serde_json::from_str(&out)?;
        let canonical = s(&path, "path");
        let part = format!("/node_modules/{package}/");
        let (method, executable, args) =
            if provider == "claude" && canonical.contains("/.local/share/claude/versions/") {
                (
                    "Claude native installer",
                    Some(file.clone()),
                    vec!["install".into(), target.into()],
                )
            } else if canonical.contains("/.bun/install/global/") && canonical.contains(&part) {
                (
                    "bun",
                    host.executable("bun", None).await?,
                    vec![
                        "add".into(),
                        "--global".into(),
                        format!("{package}@{target}"),
                    ],
                )
            } else if canonical.contains("/pnpm/global/") && canonical.contains(&part) {
                (
                    "pnpm",
                    host.executable("pnpm", None).await?,
                    vec![
                        "add".into(),
                        "--global".into(),
                        format!("{package}@{target}"),
                    ],
                )
            } else if let Some(pos) = canonical.find(&format!("/lib{part}")) {
                (
                    "npm",
                    host.executable("npm", None).await?,
                    vec![
                        "install".into(),
                        "--global".into(),
                        "--prefix".into(),
                        if pos == 0 {
                            "/".into()
                        } else {
                            canonical[..pos].into()
                        },
                        format!("{package}@{target}"),
                    ],
                )
            } else {
                return Ok(plan);
            };
        let Some(executable) = executable else {
            return Ok(plan);
        };
        plan["canUpdate"] = json!(true);
        plan["method"] = json!(method);
        plan.as_object_mut().unwrap().remove("reason");
        plan["token"] = json!(hash(
            json!([
                host.machine["id"],
                provider,
                file,
                found.public["version"],
                canonical,
                executable,
                args
            ])
            .to_string()
        ));
        plan["command"] = json!(
            std::iter::once(executable.as_str())
                .chain(args.iter().map(String::as_str))
                .map(quote)
                .collect::<Vec<_>>()
                .join(" ")
        );
        plan["executable"] = json!(executable);
        plan["args"] = json!(args);
        Ok(plan)
    }
    /// Drops cached CLI inspections after a machine's address changes or it is removed.
    pub async fn forget_machine(&self, machine: &str) {
        self.cache
            .lock()
            .await
            .retain(|key, _| key.split('\n').next() != Some(machine));
    }
    fn running_job<'a>(jobs: &'a HashMap<String, Value>, machine: &str, provider: Option<&str>) -> Option<&'a Value> {
        jobs.values().find(|j| {
            j["machineId"] == machine
                && provider.is_none_or(|p| j["provider"] == p)
                && j["status"] == "running"
        })
    }
    pub async fn updating(&self, machine: &str, provider: &str) -> bool {
        Self::running_job(&*self.jobs.lock().await, machine, Some(provider)).is_some()
    }
    pub async fn machine_updating(&self, machine: &str) -> bool {
        Self::running_job(&*self.jobs.lock().await, machine, None).is_some()
    }
    /// Freshly inspected CLI availability, without capabilities or job state.
    pub async fn summary(&self, host: &Host) -> Value {
        json!(
            self.inspect_host(host, true)
                .await
                .into_iter()
                .map(|found| {
                    let mut v = json!({});
                    for k in ["id", "label", "available", "version", "reason"] {
                        if let Some(x) = found.public.get(k) {
                            v[k] = x.clone()
                        }
                    }
                    v
                })
                .collect::<Vec<_>>()
        )
    }
    /// Remote planning for an update; runs without holding the engine gate.
    pub async fn prepare_update(&self, host: &Host, p: &Value) -> Result<Prepared> {
        let provider = required(p, "provider", 32)?;
        let machine = s(&host.machine, "id");
        if let Some(job) = Self::running_job(&*self.jobs.lock().await, machine, Some(&provider)) {
            return Ok(Prepared::Running(job.clone()));
        }
        let plan = self.plan(host, &provider, true).await?;
        if plan["canUpdate"] != true {
            return err("UNSUPPORTED", s(&plan, "reason"));
        }
        if p["token"] != plan["token"] {
            return err(
                "CONFLICT",
                "Update plan changed; refresh and review the target again",
            );
        }
        Ok(Prepared::Ready { provider, plan })
    }
    /// Registers and starts a prepared update; called while new turns are excluded.
    pub async fn start_update(self: &Arc<Self>, host: Host, prepared: Prepared) -> Result<Value> {
        let (provider, plan) = match prepared {
            Prepared::Running(job) => return Ok(job),
            Prepared::Ready { provider, plan } => (provider, plan),
        };
        let job = json!({"id":id(),"machineId":host.machine["id"],"provider":provider,"status":"running","beforeVersion":plan["beforeVersion"],"targetVersion":plan["targetVersion"],"method":plan["method"],"startedAt":now()});
        {
            let mut jobs = self.jobs.lock().await;
            if let Some(running) = Self::running_job(&jobs, s(&host.machine, "id"), Some(&provider)) {
                return Ok(running.clone());
            }
            if jobs.len() >= 32 {
                if let Some(old) = jobs
                    .iter()
                    .find(|(_, j)| j["status"] != "running")
                    .map(|(k, _)| k.clone())
                {
                    jobs.remove(&old);
                } else {
                    return err("BUSY", "Too many active update jobs");
                }
            }
            jobs.insert(s(&job, "id").into(), job.clone());
        }
        let registry = self.clone();
        let job_id = s(&job, "id").to_owned();
        tokio::spawn(async move {
            let args = plan["args"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a.as_str().unwrap().to_owned())
                .collect::<Vec<_>>();
            let result = host
                .run(s(&plan, "executable"), &args, None, 120, 512 * 1024)
                .await;
            let after = registry.inspect(&host, &provider).await;
            registry.cache.lock().await.remove(&cache_key(&host));
            let mut jobs = registry.jobs.lock().await;
            if let Some(job) = jobs.get_mut(&job_id) {
                let good = result.is_ok()
                    && after.public["available"] == true
                    && after.public["version"] == plan["targetVersion"];
                job["status"] = json!(if good { "completed" } else { "failed" });
                job["version"] = after.public["version"].clone();
                job["compatible"] = after.public["available"].clone();
                job["message"] = json!(if good {
                    format!(
                        "Installed {}. Ready for new sessions.",
                        s(&after.public, "version")
                    )
                } else {
                    format!(
                        "Could not verify the pinned update. Check the selected executable and PATH, then refresh versions. {}",
                        result.err().map(|e| e.message).unwrap_or_default()
                    )
                });
                job["finishedAt"] = json!(now());
            }
        });
        Ok(job)
    }
}
