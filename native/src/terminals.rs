//! Legacy tmux terminals. Remote I/O runs outside fleet transactions; each
//! agent's operations are serialized so status updates stay ordered.
use crate::{
    common::*,
    fleet::Fleet,
    hosts::{Captured, Host},
    machines::{machine_param, same_connection, ssh_failure},
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, OwnedMutexGuard};

/// `|`-separated: outside a UTF-8 locale tmux prints control characters such
/// as tabs as `_`, and none of these fields can contain `|`.
const FORMAT: &str = "#{session_name}|#{@dsh_fleet_owner}|#{pane_dead}|#{session_id}";
const GONE: &str = "This terminal session no longer exists; the machine may have restarted. Stop it to clear the record.";
const KEYS: [&str; 7] = ["C-c", "C-d", "Escape", "Enter", "Tab", "Up", "Down"];

enum Presence {
    Stopped,
    Owned { dead: bool, id: String },
    Absent,
    Unverified(String),
    Unreachable(String),
}
enum Lookup {
    Owned { dead: bool, id: String },
    Missing,
    Failed(String),
}
enum Input<'a> {
    Key(&'a str),
    Text(String, bool),
}
#[derive(Default)]
pub struct Terminals {
    locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
}
async fn tmux(host: &Host, ns: &str, args: &[String]) -> Result<Captured> {
    let argv = [vec!["-L".into(), format!("dsh-fleet-{ns}")], args.to_vec()].concat();
    host.capture("tmux", &argv, None, 10, 256 * 1024, None).await
}
fn failure(host: &Host, c: &Captured) -> Error {
    if host.remote() && c.code == Some(255) {
        return Error::new("UNREACHABLE", ssh_failure(&host.machine, &c.stderr).1);
    }
    if c.code == Some(127) {
        return Error::new("UNREACHABLE", "tmux is not installed on this machine");
    }
    Error::new(&c.code.unwrap_or(-1).to_string(), "tmux command failed")
}
async fn tmux_ok(host: &Host, ns: &str, args: &[&str]) -> Result<String> {
    let args = args.iter().map(|a| a.to_string()).collect::<Vec<_>>();
    let c = tmux(host, ns, &args).await?;
    if c.code != Some(0) {
        return Err(failure(host, &c));
    }
    Ok(String::from_utf8_lossy(&c.stdout).into_owned())
}
/// tmux's own report that the server or the named session does not exist:
/// exit 1 with that message as the last stderr line. Earlier lines may come
/// from the remote login shell and are ignored.
fn absent(c: &Captured) -> bool {
    if c.code != Some(1) {
        return false;
    }
    let l = c
        .stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("")
        .to_ascii_lowercase();
    l.contains("can't find session")
        || l.contains("no server running")
        || l.contains("error connecting to")
            && (l.contains("no such file or directory") || l.contains("connection refused"))
}
async fn lookup(host: &Host, ns: &str, a: &Value, target: String) -> Lookup {
    let args = ["display-message".into(), "-p".into(), "-t".into(), target, FORMAT.into()];
    match tmux(host, ns, &args).await {
        Err(e) => Lookup::Failed(e.message),
        Ok(c) if c.code == Some(0) => {
            let out = String::from_utf8_lossy(&c.stdout);
            let f = out.trim_end_matches('\n').split('|').collect::<Vec<_>>();
            if f.len() == 4
                && f[0] == s(a, "session")
                && f[1] == s(a, "owner")
                && ["0", "1"].contains(&f[2])
                && f[3].starts_with('$')
                && f[3][1..].parse::<u64>().is_ok()
            {
                Lookup::Owned { dead: f[2] == "1", id: f[3].into() }
            } else {
                // display-message expands formats even when the target is gone.
                Lookup::Missing
            }
        }
        Ok(c) if absent(&c) => Lookup::Missing,
        Ok(c) => Lookup::Failed(failure(host, &c).message),
    }
}
/// Ownership is verified by owner tag; absence only by tmux's exact-name answer.
async fn presence(host: &Host, ns: &str, a: &Value) -> Presence {
    if a.get("stoppedAt").is_some() {
        return Presence::Stopped;
    }
    let session = s(a, "session");
    let by_id = a.get("sessionId").and_then(Value::as_str);
    let first = by_id.map_or(format!("={session}:main"), |id| format!("{id}:main"));
    match lookup(host, ns, a, first).await {
        Lookup::Owned { dead, id } => return Presence::Owned { dead, id },
        Lookup::Failed(m) => return Presence::Unreachable(m),
        Lookup::Missing => {}
    }
    let exact = ["has-session".into(), "-t".into(), format!("={session}")];
    match tmux(host, ns, &exact).await {
        Err(e) => Presence::Unreachable(e.message),
        Ok(c) if c.code == Some(0) => match by_id {
            Some(_) => match lookup(host, ns, a, format!("={session}:main")).await {
                Lookup::Owned { dead, id } => Presence::Owned { dead, id },
                Lookup::Failed(m) => Presence::Unreachable(m),
                Lookup::Missing => Presence::Unverified("Session ownership could not be verified".into()),
            },
            None => Presence::Unverified("Session ownership could not be verified".into()),
        },
        Ok(c) if absent(&c) => Presence::Absent,
        Ok(c) => Presence::Unreachable(failure(host, &c).message),
    }
}
/// Updates one agent record; `updatedAt` moves only when something changed.
async fn commit(fleet: &Fleet, id: &str, update: impl FnOnce(&mut Value)) -> Result<Value> {
    fleet
        .transaction(|state| {
            let agent = state["agents"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|a| s(a, "id") == id)
                .ok_or_else(|| Error::new("NOT_FOUND", "Agent not found"))?;
            let before = agent.clone();
            update(agent);
            if *agent != before {
                agent["updatedAt"] = json!(now())
            }
            Ok(agent.clone())
        })
        .await
}
fn observe(a: &mut Value, status: &str, session_id: Option<&str>, diagnostic: Option<&str>) {
    if a.get("stoppedAt").is_some() {
        return;
    }
    a["status"] = json!(status);
    if let Some(id) = session_id {
        a["sessionId"] = json!(id)
    }
    match diagnostic {
        Some(d) => a["diagnostic"] = json!(d),
        None => {
            a.as_object_mut().unwrap().remove("diagnostic");
        }
    }
}
fn mark_stopped(a: &mut Value, diagnostic: Option<&str>) {
    a["status"] = json!("exited");
    a["stoppedAt"] = json!(now());
    match diagnostic {
        Some(d) => a["diagnostic"] = json!(d),
        None => {
            a.as_object_mut().unwrap().remove("diagnostic");
        }
    }
}
fn quiet(id: &str, status: &str, diagnostic: Option<&str>) -> Value {
    let mut v = json!({"agentId":id,"status":status,"output":"","truncated":false});
    if let Some(d) = diagnostic {
        v["diagnostic"] = json!(d)
    }
    v
}
impl Terminals {
    async fn guard(&self, id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap();
            locks.retain(|_, l| Arc::strong_count(l) > 1);
            locks.entry(id.into()).or_default().clone()
        };
        lock.lock_owned().await
    }
    async fn context(fleet: &Fleet, id: &str) -> Result<(Value, Host, String)> {
        let state = fleet.load()?;
        let agent = state["agents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| s(a, "id") == id)
            .cloned()
            .ok_or_else(|| Error::new("NOT_FOUND", "Agent not found"))?;
        let host = fleet.host(s(&agent, "machineId"))?;
        Ok((agent, host, s(&state, "namespace").to_owned()))
    }
    pub async fn call(&self, fleet: &Fleet, method: &str, p: &Value) -> Result<Value> {
        let id = required(p, "agentId", 128)?;
        let _guard = self.guard(&id).await;
        match method {
            "forgetAgent" => Self::forget(fleet, &id, p).await,
            "read" => Self::read(fleet, &id, p).await,
            "stop" => Self::stop(fleet, &id).await,
            _ => Self::input(fleet, &id, method, p).await,
        }
    }
    async fn read(fleet: &Fleet, id: &str, p: &Value) -> Result<Value> {
        let lines = usize_param(p, "lines", 200, 2000)?;
        if lines == 0 {
            return err("INVALID_INPUT", "lines must be 1–2000");
        }
        let (agent, host, ns) = Self::context(fleet, id).await?;
        match presence(&host, &ns, &agent).await {
            Presence::Stopped => Ok(quiet(id, "exited", None)),
            Presence::Owned { dead, id: sid } => {
                let status = if dead { "exited" } else { "running" };
                let args = ["capture-pane".into(), "-p".into(), "-t".into(), format!("{sid}:main"), "-S".into(), format!("-{lines}")];
                let captured = tmux(&host, &ns, &args).await;
                let output = match &captured {
                    Ok(c) if c.code == Some(0) => Ok(String::from_utf8_lossy(&c.stdout).into_owned()),
                    Ok(c) => Err((false, failure(&host, c).message)),
                    Err(e) => Err((e.code == "OUTPUT_LIMIT", e.message.clone())),
                };
                match output {
                    Ok(out) => {
                        commit(fleet, id, |a| observe(a, status, Some(&sid), None)).await?;
                        let entries = out.trim_end_matches('\n').split('\n').collect::<Vec<_>>();
                        Ok(json!({"agentId":id,"status":status,"output":entries[entries.len().saturating_sub(lines)..].join("\n"),"truncated":entries.len()>lines}))
                    }
                    Err((truncated, message)) => {
                        commit(fleet, id, |a| observe(a, "unknown", Some(&sid), Some(&message))).await?;
                        let mut v = quiet(id, "unknown", Some(&message));
                        v["truncated"] = json!(truncated);
                        Ok(v)
                    }
                }
            }
            Presence::Absent => {
                commit(fleet, id, |a| observe(a, "exited", None, Some(GONE))).await?;
                let mut v = quiet(id, "exited", Some(GONE));
                v["gone"] = json!(true);
                Ok(v)
            }
            Presence::Unverified(m) | Presence::Unreachable(m) => {
                commit(fleet, id, |a| observe(a, "unknown", None, Some(&m))).await?;
                Ok(quiet(id, "unknown", Some(&m)))
            }
        }
    }
    async fn input(fleet: &Fleet, id: &str, method: &str, p: &Value) -> Result<Value> {
        let key = if method == "interrupt" {
            Some("C-c")
        } else {
            p.get("key").and_then(Value::as_str)
        };
        let input = match key {
            Some(k) if !KEYS.contains(&k) || p.get("text").is_some() => {
                return err("INVALID_INPUT", "Invalid key input");
            }
            Some(k) => Input::Key(k),
            None => Input::Text(
                required(p, "text", 16384)?,
                p.get("enter")
                    .unwrap_or(&Value::Bool(true))
                    .as_bool()
                    .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid enter flag"))?,
            ),
        };
        let (agent, host, ns) = Self::context(fleet, id).await?;
        match presence(&host, &ns, &agent).await {
            Presence::Owned { dead: false, id: sid } => {
                let pane = format!("{sid}:main");
                match input {
                    Input::Key(k) => {
                        tmux_ok(&host, &ns, &["send-keys", "-t", &pane, k]).await?;
                    }
                    Input::Text(t, enter) => {
                        tmux_ok(&host, &ns, &["send-keys", "-t", &pane, "-l", "--", &t]).await?;
                        if enter {
                            tmux_ok(&host, &ns, &["send-keys", "-t", &pane, "Enter"]).await?;
                        }
                    }
                }
                commit(fleet, id, |a| observe(a, "running", Some(&sid), None)).await
            }
            Presence::Owned { dead: true, id: sid } => {
                commit(fleet, id, |a| observe(a, "exited", Some(&sid), None)).await?;
                err("NOT_RUNNING", "Agent is not running")
            }
            Presence::Stopped => err("NOT_RUNNING", "Agent is not running"),
            Presence::Absent => {
                commit(fleet, id, |a| observe(a, "exited", None, Some(GONE))).await?;
                err("NOT_RUNNING", GONE)
            }
            Presence::Unverified(m) => {
                commit(fleet, id, |a| observe(a, "unknown", None, Some(&m))).await?;
                err("OWNERSHIP_UNVERIFIED", "Terminal ownership could not be verified")
            }
            Presence::Unreachable(m) => {
                commit(fleet, id, |a| observe(a, "unknown", None, Some(&m))).await?;
                err("UNREACHABLE", m)
            }
        }
    }
    /// Kills verified sessions, clears records of vanished ones, and never
    /// touches a session whose ownership cannot be confirmed.
    async fn stop(fleet: &Fleet, id: &str) -> Result<Value> {
        let (agent, host, ns) = Self::context(fleet, id).await?;
        match presence(&host, &ns, &agent).await {
            Presence::Stopped => Ok(agent),
            Presence::Owned { id: sid, .. } => {
                tmux_ok(&host, &ns, &["kill-session", "-t", &sid]).await?;
                commit(fleet, id, |a| mark_stopped(a, None)).await
            }
            Presence::Absent => {
                commit(fleet, id, |a| {
                    mark_stopped(a, Some("The session had already ended; the record was marked stopped."))
                })
                .await
            }
            Presence::Unverified(m) => {
                commit(fleet, id, |a| observe(a, "unknown", None, Some(&m))).await?;
                err(
                    "OWNERSHIP_UNVERIFIED",
                    format!("{m}. Forget the record to stop managing it; nothing is terminated."),
                )
            }
            Presence::Unreachable(m) => {
                commit(fleet, id, |a| observe(a, "unknown", None, Some(&m))).await?;
                err(
                    "UNREACHABLE",
                    format!("{m} Forget the record if the machine is gone; nothing is terminated."),
                )
            }
        }
    }
    /// Deletes a record without touching any process.
    async fn forget(fleet: &Fleet, id: &str, p: &Value) -> Result<Value> {
        let force = crate::machines::flag(p, "force")?;
        fleet
            .transaction(|state| {
                let agents = state["agents"].as_array_mut().unwrap();
                let index = agents
                    .iter()
                    .position(|a| s(a, "id") == id)
                    .ok_or_else(|| Error::new("NOT_FOUND", "Agent not found"))?;
                if agents[index].get("stoppedAt").is_none() && !force {
                    return err(
                        "CONFLICT",
                        "This terminal is not stopped. Stop it, or confirm forgetting it; forgetting never terminates the session.",
                    );
                }
                agents.remove(index);
                Ok(json!({"agentId":id,"forgotten":true}))
            })
            .await
    }
    pub async fn start(&self, fleet: &Fleet, p: &Value) -> Result<Value> {
        let machine = machine_param(p)?;
        let host = fleet.host(&machine)?;
        let name = required(p, "name", 100)?;
        let cwd = required(p, "cwd", 4096)?;
        absolute(&cwd)?;
        let kind = s(p, "kind").to_owned();
        if !matches!(kind.as_str(), "shell" | "dsh" | "codex" | "claude") {
            return err("INVALID_INPUT", "Unsupported agent kind");
        }
        let args = p.get("args").cloned().unwrap_or(json!([]));
        let args = args
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid args"))?
            .iter()
            .map(|arg| {
                arg.as_str()
                    .filter(|a| a.len() <= 4096 && !a.chars().any(|c| c < ' ' || c == '\u{7f}'))
                    .map(String::from)
                    .ok_or_else(|| Error::new("INVALID_INPUT", "Invalid args"))
            })
            .collect::<Result<Vec<_>>>()?;
        let ns = fleet.namespace().await?;
        let uuid = id();
        // Held until creation finishes, so stop/forget on the new record wait for it.
        let _guard = self.guard(&uuid).await;
        let slug = clip(
            &std::path::Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("root")
                .to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
                .collect::<String>(),
            24,
        );
        let session = format!("dsh-{slug}-{}", uuid.replace('-', ""));
        let agent = json!({"id":uuid,"machineId":machine,"name":name,"cwd":cwd,"kind":kind,"args":args,"session":session,"owner":id(),"status":"unknown","createdAt":now(),"updatedAt":now()});
        let exact = ["has-session".into(), "-t".into(), format!("={session}")];
        match tmux(&host, &ns, &exact).await? {
            c if c.code == Some(0) => return err("CONFLICT", "Generated terminal already exists"),
            c if absent(&c) => {}
            c => return Err(failure(&host, &c)),
        }
        // Persist first so a crash mid-start leaves a record that can be stopped.
        // Once saved, an unstopped record blocks address changes and removal.
        fleet
            .transaction(|state| {
                match state["machines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| s(m, "id") == machine && m.get("removedAt").is_none())
                {
                    None => {
                        return err("MACHINE_REMOVED", "The machine was removed while starting the terminal");
                    }
                    Some(m) if !same_connection(m, &host.machine) => {
                        return err(
                            "CONFLICT",
                            "This machine's SSH address changed while the terminal was prepared; start it again",
                        );
                    }
                    Some(_) => {}
                }
                state["agents"].as_array_mut().unwrap().push(agent.clone());
                Ok(())
            })
            .await?;
        match Self::create(&host, &ns, &agent, &kind, &args, &cwd).await {
            Ok(sid) => commit(fleet, &uuid, |a| observe(a, "running", Some(&sid), None)).await,
            Err(e) => {
                commit(fleet, &uuid, |a| observe(a, "unknown", None, Some(&e.message))).await?;
                err("START_FAILED", format!("Agent {uuid} retained for recovery: {}", e.message))
            }
        }
    }
    async fn create(host: &Host, ns: &str, agent: &Value, kind: &str, args: &[String], cwd: &str) -> Result<String> {
        let session = s(agent, "session");
        let out = tmux_ok(host, ns, &["new-session", "-d", "-P", "-F", "#{session_id}", "-s", session, "-n", "main", "-c", cwd]).await?;
        let sid = out.trim().to_owned();
        if !sid.starts_with('$') || sid[1..].parse::<u64>().is_err() {
            return err("INVALID_SESSION", "Invalid tmux session ID");
        }
        tmux_ok(host, ns, &["set-option", "-t", &sid, "@dsh_fleet_owner", s(agent, "owner")]).await?;
        let mut check = agent.clone();
        check["sessionId"] = json!(sid);
        if !matches!(presence(host, ns, &check).await, Presence::Owned { .. }) {
            return err("OWNERSHIP_UNVERIFIED", "Could not verify the new terminal");
        }
        let pane = format!("{sid}:main");
        tmux_ok(host, ns, &["set-option", "-w", "-t", &pane, "remain-on-exit", "on"]).await?;
        let mut command = vec!["exec".to_owned()];
        match kind {
            "shell" => command.extend(["sh".into(), "-i".into()]),
            "dsh" => command.extend(["dsh".into(), "tui".into()]),
            _ => command.push(kind.into()),
        };
        command.extend(args.iter().cloned());
        let line = command.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
        tmux_ok(host, ns, &["send-keys", "-t", &pane, "-l", "--", &line]).await?;
        tmux_ok(host, ns, &["send-keys", "-t", &pane, "Enter"]).await?;
        Ok(sid)
    }
}

#[cfg(test)]
mod tests {
    use super::{Captured, absent};
    fn exit(code: i32, stderr: &str) -> Captured {
        Captured {
            code: Some(code),
            stdout: vec![],
            stderr: stderr.into(),
        }
    }
    #[test]
    fn absence_is_only_tmux_saying_so() {
        assert!(absent(&exit(1, "can't find session: dsh-x")));
        assert!(absent(&exit(1, "no server running on /tmp/tmux-501/dsh-fleet-x\n")));
        assert!(absent(&exit(1, "error connecting to /tmp/tmux-501/x (No such file or directory)")));
        assert!(!absent(&exit(1, "error connecting to /tmp/tmux-501/x (Permission denied)")));
        assert!(!absent(&exit(255, "Host key verification failed.")));
        // A login shell's own tmux output must not be mistaken for tmux's answer.
        assert!(!absent(&exit(127, "no server running on /tmp/tmux-501/default\nsh: tmux: not found")));
        assert!(!absent(&exit(1, "no server running on /tmp/tmux-501/default\nerror connecting to /tmp/x (Permission denied)")));
    }
}
