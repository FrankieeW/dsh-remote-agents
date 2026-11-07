use crate::{
    chat::ChatStore,
    chat_commands,
    common::*,
    fleet::Fleet,
    hosts::Host,
    machines::{machine_param, same_connection},
    providers::Registry,
    runtimes,
    terminals::Terminals,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, OnceCell, mpsc};
pub struct Engine {
    pub config: Value,
    pub fleet: Fleet,
    pub terminals: Terminals,
    pub registry: Arc<Registry>,
    pub(crate) chat: OnceCell<Arc<Mutex<ChatStore>>>,
    tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    /// Orders turn admission, interruption and machine lifecycle changes.
    /// Never held across remote I/O, so one slow machine cannot stall others.
    pub(crate) gate: Mutex<()>,
    /// Machines whose shared OMP configuration is being written.
    pub(crate) omp_saving: std::sync::Mutex<HashSet<String>>,
    pub stopped: AtomicBool,
}
/// Releases an OMP configuration save reservation when dropped.
struct OmpSave<'a> {
    saving: &'a std::sync::Mutex<HashSet<String>>,
    machine: String,
}
impl Drop for OmpSave<'_> {
    fn drop(&mut self) {
        self.saving.lock().unwrap().remove(&self.machine);
    }
}
fn active(session: &Value) -> bool {
    matches!(s(session, "status"), "running" | "waiting")
}
impl Engine {
    pub fn new(config: Value) -> Result<Arc<Self>> {
        let path = absolute(s(&config, "statePath"))?;
        let multiplex = config["sshMultiplexing"] == true
            || std::env::var("DSH_REMOTE_AGENTS_SSH_MULTIPLEX").is_ok_and(|v| matches!(v.trim(), "1" | "true"));
        if multiplex {
            crate::ssh_mux::enable(path.parent().unwrap_or(std::path::Path::new("/")));
        }
        let engine = Arc::new(Self {
            registry: Registry::new(config.clone()),
            config,
            fleet: Fleet::new(path)?,
            terminals: Terminals::default(),
            chat: OnceCell::new(),
            tasks: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
            omp_saving: std::sync::Mutex::new(HashSet::new()),
            stopped: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&engine);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let Some(engine) = weak.upgrade() else { break };
                if engine.stopped.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(chat) = engine.chat.get() {
                    let mut store = chat.lock().await;
                    if store.dirty {
                        let _ = store.save();
                    }
                }
            }
        });
        Ok(engine)
    }
    pub async fn chat(&self) -> Result<Arc<Mutex<ChatStore>>> {
        Ok(self
            .chat
            .get_or_try_init(|| async {
                let parent = PathBuf::from(s(&self.config, "statePath"))
                    .parent()
                    .unwrap()
                    .to_owned();
                Ok::<_, Error>(Arc::new(Mutex::new(ChatStore::load(
                    parent.join("conversations.json"),
                )?)))
            })
            .await?
            .clone())
    }
    pub async fn host(&self, machine: &str) -> Result<Host> {
        self.fleet.host(machine)
    }
    /// The machine's current connection, refused if it was removed or
    /// re-pointed since `planned` was resolved. Call while holding the gate.
    fn unchanged(&self, planned: &Host) -> Result<Host> {
        let current = self.fleet.host(s(&planned.machine, "id"))?;
        if !same_connection(&current.machine, &planned.machine) {
            return err(
                "CONFLICT",
                "This machine's SSH address changed while the request was prepared; try again",
            );
        }
        Ok(current)
    }
    fn reserve_omp_save(&self, machine: &str) -> Result<OmpSave<'_>> {
        if !self.omp_saving.lock().unwrap().insert(machine.to_owned()) {
            return err("BUSY", "Another OMP configuration save is running on this machine");
        }
        Ok(OmpSave {
            saving: &self.omp_saving,
            machine: machine.to_owned(),
        })
    }
    fn updating_blocked(sessions: &Value, p: &Value) -> bool {
        sessions.as_array().unwrap().iter().any(|s| {
            s["machineId"] == p["machineId"] && s["provider"] == p["provider"] && active(s)
        })
    }
    pub async fn call(self: &Arc<Self>, method: &str, p: Value) -> Result<Value> {
        if self.stopped.load(Ordering::Relaxed) {
            return err("DISPOSED", "Backend is shutting down");
        }
        if !p.is_object() {
            return err("INVALID_INPUT", "Request must be an object");
        }
        if p.to_string().len()
            > if matches!(method, "previewHerdr" | "importHerdr") {
                4 * 1024 * 1024
            } else {
                65536
            }
        {
            return err("INVALID_INPUT", "Request is too large");
        }
        match method {
            "health" => Ok(
                json!({"backend":"rust","protocolVersion":1,"version":env!("CARGO_PKG_VERSION"),"pluginVersion":self.config["pluginVersion"]}),
            ),
            "workspaceCatalog" => {
                let mut v = self.fleet.catalog()?;
                v["pluginVersion"] = self.config["pluginVersion"].clone();
                Ok(v)
            }
            "workspaceBrowse" => {
                self.host(&machine_param(&p)?)
                    .await?
                    .browse(p.get("path").and_then(Value::as_str).unwrap_or("~/"))
                    .await
            }
            "sshConfigHosts" => {
                let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) else {
                    return Ok(json!({"hosts":[],"warnings":["Home directory unavailable"]}));
                };
                let list = tokio::task::spawn_blocking(move || crate::ssh_config::hosts(&PathBuf::from(home)))
                    .await
                    .map_err(|_| Error::new("IO_ERROR", "Could not read the SSH configuration"))?;
                let state = self.fleet.load()?;
                Ok(crate::ssh_config::with_machines(list, state["machines"].as_array().unwrap()))
            }
            "chatProviders" => {
                let host = self.host(&machine_param(&p)?).await?;
                Ok(self
                    .registry
                    .descriptions(&host, p["refresh"] == true)
                    .await)
            }
            "chatList" => {
                let sessions = self.chat().await?.lock().await.list();
                let host = self.host("local").await?;
                Ok(
                    json!({"sessions":sessions,"providers":self.registry.descriptions(&host,false).await}),
                )
            }
            "chatGet" => self.chat().await?.lock().await.snapshot(s(&p, "id")),
            "chatCommands" => {
                let session = self.chat().await?.lock().await.session(s(&p, "id"))?;
                Ok(json!({"commands":chat_commands::catalog(),"provider":session["provider"]}))
            }
            "chatCommand" => {
                let command = chat_commands::parse(&p)?;
                let chat = self.chat().await?;
                let sid = s(&p, "id");
                // Listing models reads the remote CLI; do it before taking the gate.
                let options = if command.name == "model" && command.argument.is_empty() {
                    let session = {
                        let store = chat.lock().await;
                        if let Some(receipt) = store.command_receipt(sid, &command)? {
                            return Ok(receipt);
                        }
                        store.command_guard(sid, &command)?;
                        store.session(sid)?
                    };
                    let host = self.host(s(&session, "machineId")).await?;
                    Some(self.registry.options(&host, &session, false).await?)
                } else {
                    None
                };
                let _gate = self.gate.lock().await;
                if let Some(receipt) = chat.lock().await.command_receipt(sid, &command)? {
                    return Ok(receipt);
                }
                if command.name == "stop" {
                    chat.lock().await.command_guard(sid, &command)?;
                    let session = self.stop_chat(sid, false).await?;
                    return Ok(json!({"command":"stop","message":"Turn interrupted.","session":session}));
                }
                chat.lock().await.command(&p, &command, options.as_ref())
            }
            "chatCreate" => {
                let machine = machine_param(&p)?;
                let host = self.host(&machine).await?;
                self.registry.resolve(&host, s(&p, "provider")).await?;
                let cwd = host.directory(s(&p, "cwd")).await?;
                let mut params = p.clone();
                params["machineId"] = json!(machine);
                // Removal counts a machine's sessions under the gate; creating under it
                // too means no session can reference a machine deleted meanwhile.
                let _gate = self.gate.lock().await;
                self.unchanged(&host)?;
                self.chat().await?.lock().await.create(&params, &cwd)
            }
            "chatConfigure" => self.chat().await?.lock().await.configure(&p),
            "chatMetadata" => self.chat().await?.lock().await.metadata(&p),
            "chatSearch" => self.chat().await?.lock().await.search(s(&p, "query")),
            "chatExport" => self.chat().await?.lock().await.export(
                s(&p, "id"),
                p.get("format")
                    .and_then(Value::as_str)
                    .unwrap_or("markdown"),
            ),
            "chatOmpHistory" => self.chat().await?.lock().await.history(&p),
            "chatToolHistory" => {
                let (reader, sid, mid, active, minimum) =
                    self.chat().await?.lock().await.tool_history_reader(&p)?;
                tokio::task::spawn_blocking(move || {
                    let mut p = p;
                    p["minimumCount"] = json!(minimum);
                    let mut value = reader.read(&sid, &mid, &p)?;
                    if !active {
                        if let Some(tools) = value["tools"].as_array_mut() {
                            for tool in tools {
                                if tool["status"] == "running" {
                                    tool["status"] = json!("interrupted");
                                }
                            }
                        }
                    }
                    Ok(value)
                })
                .await
                .map_err(|_| Error::new("IO_ERROR", "Tool history read failed"))?
            }
            "chatRecoverOmpTools" => self.chat().await?.lock().await.recover_tools(&p),
            "chatApprove" => self.chat().await?.lock().await.approve(&p),
            "chatOptions" => {
                let session = self.chat().await?.lock().await.session(s(&p, "id"))?;
                let host = self.host(s(&session, "machineId")).await?;
                self.registry
                    .options(&host, &session, p["refresh"] == true)
                    .await
            }
            "ompConfigRead" => {
                let host = self.host(&machine_param(&p)?).await?;
                crate::omp_config::snapshot(&host, &self.registry, &p).await
            }
            "ompConfigSave" => {
                let machine = machine_param(&p)?;
                let (host, _reservation) = {
                    let _gate = self.gate.lock().await;
                    // Read under the gate: a removal or address change cannot slip in before the save.
                    let host = self.host(&machine).await?;
                    if let Some(chat) = self.chat.get() {
                        let store = chat.lock().await;
                        if store.live.keys().any(|id| {
                            store.session(id).is_ok_and(|s| {
                                s["provider"] == "omp" && s["machineId"] == machine.as_str()
                            })
                        }) {
                            return err(
                                "BUSY",
                                "Stop this machine's active OMP turns before saving shared configuration",
                            );
                        }
                    }
                    (host, self.reserve_omp_save(&machine)?)
                };
                crate::omp_config::save(&host, &self.registry, &p).await
            }
            "chatSend" => {
                let chat = self.chat().await?;
                let session = chat.lock().await.session(s(&p, "id"))?;
                let provider = s(&session, "provider").to_owned();
                let machine = s(&session, "machineId").to_owned();
                chat_commands::reject_prompt(&provider, &p["text"])?;
                let host = self.host(&machine).await?;
                let executable = self.registry.resolve(&host, &provider).await?;
                let namespace = self.fleet.namespace().await?;
                let _gate = self.gate.lock().await;
                // Re-check what may have changed while the remote CLI was resolved.
                self.unchanged(&host)?;
                if self.registry.updating(&machine, &provider).await {
                    return err("BUSY", "This remote CLI is updating");
                }
                if provider == "omp" && self.omp_saving.lock().unwrap().contains(&machine) {
                    return err(
                        "BUSY",
                        "OMP configuration is being saved on this machine; send again when it finishes",
                    );
                }
                let (tx, rx) = mpsc::channel(32);
                let (ack, turn) = chat.lock().await.admit(&p, tx.clone())?;
                if let Some((session, token)) = turn {
                    let sid = s(&session, "id").to_owned();
                    let session_root = PathBuf::from(s(&self.config, "statePath"))
                        .parent()
                        .unwrap()
                        .join("omp-sessions");
                    let ctx = runtimes::Context {
                        chat: chat.clone(),
                        sid: sid.clone(),
                        token: token.clone(),
                        session,
                        host,
                        executable,
                        session_root,
                        namespace,
                        config: self.config.clone(),
                    };
                    let prompt = s(&p, "text").to_owned();
                    let id = sid.clone();
                    let handle = tokio::spawn(async move {
                        let result = runtimes::run(ctx, prompt, rx, tx).await;
                        chat.lock().await.finish(&id, &token, result);
                    });
                    self.tasks.lock().await.insert(sid, handle);
                }
                Ok(ack)
            }
            "chatInterrupt" | "chatClose" => {
                let _gate = self.gate.lock().await;
                let sid = s(&p, "id");
                self.stop_chat(sid, method == "chatClose").await
            }
            "agentUpdatePlan" => {
                let host = self.host(s(&p, "machineId")).await?;
                let mut plan = self.registry.plan(&host, s(&p, "provider"), false).await?;
                plan.as_object_mut().unwrap().remove("executable");
                plan.as_object_mut().unwrap().remove("args");
                Ok(plan)
            }
            "agentUpdate" => {
                let busy = || err("BUSY", "Stop active sessions for this CLI before updating");
                if Self::updating_blocked(&self.chat().await?.lock().await.list(), &p) {
                    return busy();
                }
                let host = self.host(s(&p, "machineId")).await?;
                let prepared = self.registry.prepare_update(&host, &p).await?;
                let _gate = self.gate.lock().await;
                // The plan was made for this exact address; once registered, the job
                // blocks removal and address changes until it finishes.
                self.unchanged(&host)?;
                if Self::updating_blocked(&self.chat().await?.lock().await.list(), &p) {
                    return busy();
                }
                self.registry.start_update(host, prepared).await
            }
            "agentUpdateStatus" => self
                .registry
                .jobs
                .lock()
                .await
                .get(s(&p, "id"))
                .cloned()
                .ok_or_else(|| Error::new("NOT_FOUND", "Update status expired; refresh versions")),
            "addMachine" | "updateMachine" | "removeMachine" | "restoreMachine" | "probe" => {
                self.machine_call(method, &p).await
            }
            "snapshot" => self.fleet.snapshot(),
            "previewHerdr" => self.fleet.preview_herdr(&p),
            "importHerdr" => self.fleet.import_herdr(&p).await,
            "workspaceAdd" => {
                let machine = machine_param(&p)?;
                let cwd = self.host(&machine).await?.directory(s(&p, "path")).await?;
                self.fleet.add_workspace(&machine, cwd).await
            }
            "workspaceRemove" => {
                self.fleet
                    .remove_workspace(&required(&p, "workspaceId", 128)?)
                    .await
            }
            "start" => self.terminals.start(&self.fleet, &p).await,
            "read" | "send" | "interrupt" | "stop" | "forgetAgent" => {
                self.terminals.call(&self.fleet, method, &p).await
            }
            _ => err("NOT_FOUND", "Unknown operation"),
        }
    }
    async fn stop_chat(&self, sid: &str, close: bool) -> Result<Value> {
        let result = self.chat().await?.lock().await.stop(sid, close)?;
        if let Some(mut task) = self.tasks.lock().await.remove(sid) {
            if tokio::time::timeout(Duration::from_millis(800), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
        Ok(result)
    }
    pub async fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::Relaxed) {
            return;
        }
        if let Some(chat) = self.chat.get() {
            let mut store = chat.lock().await;
            let ids = store.live.keys().cloned().collect::<Vec<_>>();
            for id in ids {
                let _ = store.stop(&id, false);
            }
        }
        let tasks = std::mem::take(&mut *self.tasks.lock().await);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(1500);
        for (_, mut task) in tasks {
            if tokio::time::timeout_at(deadline, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
        if let Some(chat) = self.chat.get() {
            let _ = chat.lock().await.save();
        }
    }
}
