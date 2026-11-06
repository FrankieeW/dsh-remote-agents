use crate::{
    common::*,
    herdr,
    hosts::{Host, valid_ssh},
};
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};
pub struct FleetLock {
    _file: File,
    path: PathBuf,
}
impl Drop for FleetLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
pub struct Fleet {
    pub path: PathBuf,
    pub state: Value,
}
fn uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}
impl Fleet {
    pub fn new(path: PathBuf) -> Result<Self> {
        let mut f = Self {
            path,
            state: Value::Null,
        };
        f.reload()?;
        Ok(f)
    }
    pub fn reload(&mut self) -> Result<()> {
        let mut v = load_or(
            &self.path,
            json!({"version":1,"namespace":id(),"machines":[{"id":"local","name":"Local","type":"local"}],"agents":[],"projects":[]}),
            16 * 1024 * 1024,
        )?;
        if v.get("projects").is_none() {
            v["projects"] = json!([])
        }
        if v["version"] != 1
            || !uuid(&v["namespace"])
            || !["machines", "projects", "agents"]
                .iter()
                .all(|k| v[k].is_array())
        {
            return err("INVALID_STATE", "Unsupported fleet schema");
        }
        let mut ids = std::collections::HashSet::new();
        for m in v["machines"].as_array().unwrap() {
            if !ids.insert(s(m, "id").to_owned())
                || !((s(m, "id") == "local" && s(m, "type") == "local")
                    || (uuid(&m["id"]) && s(m, "type") == "ssh" && valid_ssh(m)))
            {
                return err("INVALID_STATE", "Invalid machine record");
            }
        }
        if !ids.contains("local") {
            return err("INVALID_STATE", "Missing local machine");
        }
        let mut projects = std::collections::HashSet::new();
        for p in v["projects"].as_array().unwrap() {
            if !uuid(&p["id"])
                || !projects.insert(s(p, "id"))
                || !ids.contains(s(p, "machineId"))
                || absolute(s(p, "cwd")).is_err()
                || text(&p["name"], 100, false).is_err()
                || !matches!(s(p, "source"), "workspace" | "herdr")
            {
                return err("INVALID_STATE", "Invalid project record");
            }
        }
        let mut agents = std::collections::HashSet::new();
        for a in v["agents"].as_array().unwrap() {
            if !uuid(&a["id"])
                || !agents.insert(s(a, "id"))
                || !uuid(&a["owner"])
                || !ids.contains(s(a, "machineId"))
                || !s(a, "session").starts_with("dsh-")
                || !s(a, "session").ends_with(&s(a, "id").replace('-', ""))
                || !matches!(s(a, "status"), "running" | "exited" | "unknown")
                || !matches!(s(a, "kind"), "shell" | "dsh" | "codex" | "claude")
            {
                return err("INVALID_STATE", "Invalid agent record");
            }
        }
        self.state = v;
        Ok(())
    }
    pub fn save(&self) -> Result<()> {
        atomic_json(&self.path, &self.state, 16 * 1024 * 1024)
    }
    pub async fn lock(&self) -> Result<FleetLock> {
        std::fs::create_dir_all(self.path.parent().unwrap())?;
        let path = self.path.with_extension("json.lock");
        let start = Instant::now();
        loop {
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(file) => return Ok(FleetLock { _file: file, path }),
                Err(e)
                    if e.kind() == std::io::ErrorKind::AlreadyExists
                        && start.elapsed() < Duration::from_millis(1500) =>
                {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    return err(
                        "STATE_LOCKED",
                        "Another writer holds the fleet lock; inspect the writer before removing a stale lock",
                    );
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    pub fn host(&self, id: &str) -> Result<Host> {
        self.state["machines"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| s(m, "id") == id)
            .cloned()
            .map(|machine| Host { machine })
            .ok_or_else(|| Error::new("NOT_FOUND", "Machine not found"))
    }
    fn agent_index(&self, id: &str) -> Result<usize> {
        self.state["agents"]
            .as_array()
            .unwrap()
            .iter()
            .position(|a| s(a, "id") == id)
            .ok_or_else(|| Error::new("NOT_FOUND", "Agent not found"))
    }
    pub async fn tmux(&self, machine: &str, args: &[String]) -> Result<String> {
        self.host(machine)?
            .run(
                "tmux",
                &[
                    vec![
                        "-L".into(),
                        format!("dsh-fleet-{}", s(&self.state, "namespace")),
                    ],
                    args.to_vec(),
                ]
                .concat(),
                None,
                10,
                256 * 1024,
            )
            .await
    }
    fn target(a: &Value) -> String {
        a.get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(s(a, "session"))
            .into()
    }
    fn pane(a: &Value) -> String {
        format!(
            "{}:main",
            a.get("sessionId")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("={}", s(a, "session")))
        )
    }
    async fn inspect(&self, a: &Value) -> Result<Value> {
        if a.get("stoppedAt").is_some() {
            return Ok(json!({"status":"exited","owned":false}));
        }
        let args = vec![
            "display-message".into(),
            "-p".into(),
            "-t".into(),
            Self::pane(a),
            "#{session_name}\t#{@dsh_fleet_owner}\t#{pane_dead}\t#{session_id}".into(),
        ];
        match self.tmux(s(a, "machineId"), &args).await {
            Ok(out) => {
                let fields = out.trim().split('\t').collect::<Vec<_>>();
                if fields.len() == 4
                    && fields[0] == s(a, "session")
                    && fields[1] == s(a, "owner")
                    && ["0", "1"].contains(&fields[2])
                    && fields[3].starts_with('$')
                    && fields[3][1..].parse::<u64>().is_ok()
                {
                    Ok(
                        json!({"status":if fields[2]=="1"{"exited"}else{"running"},"owned":true,"sessionId":fields[3]}),
                    )
                } else {
                    Ok(
                        json!({"status":"unknown","owned":false,"diagnostic":"Session ownership could not be verified"}),
                    )
                }
            }
            Err(e) => Ok(json!({"status":"unknown","owned":false,"diagnostic":e.message})),
        }
    }
    pub async fn call(&mut self, method: &str, p: &Value) -> Result<Value> {
        let read_only = matches!(
            method,
            "snapshot" | "workspaceCatalog" | "previewHerdr" | "namespace"
        );
        let _lock = if read_only {
            None
        } else {
            Some(self.lock().await?)
        };
        self.reload()?;
        let result = self.operate(method, p).await;
        if !read_only {
            self.save()?
        }
        result
    }
    async fn operate(&mut self, method: &str, p: &Value) -> Result<Value> {
        match method {
            "snapshot" => Ok(
                json!({"version":1,"machines":self.state["machines"],"projects":self.state["projects"],"agents":self.state["agents"]}),
            ),
            "namespace" => Ok(self.state["namespace"].clone()),
            "workspaceCatalog" => Ok(
                json!({"machines":self.state["machines"],"workspaces":self.state["projects"].as_array().unwrap().iter().filter(|p|p["machineId"]!="local").map(|p|json!({"workspaceId":p["id"],"path":p["cwd"],"title":p["name"],"machineId":p["machineId"],"machineName":self.state["machines"].as_array().unwrap().iter().find(|m|m["id"]==p["machineId"]).map(|m|m["name"].clone())})).collect::<Vec<_>>()}),
            ),
            "addMachine" => {
                let name = required(p, "name", 128)?;
                if !valid_ssh(p) {
                    return err("INVALID_INPUT", "Invalid SSH host, user or port");
                }
                if self.state["machines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| s(m, "type") == "ssh" && herdr::key(m) == herdr::key(p))
                {
                    return err("CONFLICT", "Machine already exists");
                }
                let mut m = json!({"id":id(),"type":"ssh","name":name,"host":p["host"]});
                for k in ["user", "port"] {
                    if let Some(v) = p.get(k) {
                        m[k] = v.clone()
                    }
                }
                self.state["machines"]
                    .as_array_mut()
                    .unwrap()
                    .push(m.clone());
                Ok(m)
            }
            "removeMachine" => {
                let id = required(p, "machineId", 128)?;
                self.host(&id)?;
                if id == "local" {
                    return err("INVALID_INPUT", "Cannot remove local machine");
                }
                if self.state["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| s(v, "machineId") == id)
                    || self.state["agents"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|a| s(a, "machineId") == id && a.get("stoppedAt").is_none())
                {
                    return err(
                        "CONFLICT",
                        "Stop managed agents and remove workspace registrations before removing this machine",
                    );
                }
                self.state["machines"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|m| s(m, "id") != id);
                self.state["agents"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|a| s(a, "machineId") != id);
                Ok(json!({"machineId":id,"removed":true}))
            }
            "workspaceAdd" => {
                let machine = p
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("local");
                let cwd = self.host(machine)?.directory(s(p, "path")).await?;
                if let Some(v) = self.state["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|v| s(v, "machineId") == machine && s(v, "cwd") == cwd)
                {
                    return Ok(v.clone());
                }
                let name = std::path::Path::new(&cwd)
                    .file_name()
                    .and_then(|p| p.to_str())
                    .unwrap_or("Project");
                let v = json!({"id":id(),"machineId":machine,"cwd":cwd,"name":name,"source":"workspace"});
                self.state["projects"]
                    .as_array_mut()
                    .unwrap()
                    .push(v.clone());
                Ok(v)
            }
            "workspaceRemove" => {
                let id = required(p, "workspaceId", 128)?;
                if !self.state["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| s(p, "id") == id)
                {
                    return err("NOT_FOUND", "Workspace not found");
                }
                if self.state["agents"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|a| s(a, "projectId") == id)
                {
                    return err("BUSY", "Workspace has managed terminal records");
                }
                self.state["projects"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|p| s(p, "id") != id);
                Ok(json!({"removed":true}))
            }
            "probe" => {
                let machine = p
                    .get("machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("local");
                match self.tmux(machine, &["-V".into()]).await {
                    Ok(v) => Ok(json!({"machineId":machine,"ok":true,"version":v.trim()})),
                    Err(e) => Ok(json!({"machineId":machine,"ok":false,"error":e.message})),
                }
            }
            "previewHerdr" => herdr::preview(p, &self.state),
            "importHerdr" => {
                let preview = herdr::preview(p, &self.state)?;
                if p["confirmation"] != preview["digest"] {
                    return err(
                        "STALE_PREVIEW",
                        "Import confirmation is missing or stale; preview again",
                    );
                }
                let mut mids = vec![];
                let mut pids = vec![];
                for item in preview["machines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["action"] == "add")
                {
                    let mut m = item.clone();
                    m.as_object_mut().unwrap().remove("action");
                    m["id"] = json!(id());
                    m["type"] = json!("ssh");
                    mids.push(m["id"].clone());
                    self.state["machines"].as_array_mut().unwrap().push(m)
                }
                for item in preview["projects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|m| m["action"] == "add")
                {
                    let mut v = item.clone();
                    v.as_object_mut().unwrap().remove("action");
                    v["id"] = json!(id());
                    v["source"] = json!("herdr");
                    pids.push(v["id"].clone());
                    self.state["projects"].as_array_mut().unwrap().push(v)
                }
                let mut result = preview;
                result["imported"] = json!({"machines":mids.len(),"projects":pids.len()});
                result["importedMachineIds"] = json!(mids);
                result["importedProjectIds"] = json!(pids);
                Ok(result)
            }
            "start" => self.start(p).await,
            "read" | "send" | "interrupt" | "stop" => self.agent_action(method, p).await,
            _ => err("NOT_FOUND", "Unknown fleet operation"),
        }
    }
    async fn start(&mut self, p: &Value) -> Result<Value> {
        let machine = p
            .get("machineId")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_owned();
        self.host(&machine)?;
        let name = required(p, "name", 100)?;
        let cwd = required(p, "cwd", 4096)?;
        absolute(&cwd)?;
        let kind = s(p, "kind");
        if !matches!(kind, "shell" | "dsh" | "codex" | "claude") {
            return err("INVALID_INPUT", "Unsupported agent kind");
        }
        let args = p.get("args").cloned().unwrap_or(json!([]));
        let args = args
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid args"))?;
        for arg in args {
            if !arg.is_string()
                || s(&json!({"v":arg}), "v").len() > 4096
                || arg
                    .as_str()
                    .unwrap()
                    .chars()
                    .any(|c| c < ' ' || c == '\u{7f}')
            {
                return err("INVALID_INPUT", "Invalid args");
            }
        }
        let uuid = id();
        let slug = clip(
            &std::path::Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("root")
                .to_lowercase()
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' {
                        c
                    } else {
                        '-'
                    }
                })
                .collect::<String>(),
            24,
        );
        let mut a = json!({"id":uuid,"machineId":machine,"name":name,"cwd":cwd,"kind":kind,"args":args,"session":format!("dsh-{}-{}",slug,uuid.replace('-', "")),"owner":id(),"status":"unknown","createdAt":now(),"updatedAt":now()});
        match self
            .tmux(
                &machine,
                &["has-session".into(), "-t".into(), Self::target(&a)],
            )
            .await
        {
            Err(e) if e.code == "1" => {}
            Err(e) => return Err(e),
            Ok(_) => return err("CONFLICT", "Generated terminal already exists"),
        };
        let index = self.state["agents"].as_array().unwrap().len();
        self.state["agents"].as_array_mut().unwrap().push(a.clone());
        self.save()?;
        let result: Result<()> = async {
            let sid = self
                .tmux(
                    &machine,
                    &[
                        "new-session".into(),
                        "-d".into(),
                        "-P".into(),
                        "-F".into(),
                        "#{session_id}".into(),
                        "-s".into(),
                        s(&a, "session").into(),
                        "-n".into(),
                        "main".into(),
                        "-c".into(),
                        cwd.clone(),
                    ],
                )
                .await?;
            let sid = sid.trim();
            if !sid.starts_with('$') || sid[1..].parse::<u64>().is_err() {
                return err("INVALID_SESSION", "Invalid tmux session ID");
            }
            a["sessionId"] = json!(sid);
            self.tmux(
                &machine,
                &[
                    "set-option".into(),
                    "-t".into(),
                    Self::target(&a),
                    "@dsh_fleet_owner".into(),
                    s(&a, "owner").into(),
                ],
            )
            .await?;
            if self.inspect(&a).await?["owned"] != true {
                return err("OWNERSHIP_UNVERIFIED", "Could not verify the new terminal");
            };
            self.tmux(
                &machine,
                &[
                    "set-option".into(),
                    "-w".into(),
                    "-t".into(),
                    Self::pane(&a),
                    "remain-on-exit".into(),
                    "on".into(),
                ],
            )
            .await?;
            let mut command = vec!["exec".into()];
            match kind {
                "shell" => command.extend(["sh".into(), "-i".into()]),
                "dsh" => command.extend(["dsh".into(), "tui".into()]),
                _ => command.push(kind.into()),
            };
            command.extend(args.iter().map(|v| v.as_str().unwrap().to_owned()));
            self.tmux(
                &machine,
                &[
                    "send-keys".into(),
                    "-t".into(),
                    Self::pane(&a),
                    "-l".into(),
                    "--".into(),
                    command
                        .iter()
                        .map(|a| quote(a))
                        .collect::<Vec<_>>()
                        .join(" "),
                ],
            )
            .await?;
            self.tmux(
                &machine,
                &[
                    "send-keys".into(),
                    "-t".into(),
                    Self::pane(&a),
                    "Enter".into(),
                ],
            )
            .await?;
            Ok(())
        }
        .await;
        a["status"] = json!(if result.is_ok() { "running" } else { "unknown" });
        if let Err(e) = result {
            a["diagnostic"] = json!(e.message);
            self.state["agents"][index] = a;
            return err(
                "START_FAILED",
                format!("Agent {uuid} retained for recovery"),
            );
        }
        self.state["agents"][index] = a.clone();
        Ok(a)
    }
    async fn agent_action(&mut self, method: &str, p: &Value) -> Result<Value> {
        let index = self.agent_index(s(p, "agentId"))?;
        let mut a = self.state["agents"][index].clone();
        if method == "stop" && a.get("stoppedAt").is_some() {
            return Ok(a);
        }
        let inspection = self.inspect(&a).await?;
        a["status"] = inspection["status"].clone();
        a["updatedAt"] = json!(now());
        if inspection["sessionId"].is_string() {
            a["sessionId"] = inspection["sessionId"].clone()
        }
        self.state["agents"][index] = a.clone();
        if inspection["owned"] != true {
            if method == "read" {
                return Ok(
                    json!({"agentId":a["id"],"status":a["status"],"output":"","truncated":false,"diagnostic":inspection["diagnostic"]}),
                );
            }
            return err(
                "OWNERSHIP_UNVERIFIED",
                "Terminal ownership could not be verified",
            );
        }
        let machine = s(&a, "machineId");
        if method == "read" {
            let lines = usize_param(p, "lines", 200, 2000)?;
            if lines == 0 {
                return err("INVALID_INPUT", "lines must be 1–2000");
            }
            return match self
                .tmux(
                    machine,
                    &[
                        "capture-pane".into(),
                        "-p".into(),
                        "-t".into(),
                        Self::pane(&a),
                        "-S".into(),
                        format!("-{lines}"),
                    ],
                )
                .await
            {
                Ok(out) => {
                    let entries = out.trim_end_matches('\n').split('\n').collect::<Vec<_>>();
                    Ok(
                        json!({"agentId":a["id"],"status":a["status"],"output":entries[entries.len().saturating_sub(lines)..].join("\n"),"truncated":entries.len()>lines}),
                    )
                }
                Err(e) => {
                    self.state["agents"][index]["status"] = json!("unknown");
                    Ok(
                        json!({"agentId":a["id"],"status":"unknown","output":"","truncated":e.code=="OUTPUT_LIMIT","diagnostic":e.message}),
                    )
                }
            };
        }
        if method == "stop" {
            self.tmux(
                machine,
                &["kill-session".into(), "-t".into(), Self::target(&a)],
            )
            .await?;
            a["status"] = json!("exited");
            a["stoppedAt"] = json!(now());
        } else {
            if inspection["status"] != "running" {
                return err("NOT_RUNNING", "Agent is not running");
            }
            let key = if method == "interrupt" {
                Some("C-c")
            } else {
                p.get("key").and_then(Value::as_str)
            };
            if let Some(key) = key {
                if !["C-c", "C-d", "Escape", "Enter", "Tab", "Up", "Down"].contains(&key)
                    || p.get("text").is_some()
                {
                    return err("INVALID_INPUT", "Invalid key input");
                }
                self.tmux(
                    machine,
                    &["send-keys".into(), "-t".into(), Self::pane(&a), key.into()],
                )
                .await?;
            } else {
                let input = required(p, "text", 16384)?;
                let enter = p
                    .get("enter")
                    .unwrap_or(&Value::Bool(true))
                    .as_bool()
                    .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid enter flag"))?;
                self.tmux(
                    machine,
                    &[
                        "send-keys".into(),
                        "-t".into(),
                        Self::pane(&a),
                        "-l".into(),
                        "--".into(),
                        input,
                    ],
                )
                .await?;
                if enter {
                    self.tmux(
                        machine,
                        &[
                            "send-keys".into(),
                            "-t".into(),
                            Self::pane(&a),
                            "Enter".into(),
                        ],
                    )
                    .await?;
                }
            }
        }
        self.state["agents"][index] = a.clone();
        Ok(a)
    }
}
