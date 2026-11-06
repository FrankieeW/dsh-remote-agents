use crate::titles;
use crate::{common::*, history, settings};
use fs2::FileExt;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
};
use tokio::sync::{mpsc, oneshot};
#[derive(Debug)]
pub enum Control {
    Abort,
    Approval { wire: String, allow: bool },
}
pub struct Live {
    pub token: String,
    pub control: mpsc::Sender<Control>,
}
pub struct Pending {
    pub record: Value,
    pub session: String,
    pub token: String,
    pub wire: String,
    pub reply: oneshot::Sender<bool>,
}
pub struct ChatStore {
    pub path: PathBuf,
    pub state: Value,
    pub live: HashMap<String, Live>,
    pub pending: HashMap<String, Pending>,
    pub storage_error: Option<String>,
    pub dirty: bool,
    _lock: File,
}
fn bound(v: &Value, max: usize) -> (Value, bool) {
    let text = v.to_string();
    if text.chars().count() > max {
        (json!(format!("{}…", clip(&text, max))), true)
    } else {
        (v.clone(), false)
    }
}
impl ChatStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(path.parent().unwrap())?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path.with_extension("json.owner.lock"))?;
        lock.try_lock_exclusive().map_err(|_| {
            Error::new(
                "STATE_LOCKED",
                "Another backend owns this conversation state",
            )
        })?;
        let mut state = load_or(&path, json!({"version":1,"sessions":[]}), 64 * 1024 * 1024)?;
        if state["version"] != 1
            || !state["sessions"].is_array()
            || state["sessions"].as_array().unwrap().len() > 256
        {
            return err("INVALID_STATE", "Unsupported conversation schema");
        }
        let mut ids = std::collections::HashSet::new();
        let mut changed = false;
        for session in state["sessions"].as_array_mut().unwrap() {
            if !safe_id(s(session, "id"))
                || !ids.insert(s(session, "id").to_owned())
                || !matches!(s(session, "provider"), "claude" | "codex" | "omp")
                || !matches!(
                    s(session, "status"),
                    "idle" | "running" | "waiting" | "error" | "interrupted" | "closed"
                )
                || absolute(s(session, "cwd")).is_err()
                || !session["messages"].is_array()
                || !session["requests"].is_array()
            {
                return err("INVALID_STATE", "Invalid session record");
            }
            if session.get("machineId").is_none() {
                session["machineId"] = json!("local")
            };
            if session.get("settingsRevision").is_none() {
                session["settingsRevision"] = json!(0)
            }
            if session.get("settings").is_none() {
                let mode = match s(session, "provider") {
                    "codex" => "safe",
                    "claude" => "default",
                    _ => "always-ask",
                };
                session["settings"] = json!({"model":null,"effort":null,"permissions":mode})
            }
            session["settings"] = settings::validate(s(session, "provider"), &session["settings"])?;
            for m in session["messages"].as_array().unwrap() {
                if !m["text"].is_string()
                    || !m["tools"].is_array()
                    || !matches!(s(m, "role"), "assistant" | "user")
                {
                    return err("INVALID_STATE", "Invalid transcript record");
                }
            }
            session.as_object_mut().unwrap().remove("pendingApprovals");
            changed |= titles::migrate(session);
            if matches!(s(session, "status"), "running" | "waiting") {
                session["status"] = json!("interrupted");
                session["error"] = json!(
                    "The previous process ended during a turn. Send a new message to resume explicitly."
                );
                session["updatedAt"] = json!(now());
                changed = true
            }
        }
        let mut store = Self {
            path,
            state,
            live: HashMap::new(),
            pending: HashMap::new(),
            storage_error: None,
            dirty: false,
            _lock: lock,
        };
        if changed {
            store.save()?
        }
        Ok(store)
    }
    pub fn index(&self, id: &str) -> Result<usize> {
        self.state["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .position(|s| s["id"] == id)
            .ok_or_else(|| Error::new("NOT_FOUND", "Chat session not found"))
    }
    pub fn session(&self, id: &str) -> Result<Value> {
        Ok(self.state["sessions"][self.index(id)?].clone())
    }
    pub fn snapshot(&self, id: &str) -> Result<Value> {
        let mut s = self.session(id)?;
        s.as_object_mut().unwrap().remove("requests");
        s["pendingApprovals"] = json!(
            self.pending
                .values()
                .filter(|p| p.session == id)
                .map(|p| p.record.clone())
                .collect::<Vec<_>>()
        );
        if let Some(e) = &self.storage_error {
            s["persistenceError"] = json!(e)
        }
        Ok(s)
    }
    pub fn list(&self) -> Value {
        json!(
            self.state["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| {
                    let mut v = json!({});
                    for k in [
                        "id",
                        "provider",
                        "name",
                        "nameSource",
                        "cwd",
                        "machineId",
                        "settings",
                        "settingsRevision",
                        "status",
                        "createdAt",
                        "updatedAt",
                        "archived",
                        "pinned",
                        "error",
                    ] {
                        if let Some(value) = s.get(k) {
                            v[k] = value.clone()
                        }
                    }
                    v["messageCount"] = json!(s["messages"].as_array().unwrap().len());
                    v
                })
                .collect::<Vec<_>>()
        )
    }
    pub fn save(&mut self) -> Result<()> {
        match atomic_json(&self.path, &self.state, 64 * 1024 * 1024) {
            Ok(()) => {
                self.storage_error = None;
                self.dirty = false;
                Ok(())
            }
            Err(e) => {
                self.storage_error = Some(e.message.clone());
                Err(e)
            }
        }
    }
    pub fn create(&mut self, p: &Value, cwd: &str) -> Result<Value> {
        let provider = s(p, "provider");
        if !matches!(provider, "codex" | "claude" | "omp") {
            return err("UNSUPPORTED", "Provider unavailable");
        }
        if p["remote"] == true {
            return err("UNSUPPORTED", "Use an explicit registered machine");
        }
        let settings =
            settings::validate(provider, p.get("settings").unwrap_or(&settings::defaults()))?;
        let name = if p.get("name").is_some() {
            let name = required(p, "name", 100)?;
            if name.trim().is_empty() {
                return err("INVALID_INPUT", "Empty session name");
            }
            name.trim().to_owned()
        } else {
            titles::PLACEHOLDER.into()
        };
        if self.state["sessions"].as_array().unwrap().len() >= 256 {
            return err("STATE_LIMIT", "Maximum session count reached");
        }
        let v = json!({"id":id(),"provider":provider,"name":name,"nameSource":if p.get("name").is_some(){"manual"}else{"auto"},"cwd":cwd,"machineId":p.get("machineId").cloned().unwrap_or(json!("local")),"settings":settings,"settingsRevision":0,"status":"idle","messages":[],"requests":[],"createdAt":now(),"updatedAt":now()});
        self.state["sessions"]
            .as_array_mut()
            .unwrap()
            .push(v.clone());
        if let Err(e) = self.save() {
            self.state["sessions"].as_array_mut().unwrap().pop();
            return Err(e);
        }
        self.snapshot(s(&v, "id"))
    }
    pub fn configure(&mut self, p: &Value) -> Result<Value> {
        let sid = s(p, "id");
        let index = self.index(sid)?;
        let mut session = self.state["sessions"][index].clone();
        if session["status"] == "closed" {
            return err("CLOSED", "Session is closed");
        }
        if self.live.contains_key(sid) {
            return err("BUSY", "Finish the current turn before changing settings");
        }
        let revision = session["settingsRevision"].as_u64().unwrap_or(0);
        if let Some(expected) = p.get("expectedRevision") {
            if expected.as_u64() != Some(revision) {
                return err(
                    "CONFLICT",
                    "Settings changed elsewhere. Refresh this conversation before trying again.",
                );
            }
        }
        let next = if let Some(patch) = p.get("patch") {
            if !patch.is_object() || p.get("settings").is_some() {
                return err("INVALID_INPUT", "Invalid settings patch");
            }
            let mut v = session["settings"].clone();
            for (k, val) in patch.as_object().unwrap() {
                v[k] = val.clone()
            }
            v
        } else {
            p["settings"].clone()
        };
        session["settings"] = settings::validate(s(&session, "provider"), &next)?;
        session["settingsRevision"] = json!(revision + 1);
        session["updatedAt"] = json!(now());
        session.as_object_mut().unwrap().remove("effectiveSettings");
        let old = std::mem::replace(&mut self.state["sessions"][index], session);
        if let Err(e) = self.save() {
            self.state["sessions"][index] = old;
            return Err(e);
        }
        self.snapshot(sid)
    }
    pub fn metadata(&mut self, p: &Value) -> Result<Value> {
        let sid = s(p, "id");
        let index = self.index(sid)?;
        let mut session = self.state["sessions"][index].clone();
        if p["archived"] == true && self.live.contains_key(sid) {
            return err("BUSY", "Stop the turn before archiving");
        }
        if p.get("autoName").is_some() {
            if p["autoName"] != true || p.get("name").is_some() {
                return err(
                    "INVALID_INPUT",
                    "Choose an explicit name or automatic naming",
                );
            }
            titles::use_automatic(&mut session);
        }
        if p.get("name").is_some() {
            let name = required(p, "name", 100)?;
            if name.trim().is_empty() {
                return err("INVALID_INPUT", "Empty session name");
            }
            session["name"] = json!(name.trim());
            session["nameSource"] = json!("manual");
        }
        for k in ["archived", "pinned"] {
            if let Some(v) = p.get(k) {
                if !v.is_boolean() {
                    return err("INVALID_INPUT", "Invalid session metadata");
                }
                session[k] = v.clone()
            }
        }
        session["updatedAt"] = json!(now());
        let old = std::mem::replace(&mut self.state["sessions"][index], session);
        if let Err(e) = self.save() {
            self.state["sessions"][index] = old;
            return Err(e);
        }
        self.snapshot(sid)
    }
    pub fn admit(
        &mut self,
        p: &Value,
        control: mpsc::Sender<Control>,
    ) -> Result<(Value, Option<(Value, String)>)> {
        let sid = s(p, "id");
        let index = self.index(sid)?;
        let old = self.state["sessions"][index].clone();
        let text = text(&p["text"], 65536, true)?;
        if text.trim().is_empty() {
            return err("INVALID_INPUT", "Message is empty");
        }
        let request_id = required(p, "requestId", 128)?;
        for k in ["provider", "machineId"] {
            if let Some(v) = p.get(k) {
                if v != &old[k] {
                    return err("UNSUPPORTED", "Provider and machine are fixed per session");
                }
            }
        }
        if p["remote"] == true {
            return err("UNSUPPORTED", "Provider and machine are fixed per session");
        }
        if let Some(r) = old["requests"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["requestId"] == request_id)
        {
            if r["textHash"] != hash(&text) {
                return err("CONFLICT", "requestId already identifies different text");
            }
            return Ok((
                json!({"accepted":true,"id":sid,"requestId":request_id,"assistantMessageId":r["assistantMessageId"],"duplicate":true}),
                None,
            ));
        }
        if old["status"] == "closed" {
            return err("CLOSED", "Session is closed");
        }
        if self.live.contains_key(sid) {
            return err("BUSY", "A turn is already running");
        }
        if old["requests"].as_array().unwrap().len() >= 2048 {
            return err(
                "STATE_LIMIT",
                "Request history is full; create a new session",
            );
        }
        let token = id();
        let assistant =
            json!({"id":token,"role":"assistant","text":"","tools":[],"createdAt":now()});
        let session = &mut self.state["sessions"][index];
        let messages = session["messages"].as_array_mut().unwrap();
        messages.push(json!({"id":id(),"role":"user","text":text,"tools":[],"createdAt":now()}));
        messages.push(assistant);
        titles::seed(session);
        if session["nameSource"] == "auto" {
            titles::use_automatic(session);
        }
        let messages = session["messages"].as_array_mut().unwrap();
        if messages.len() > 200 {
            messages.drain(..messages.len() - 200);
            session["historyTruncated"] = json!(true)
        }
        session["requests"].as_array_mut().unwrap().push(
            json!({"requestId":request_id,"textHash":hash(&text),"assistantMessageId":token}),
        );
        session["status"] = json!("running");
        session["updatedAt"] = json!(now());
        session.as_object_mut().unwrap().remove("error");
        if let Err(e) = self.save() {
            self.state["sessions"][index] = old;
            return Err(e);
        }
        self.live.insert(
            sid.into(),
            Live {
                token: token.clone(),
                control,
            },
        );
        Ok((
            json!({"accepted":true,"id":sid,"requestId":request_id,"assistantMessageId":token}),
            Some((self.session(sid)?, token)),
        ))
    }
    pub fn current(&self, sid: &str, token: &str) -> bool {
        self.live.get(sid).is_some_and(|r| r.token == token)
    }
    pub fn emit(&mut self, sid: &str, token: &str, kind: &str, p: Value) {
        if !self.current(sid, token) {
            return;
        }
        let Ok(i) = self.index(sid) else { return };
        let session = &mut self.state["sessions"][i];
        if kind == "provider.session" {
            if let Some(id) = p["id"].as_str().filter(|v| !v.is_empty() && v.len() <= 512) {
                session["providerSessionId"] = json!(id)
            }
        } else if kind == "provider.settings" {
            let mut value = json!({});
            for key in ["model", "effort", "permissions", "sandbox"] {
                if let Some(v) = p[key].as_str() {
                    value[key] = json!(clip(v, 256))
                }
            }
            session["effectiveSettings"] = value;
        } else {
            let message = session["messages"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|m| m["id"] == token);
            let Some(message) = message else { return };
            if matches!(kind, "text.delta" | "text.done") {
                let t = if kind == "text.delta" {
                    format!("{}{}", s(message, "text"), s(&p, "text"))
                } else {
                    s(&p, "text").into()
                };
                message["text"] = json!(clip(&t, 65536));
                if t.chars().count() > 65536 {
                    message["textTruncated"] = json!(true)
                }
            } else if kind.starts_with("tool.") {
                let tool_id = s(&p, "id");
                if tool_id.is_empty() || tool_id.len() > 128 {
                    return;
                }
                let tools = message["tools"].as_array_mut().unwrap();
                let existing = tools.iter().position(|t| t["id"] == tool_id);
                if kind == "tool.start" {
                    if existing.is_some() {
                        return;
                    }
                    if tools.len() >= 16 {
                        message["toolsTruncated"] = json!(true);
                        self.dirty = true;
                        return;
                    }
                    let (input, truncated) = bound(&p["input"], 4096);
                    tools.push(json!({"id":tool_id,"name":clip(s(&p,"name"),128),"input":input,"text":"","status":"running","truncated":truncated}));
                } else if let Some(i) = existing {
                    let t = &mut tools[i];
                    let mut truncated = t["truncated"] == true;
                    match kind {
                        "tool.input" => {
                            let (v, tr) = bound(&p["input"], 4096);
                            t["input"] = v;
                            truncated |= tr
                        }
                        "tool.update" => {
                            let v = format!("{}{}", s(t, "text"), s(&p, "text"));
                            truncated |= v.chars().count() > 4096;
                            t["text"] = json!(clip(&v, 4096))
                        }
                        "tool.end" => {
                            let (v, tr) = bound(&p["result"], 4096);
                            t["result"] = v;
                            truncated |= tr;
                            t["isError"] = json!(p["isError"] == true);
                            t["status"] = json!(if p["isError"] == true {
                                "error"
                            } else {
                                "done"
                            })
                        }
                        _ => return,
                    };
                    t["truncated"] = json!(truncated)
                }
            } else {
                return;
            }
        }
        session["updatedAt"] = json!(now());
        self.dirty = true;
    }
    pub fn ask(
        &mut self,
        sid: &str,
        token: &str,
        wire: &str,
        mut record: Value,
    ) -> Option<oneshot::Receiver<bool>> {
        if !self.current(sid, token)
            || self.pending.values().filter(|p| p.session == sid).count() >= 16
        {
            return None;
        }
        let id = id();
        let (tx, rx) = oneshot::channel();
        let (details, truncated) = bound(&record["details"], 4096);
        record["details"] = details;
        record["truncated"] = json!(truncated);
        record["id"] = json!(id);
        record["title"] = json!(clip(s(&record, "title"), 256));
        record["description"] = json!(clip(s(&record, "description"), 2048));
        record["createdAt"] = json!(now());
        self.pending.insert(
            id,
            Pending {
                record,
                session: sid.into(),
                token: token.into(),
                wire: wire.into(),
                reply: tx,
            },
        );
        let i = self.index(sid).ok()?;
        self.state["sessions"][i]["status"] = json!("waiting");
        self.dirty = true;
        Some(rx)
    }
    pub fn expire(&mut self, sid: &str, wire: Option<&str>) {
        let ids = self
            .pending
            .iter()
            .filter(|(_, p)| p.session == sid && wire.is_none_or(|w| w == p.wire))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(p) = self.pending.remove(&id) {
                let _ = p.reply.send(false);
            }
        }
        if let Ok(i) = self.index(sid) {
            if self.live.contains_key(sid) {
                self.state["sessions"][i]["status"] =
                    json!(if self.pending.values().any(|p| p.session == sid) {
                        "waiting"
                    } else {
                        "running"
                    })
            }
        }
        self.dirty = true;
    }
    pub fn approve(&mut self, p: &Value) -> Result<Value> {
        let sid = s(p, "id");
        let allow = p["allow"]
            .as_bool()
            .ok_or_else(|| Error::new("INVALID_INPUT", "Approval requires an explicit boolean"))?;
        let key = s(p, "approvalId");
        let pending = self
            .pending
            .get(key)
            .ok_or_else(|| Error::new("APPROVAL_NOT_FOUND", "Approval is missing or expired"))?;
        if pending.session != sid || !self.current(sid, &pending.token) {
            return err("APPROVAL_NOT_FOUND", "Approval is not live in this session");
        }
        let entry = self.pending.remove(key).unwrap();
        let _ = entry.reply.send(allow);
        let i = self.index(sid)?;
        self.state["sessions"][i]["status"] =
            json!(if self.pending.values().any(|p| p.session == sid) {
                "waiting"
            } else {
                "running"
            });
        self.save()?;
        self.snapshot(sid)
    }
    pub fn finish(&mut self, sid: &str, token: &str, result: Result<()>) {
        if !self.current(sid, token) {
            return;
        }
        self.expire(sid, None);
        self.live.remove(sid);
        if let Ok(i) = self.index(sid) {
            let session = &mut self.state["sessions"][i];
            session["status"] = json!(if result.is_ok() { "idle" } else { "error" });
            session["updatedAt"] = json!(now());
            if let Err(e) = result {
                session["error"] = json!(clip(&e.message, 2048))
            }
            let _ = self.save();
        }
    }
    pub fn stop(&mut self, sid: &str, close: bool) -> Result<Value> {
        let i = self.index(sid)?;
        if self.state["sessions"][i]["status"] == "closed" {
            return self.snapshot(sid);
        }
        if let Some(live) = self.live.remove(sid) {
            let _ = live.control.try_send(Control::Abort);
        }
        self.expire(sid, None);
        let session = &mut self.state["sessions"][i];
        session["status"] = json!(if close { "closed" } else { "interrupted" });
        session["updatedAt"] = json!(now());
        session.as_object_mut().unwrap().remove("error");
        self.save()?;
        self.snapshot(sid)
    }
    pub fn history(&self, p: &Value) -> Result<Value> {
        history::original(
            &self.path.parent().unwrap().join("omp-sessions"),
            &self.session(s(p, "id"))?,
            p,
        )
    }
    pub fn search(&self, query: &str) -> Result<Value> {
        if query.chars().count() > 200 {
            return err("INVALID_INPUT", "Search is limited to 200 characters");
        }
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return Ok(json!([]));
        }
        Ok(json!(
            self.state["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|session| session["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| s(m, "text").to_lowercase().contains(&q))
                    .map(|m| json!({"id":session["id"],"snippet":clip(s(m,"text"),200)})))
                .collect::<Vec<_>>()
        ))
    }
    pub fn export(&self, sid: &str, format: &str) -> Result<Value> {
        let mut session = self.session(sid)?;
        for k in ["requests", "providerSessionId", "effectiveSettings"] {
            session.as_object_mut().unwrap().remove(k);
        }
        if format == "json" {
            return Ok(
                json!({"filename":format!("conversation-{sid}.json"),"mime":"application/json","content":serde_json::to_string_pretty(&session)?}),
            );
        }
        if format != "markdown" {
            return err("INVALID_INPUT", "Choose markdown or json");
        }
        let mut out = format!(
            "# {}\n\nAgent: {}\nDirectory: {}\nMachine: {}\n\n",
            s(&session, "name"),
            s(&session, "provider"),
            s(&session, "cwd"),
            s(&session, "machineId")
        );
        for m in session["messages"].as_array().unwrap() {
            out.push_str(&format!("## {}\n\n{}\n\n", s(m, "role"), s(m, "text")));
            if m["toolsTruncated"] == true {
                out.push_str(
                    "Only the first 16 tool calls were retained in the plugin preview.\n\n",
                )
            }
            for tool in m["tools"].as_array().unwrap() {
                let data = serde_json::to_string_pretty(
                    &json!({"input":tool["input"],"result":tool["result"],"status":tool["status"]}),
                )?;
                let n = data
                    .split(|c| c != '`')
                    .map(str::len)
                    .max()
                    .unwrap_or(0)
                    .max(2)
                    + 1;
                let fence = "`".repeat(n);
                out.push_str(&format!(
                    "### Tool: {}\n\n{fence}\n{data}\n{fence}\n\n",
                    s(tool, "name")
                ));
            }
        }
        Ok(
            json!({"filename":format!("conversation-{sid}.md"),"mime":"text/markdown","content":out}),
        )
    }
}
