//! Durable machine/project/terminal records. Every change is a short
//! transaction under an advisory file lock; remote I/O never happens inside one.
use crate::{
    common::*,
    herdr,
    hosts::{Host, valid_ssh},
    machines::machine_key,
};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const STATE_LIMIT: usize = 16 * 1024 * 1024;
const LOCK_WAIT: Duration = Duration::from_millis(1500);

pub struct Fleet {
    pub path: PathBuf,
    writer: Mutex<()>,
}
fn uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
}
fn default_state() -> Value {
    json!({"version":1,"namespace":id(),"machines":[{"id":"local","name":"Local","type":"local"}],"agents":[],"projects":[]})
}
fn list<'a>(state: &'a Value, key: &str) -> &'a Vec<Value> {
    state[key].as_array().unwrap()
}
fn list_mut<'a>(state: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    state[key].as_array_mut().unwrap()
}
fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}
fn names(items: &[&Value]) -> String {
    let mut shown = items
        .iter()
        .take(3)
        .map(|v| format!("“{}”", s(v, "name")))
        .collect::<Vec<_>>()
        .join(", ");
    if items.len() > 3 {
        shown.push_str(&format!(" and {} more", items.len() - 3))
    }
    shown
}
/// The machine fields a `Host` needs; probe results stay out of process arguments.
fn connection_view(m: &Value) -> Value {
    let mut v = json!({});
    for k in ["id", "type", "name", "host", "user", "port"] {
        if let Some(x) = m.get(k) {
            v[k] = x.clone()
        }
    }
    v
}
fn set_connection(m: &mut Value, connection: &Value) {
    for k in ["host", "user", "port"] {
        m.as_object_mut().unwrap().remove(k);
        if let Some(x) = connection.get(k) {
            m[k] = x.clone()
        }
    }
}
fn set_check(m: &mut Value, check: Option<Value>) {
    match check {
        Some(c) => m["lastCheck"] = c,
        None => {
            m.as_object_mut().unwrap().remove("lastCheck");
        }
    }
}
fn removed(m: &Value) -> bool {
    m.get("removedAt").is_some()
}
fn removed_error(m: &Value) -> Error {
    Error::new(
        "MACHINE_REMOVED",
        format!(
            "“{}” was removed. Re-add it or restore it in Machines & projects to continue.",
            s(m, "name")
        ),
    )
}
/// Validates a loaded state; drops malformed cached probe results.
fn validate(v: &mut Value) -> Result<()> {
    if v.get("projects").is_none() {
        v["projects"] = json!([])
    }
    if v["version"] != 1
        || !uuid(&v["namespace"])
        || !["machines", "projects", "agents"].iter().all(|k| v[k].is_array())
    {
        return err("INVALID_STATE", "Unsupported fleet schema");
    }
    let mut ids = HashSet::new();
    for (i, m) in list_mut(v, "machines").iter_mut().enumerate() {
        let local = s(m, "id") == "local" && s(m, "type") == "local" && !removed(m);
        let ssh = uuid(&m["id"]) && s(m, "type") == "ssh" && valid_ssh(m);
        if !ids.insert(s(m, "id").to_owned())
            || !(local || ssh)
            || !m.get("removedAt").is_none_or(Value::is_string)
        {
            return err("INVALID_STATE", format!("Invalid machine record #{}", i + 1));
        }
        if m.get("lastCheck").is_some_and(|c| !c["checkedAt"].is_string() || !c["ok"].is_boolean()) {
            m.as_object_mut().unwrap().remove("lastCheck");
        }
    }
    if !ids.contains("local") {
        return err("INVALID_STATE", "Missing local machine");
    }
    let mut projects = HashSet::new();
    for (i, p) in list(v, "projects").iter().enumerate() {
        if !uuid(&p["id"])
            || !projects.insert(s(p, "id"))
            || !ids.contains(s(p, "machineId"))
            || absolute(s(p, "cwd")).is_err()
            || text(&p["name"], 100, false).is_err()
            || !matches!(s(p, "source"), "workspace" | "herdr")
        {
            return err("INVALID_STATE", format!("Invalid project record #{}", i + 1));
        }
    }
    let mut agents = HashSet::new();
    for (i, a) in list(v, "agents").iter().enumerate() {
        if !uuid(&a["id"])
            || !agents.insert(s(a, "id"))
            || !uuid(&a["owner"])
            || !ids.contains(s(a, "machineId"))
            || !s(a, "session").starts_with("dsh-")
            || !s(a, "session").ends_with(&s(a, "id").replace('-', ""))
            || !matches!(s(a, "status"), "running" | "exited" | "unknown")
            || !matches!(s(a, "kind"), "shell" | "dsh" | "codex" | "claude")
        {
            return err("INVALID_STATE", format!("Invalid agent record #{}", i + 1));
        }
    }
    Ok(())
}
fn machine_index(state: &Value, id: &str) -> Result<usize> {
    list(state, "machines")
        .iter()
        .position(|m| s(m, "id") == id)
        .ok_or_else(|| Error::new("NOT_FOUND", "Machine not found"))
}
/// Other machine records with the same address. Older states may hold several.
fn same_address<'a>(state: &'a Value, connection: &Value, except: &'a str) -> impl Iterator<Item = &'a Value> {
    let key = machine_key(connection);
    list(state, "machines")
        .iter()
        .filter(move |m| s(m, "type") == "ssh" && s(m, "id") != except && machine_key(m) == key)
}
/// The record a new address collides with, preferring active machines.
fn collision<'a>(state: &'a Value, connection: &Value, except: &'a str) -> Option<&'a Value> {
    let mut found = None;
    for m in same_address(state, connection, except) {
        if !removed(m) {
            return Some(m);
        }
        found.get_or_insert(m);
    }
    found
}
fn active_collision<'a>(state: &'a Value, connection: &Value, except: &'a str) -> Option<&'a Value> {
    collision(state, connection, except).filter(|m| !removed(m))
}
fn conflict(other: &Value) -> Error {
    if removed(other) {
        Error::new(
            "CONFLICT",
            format!("The removed machine “{}” uses this address; restore it instead.", s(other, "name")),
        )
    } else {
        Error::new("CONFLICT", format!("“{}” already uses this address.", s(other, "name")))
    }
}
impl Fleet {
    pub fn new(path: PathBuf) -> Result<Self> {
        let fleet = Self {
            path,
            writer: Mutex::new(()),
        };
        fleet.load()?;
        Ok(fleet)
    }
    fn read(&self) -> Result<(Value, bool)> {
        let exists = self.path.exists();
        let mut state = load_or(&self.path, default_state(), STATE_LIMIT as u64)?;
        validate(&mut state)?;
        Ok((state, exists))
    }
    pub fn load(&self) -> Result<Value> {
        Ok(self.read()?.0)
    }
    /// Applies `change` to the latest state and saves it if anything changed.
    /// The state is persisted on first use so its namespace stays stable.
    pub async fn transaction<T>(&self, change: impl FnOnce(&mut Value) -> Result<T>) -> Result<T> {
        let _writer = self.writer.lock().await;
        let _lock = self.lock().await?;
        let (mut state, exists) = self.read()?;
        let before = state.clone();
        let value = change(&mut state)?;
        if !exists || state != before {
            validate(&mut state.clone())?;
            atomic_json(&self.path, &state, STATE_LIMIT)?;
        }
        Ok(value)
    }
    /// An advisory lock that the kernel releases if the holder dies.
    async fn lock(&self) -> Result<File> {
        std::fs::create_dir_all(self.path.parent().unwrap())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.path.with_extension("json.writer.lock"))?;
        let start = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(file),
                Err(e) if e.raw_os_error() != fs2::lock_contended_error().raw_os_error() => {
                    return Err(e.into());
                }
                Err(_) if start.elapsed() < LOCK_WAIT => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(_) => {
                    return err(
                        "STATE_LOCKED",
                        "Another Remote Agents process is updating machines; try again in a moment",
                    );
                }
            }
        }
    }
    /// The tmux namespace, persisting a fresh state first if needed.
    pub async fn namespace(&self) -> Result<String> {
        if self.path.exists() {
            return Ok(s(&self.load()?, "namespace").to_owned());
        }
        self.transaction(|state| Ok(s(state, "namespace").to_owned())).await
    }
    /// An active machine's connection.
    pub fn host(&self, id: &str) -> Result<Host> {
        let state = self.load()?;
        let m = &list(&state, "machines")[machine_index(&state, id)?];
        if removed(m) {
            return Err(removed_error(m));
        }
        Ok(Host {
            machine: connection_view(m),
        })
    }
    pub fn snapshot(&self) -> Result<Value> {
        let v = self.load()?;
        Ok(json!({"version":1,"machines":v["machines"],"projects":v["projects"],"agents":v["agents"]}))
    }
    /// Machines (including removed ones, for names) and remote workspaces.
    pub fn catalog(&self) -> Result<Value> {
        let v = self.load()?;
        let machines = list(&v, "machines");
        let workspaces = list(&v, "projects")
            .iter()
            .filter(|p| p["machineId"] != "local")
            .map(|p| {
                let name = machines.iter().find(|m| m["id"] == p["machineId"]).map(|m| m["name"].clone());
                json!({"workspaceId":p["id"],"path":p["cwd"],"title":p["name"],"machineId":p["machineId"],"machineName":name})
            })
            .collect::<Vec<_>>();
        Ok(json!({"machines":machines,"workspaces":workspaces}))
    }
    /// Fails fast when an active machine already uses this address.
    pub fn ensure_new(&self, connection: &Value) -> Result<()> {
        match active_collision(&self.load()?, connection, "") {
            Some(other) => Err(conflict(other)),
            None => Ok(()),
        }
    }
    /// Adds a machine, or restores the removed machine with the same address
    /// so its conversations keep resolving.
    pub async fn add_machine(&self, connection: Value, name: String, check: Option<Value>) -> Result<Value> {
        self.transaction(|state| {
            if let Some(other) = active_collision(state, &connection, "") {
                return Err(conflict(other));
            }
            let tombstone = collision(state, &connection, "").map(|m| s(m, "id").to_owned());
            let machines = list_mut(state, "machines");
            if let Some(m) = tombstone.and_then(|id| machines.iter_mut().find(|m| s(m, "id") == id)) {
                m.as_object_mut().unwrap().remove("removedAt");
                m["name"] = json!(name);
                set_connection(m, &connection);
                set_check(m, check);
                let mut restored = m.clone();
                restored["restored"] = json!(true);
                return Ok(restored);
            }
            let mut m = json!({"id":id(),"type":"ssh","name":name});
            set_connection(&mut m, &connection);
            set_check(&mut m, check);
            machines.push(m.clone());
            Ok(m)
        })
        .await
    }
    /// Renames a machine and/or changes its address; its id never changes.
    pub async fn update_machine(&self, id: &str, name: Option<String>, connection: Option<Value>) -> Result<Value> {
        self.transaction(|state| {
            let index = machine_index(state, id)?;
            let m = &list(state, "machines")[index];
            if removed(m) {
                return Err(removed_error(m));
            }
            if let Some(connection) = &connection {
                if id == "local" {
                    return err("INVALID_INPUT", "The local machine has no SSH address to edit");
                }
                if let Some(other) = collision(state, connection, id) {
                    return Err(conflict(other));
                }
                let running = list(state, "agents")
                    .iter()
                    .filter(|a| s(a, "machineId") == id && a.get("stoppedAt").is_none())
                    .collect::<Vec<_>>();
                if !running.is_empty() {
                    return err(
                        "CONFLICT",
                        format!(
                            "Stop or forget {} before changing this machine's address: {}.",
                            plural(running.len(), "managed terminal", "managed terminals"),
                            names(&running)
                        ),
                    );
                }
            }
            let m = &mut list_mut(state, "machines")[index];
            if let Some(name) = name {
                m["name"] = json!(name)
            }
            if let Some(connection) = connection {
                if machine_key(m) != machine_key(&connection) {
                    set_check(m, None)
                }
                set_connection(m, &connection)
            }
            Ok(m.clone())
        })
        .await
    }
    /// Removes a machine. `retain` keeps a tombstone so conversations that
    /// reference the machine can be restored with it.
    pub async fn remove_machine(&self, id: &str, retain: bool) -> Result<Value> {
        self.transaction(|state| {
            if id == "local" {
                return err("INVALID_INPUT", "The local machine cannot be removed");
            }
            let index = machine_index(state, id)?;
            if removed(&list(state, "machines")[index]) {
                return Ok(json!({"machineId":id,"removed":true,"retained":true}));
            }
            let projects = list(state, "projects")
                .iter()
                .filter(|p| s(p, "machineId") == id)
                .collect::<Vec<_>>();
            if !projects.is_empty() {
                return err(
                    "CONFLICT",
                    format!(
                        "Remove {} first: {}.",
                        plural(projects.len(), "registered workspace on this machine", "registered workspaces on this machine"),
                        names(&projects)
                    ),
                );
            }
            let running = list(state, "agents")
                .iter()
                .filter(|a| s(a, "machineId") == id && a.get("stoppedAt").is_none())
                .collect::<Vec<_>>();
            if !running.is_empty() {
                return err(
                    "CONFLICT",
                    format!(
                        "Stop {} first, or forget records on an unreachable machine: {}.",
                        plural(running.len(), "managed terminal", "managed terminals"),
                        names(&running)
                    ),
                );
            }
            list_mut(state, "agents").retain(|a| s(a, "machineId") != id);
            if retain {
                let m = &mut list_mut(state, "machines")[index];
                m["removedAt"] = json!(now());
                set_check(m, None);
            } else {
                list_mut(state, "machines").remove(index);
            }
            Ok(json!({"machineId":id,"removed":true,"retained":retain}))
        })
        .await
    }
    pub async fn restore_machine(&self, id: &str) -> Result<Value> {
        self.transaction(|state| {
            let index = machine_index(state, id)?;
            let m = &list(state, "machines")[index];
            if !removed(m) {
                return Ok(m.clone());
            }
            if let Some(other) = active_collision(state, m, id) {
                return Err(conflict(other));
            }
            let m = &mut list_mut(state, "machines")[index];
            m.as_object_mut().unwrap().remove("removedAt");
            Ok(m.clone())
        })
        .await
    }
    /// Stores a probe summary of `probed`; ignored if the machine was removed
    /// or re-pointed while the probe ran.
    pub async fn record_check(&self, id: &str, probed: &Value, check: Value) -> Result<()> {
        self.transaction(|state| {
            if let Some(m) = list_mut(state, "machines")
                .iter_mut()
                .find(|m| s(m, "id") == id && !removed(m) && machine_key(m) == machine_key(probed))
            {
                m["lastCheck"] = check
            }
            Ok(())
        })
        .await
    }
    /// Registers a canonical directory that was already resolved on the machine.
    pub async fn add_workspace(&self, machine: &str, cwd: String) -> Result<Value> {
        self.transaction(|state| {
            let m = &list(state, "machines")[machine_index(state, machine)?];
            if removed(m) {
                return Err(removed_error(m));
            }
            if let Some(v) = list(state, "projects")
                .iter()
                .find(|v| s(v, "machineId") == machine && s(v, "cwd") == cwd)
            {
                return Ok(v.clone());
            }
            let name = clip(
                std::path::Path::new(&cwd)
                    .file_name()
                    .and_then(|p| p.to_str())
                    .unwrap_or("Project"),
                100,
            );
            let v = json!({"id":id(),"machineId":machine,"cwd":cwd,"name":name,"source":"workspace"});
            list_mut(state, "projects").push(v.clone());
            Ok(v)
        })
        .await
    }
    pub async fn remove_workspace(&self, id: &str) -> Result<Value> {
        self.transaction(|state| {
            let projects = list_mut(state, "projects");
            let index = projects
                .iter()
                .position(|p| s(p, "id") == id)
                .ok_or_else(|| Error::new("NOT_FOUND", "Workspace not found"))?;
            projects.remove(index);
            Ok(json!({"removed":true}))
        })
        .await
    }
    pub fn preview_herdr(&self, p: &Value) -> Result<Value> {
        herdr::preview(p, &self.load()?)
    }
    pub async fn import_herdr(&self, p: &Value) -> Result<Value> {
        self.transaction(|state| {
            let preview = herdr::preview(p, state)?;
            if p["confirmation"] != preview["digest"] {
                return err("STALE_PREVIEW", "Import confirmation is missing or stale; preview again");
            }
            let mut mids = vec![];
            let mut pids = vec![];
            for item in list(&preview, "machines").iter().filter(|m| m["action"] == "add") {
                let mut m = item.clone();
                m.as_object_mut().unwrap().remove("action");
                m["id"] = json!(id());
                m["type"] = json!("ssh");
                mids.push(m["id"].clone());
                list_mut(state, "machines").push(m)
            }
            for item in list(&preview, "projects").iter().filter(|m| m["action"] == "add") {
                let mut v = item.clone();
                v.as_object_mut().unwrap().remove("action");
                v["id"] = json!(id());
                v["source"] = json!("herdr");
                pids.push(v["id"].clone());
                list_mut(state, "projects").push(v)
            }
            let mut result = preview;
            result["imported"] = json!({"machines":mids.len(),"projects":pids.len()});
            result["importedMachineIds"] = json!(mids);
            result["importedProjectIds"] = json!(pids);
            Ok(result)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fleet() -> (tempfile::TempDir, Fleet) {
        let dir = tempfile::tempdir().unwrap();
        let fleet = Fleet::new(dir.path().join("fleet.json")).unwrap();
        (dir, fleet)
    }
    fn ssh(host: &str) -> Value {
        json!({"host":host})
    }
    #[tokio::test]
    async fn tombstones_restore_by_address_and_ids_survive_edits() {
        let (_dir, fleet) = fleet();
        let a = fleet.add_machine(ssh("dev"), "Dev".into(), None).await.unwrap();
        let id = s(&a, "id").to_owned();
        assert_eq!(fleet.ensure_new(&ssh("DEV")).unwrap_err().code, "CONFLICT");
        fleet.remove_machine(&id, true).await.unwrap();
        assert_eq!(fleet.host(&id).err().unwrap().code, "MACHINE_REMOVED");
        assert!(fleet.ensure_new(&ssh("dev")).is_ok());
        let back = fleet.add_machine(ssh("DEV"), "Again".into(), None).await.unwrap();
        assert_eq!((s(&back, "id"), back["restored"].clone()), (id.as_str(), json!(true)));
        let moved = fleet.update_machine(&id, None, Some(json!({"host":"dev2","port":2222}))).await.unwrap();
        assert_eq!((s(&moved, "id"), moved["port"].clone(), moved["name"].clone()), (id.as_str(), json!(2222), json!("Again")));
        assert_eq!(fleet.update_machine("local", None, Some(ssh("x"))).await.unwrap_err().code, "INVALID_INPUT");
        let gone = fleet.add_machine(ssh("tmp"), "Tmp".into(), None).await.unwrap();
        assert_eq!(fleet.remove_machine(s(&gone, "id"), false).await.unwrap()["retained"], false);
        assert_eq!(fleet.host(s(&gone, "id")).err().unwrap().code, "NOT_FOUND");
    }
    #[tokio::test]
    async fn removal_names_blocking_records() {
        let (_dir, fleet) = fleet();
        let m = fleet.add_machine(ssh("box"), "Box".into(), None).await.unwrap();
        let id = s(&m, "id").to_owned();
        fleet.add_workspace(&id, "/srv/app".into()).await.unwrap();
        let e = fleet.remove_machine(&id, false).await.unwrap_err();
        assert_eq!(e.code, "CONFLICT");
        assert!(e.message.contains("“app”"), "{}", e.message);
    }
    #[tokio::test]
    async fn the_writer_lock_is_released_with_its_holder() {
        let (dir, fleet) = fleet();
        fleet.namespace().await.unwrap();
        let holder = OpenOptions::new().create(true).truncate(false).write(true).open(dir.path().join("fleet.json.writer.lock")).unwrap();
        holder.lock_exclusive().unwrap();
        assert_eq!(fleet.add_machine(ssh("a"), "A".into(), None).await.unwrap_err().code, "STATE_LOCKED");
        drop(holder);
        assert!(fleet.add_machine(ssh("a"), "A".into(), None).await.is_ok());
    }
    #[test]
    fn invalid_cached_checks_are_dropped_not_fatal() {
        let mut v = default_state();
        v["machines"][0]["lastCheck"] = json!({"ok":"yes"});
        validate(&mut v).unwrap();
        assert!(v["machines"][0].get("lastCheck").is_none());
        v["machines"][0]["removedAt"] = json!("now");
        assert_eq!(validate(&mut v).unwrap_err().message, "Invalid machine record #1");
    }
}
