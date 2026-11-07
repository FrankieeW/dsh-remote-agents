use crate::{chat::ChatStore, common::*, fleet::Fleet, hosts::Host, providers::Registry, runtimes};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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
    pub fleet: Mutex<Fleet>,
    pub registry: Arc<Registry>,
    chat: OnceCell<Arc<Mutex<ChatStore>>>,
    tasks: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
    gate: Mutex<()>,
    pub stopped: AtomicBool,
}
impl Engine {
    pub fn new(config: Value) -> Result<Arc<Self>> {
        let path = absolute(s(&config, "statePath"))?;
        let engine = Arc::new(Self {
            registry: Registry::new(config.clone()),
            config,
            fleet: Mutex::new(Fleet::new(path)?),
            chat: OnceCell::new(),
            tasks: Mutex::new(HashMap::new()),
            gate: Mutex::new(()),
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
        let mut fleet = self.fleet.lock().await;
        fleet.reload()?;
        fleet.host(machine)
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
                let mut v = self.fleet.lock().await.call(method, &p).await?;
                v["pluginVersion"] = self.config["pluginVersion"].clone();
                Ok(v)
            }
            "workspaceBrowse" => {
                self.host(
                    p.get("machineId")
                        .and_then(Value::as_str)
                        .unwrap_or("local"),
                )
                .await?
                .browse(p.get("path").and_then(Value::as_str).unwrap_or("~/"))
                .await
            }
            "chatProviders" => {
                let host = self
                    .host(
                        p.get("machineId")
                            .and_then(Value::as_str)
                            .unwrap_or("local"),
                    )
                    .await?;
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
            "chatCreate" => {
                let host = self
                    .host(
                        p.get("machineId")
                            .and_then(Value::as_str)
                            .unwrap_or("local"),
                    )
                    .await?;
                self.registry.resolve(&host, s(&p, "provider")).await?;
                let cwd = host.directory(s(&p, "cwd")).await?;
                self.chat().await?.lock().await.create(&p, &cwd)
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
            "ompConfigRead" | "ompConfigSave" => {
                let host = self
                    .host(
                        p.get("machineId")
                            .and_then(Value::as_str)
                            .unwrap_or("local"),
                    )
                    .await?;
                if method == "ompConfigRead" {
                    crate::omp_config::snapshot(&host, &self.registry, &p).await
                } else {
                    let _gate = self.gate.lock().await;
                    if let Some(chat) = self.chat.get() {
                        let store = chat.lock().await;
                        if store.live.keys().any(|id| {
                            store.session(id).is_ok_and(|s| {
                                s["provider"] == "omp" && s["machineId"] == host.machine["id"]
                            })
                        }) {
                            return err(
                                "BUSY",
                                "Stop this machine's active OMP turns before saving shared configuration",
                            );
                        }
                    }
                    crate::omp_config::save(&host, &self.registry, &p).await
                }
            }
            "chatSend" => {
                let _gate = self.gate.lock().await;
                let chat = self.chat().await?;
                let session = chat.lock().await.session(s(&p, "id"))?;
                let host = self.host(s(&session, "machineId")).await?;
                let executable = self
                    .registry
                    .resolve(&host, s(&session, "provider"))
                    .await?;
                let namespace = {
                    let mut fleet = self.fleet.lock().await;
                    fleet.reload()?;
                    s(&fleet.state, "namespace").to_owned()
                };
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
                let result = self
                    .chat()
                    .await?
                    .lock()
                    .await
                    .stop(sid, method == "chatClose")?;
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
            "agentUpdatePlan" => {
                let host = self.host(s(&p, "machineId")).await?;
                let mut plan = self.registry.plan(&host, s(&p, "provider"), false).await?;
                plan.as_object_mut().unwrap().remove("executable");
                plan.as_object_mut().unwrap().remove("args");
                Ok(plan)
            }
            "agentUpdate" => {
                let _gate = self.gate.lock().await;
                let sessions = self.chat().await?.lock().await.list();
                if sessions.as_array().unwrap().iter().any(|s| {
                    s["machineId"] == p["machineId"]
                        && s["provider"] == p["provider"]
                        && matches!(crate::common::s(s, "status"), "running" | "waiting")
                }) {
                    return err("BUSY", "Stop active sessions for this CLI before updating");
                };
                let host = self.host(s(&p, "machineId")).await?;
                self.registry.start_update(host, &p).await
            }
            "agentUpdateStatus" => self
                .registry
                .jobs
                .lock()
                .await
                .get(s(&p, "id"))
                .cloned()
                .ok_or_else(|| Error::new("NOT_FOUND", "Update status expired; refresh versions")),
            "snapshot" | "previewHerdr" | "importHerdr" | "addMachine" | "removeMachine"
            | "probe" | "start" | "read" | "send" | "interrupt" | "stop" | "workspaceAdd"
            | "workspaceRemove" => self.fleet.lock().await.call(method, &p).await,
            _ => err("NOT_FOUND", "Unknown operation"),
        }
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
