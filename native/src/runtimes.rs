use crate::{
    chat::{ChatStore, Control},
    common::*,
    hosts::Host,
    protocol::Wire,
    settings,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{Mutex, mpsc};
enum Incoming {
    Control(Option<Control>),
    Frame(Result<Value>),
}

pub struct Context {
    pub chat: Arc<Mutex<ChatStore>>,
    pub sid: String,
    pub token: String,
    pub session: Value,
    pub host: Host,
    pub executable: String,
    pub session_root: PathBuf,
    pub namespace: String,
    pub config: Value,
}
impl Context {
    async fn emit(&self, kind: &str, value: Value) {
        self.chat
            .lock()
            .await
            .emit(&self.sid, &self.token, kind, value)
    }
    async fn ask(&self, wire: &str, record: Value, tx: mpsc::Sender<Control>, timeout: u64) {
        let rx = self
            .chat
            .lock()
            .await
            .ask(&self.sid, &self.token, wire, record);
        let wire = wire.to_owned();
        let chat = self.chat.clone();
        let sid = self.sid.clone();
        tokio::spawn(async move {
            let allowed = if let Some(rx) = rx {
                tokio::time::timeout(Duration::from_millis(timeout), rx)
                    .await
                    .ok()
                    .and_then(|v| v.ok())
                    .unwrap_or(false)
            } else {
                false
            };
            chat.lock().await.expire(&sid, Some(&wire));
            let _ = tx
                .send(Control::Approval {
                    wire,
                    allow: allowed,
                })
                .await;
        });
    }
    async fn expire(&self, wire: Option<&str>) {
        self.chat.lock().await.expire(&self.sid, wire)
    }
}
fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|s| (*s).to_owned()).collect()
}
fn valid_wire_id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn text_of(v: &Value) -> String {
    v["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("")
}
async fn tool(
    ctx: &Context,
    known: &mut HashSet<String>,
    id: &str,
    name: &str,
    input: Value,
    result: Value,
    done: bool,
    failed: bool,
) -> Result<()> {
    if !valid_wire_id(id) {
        return err("PROTOCOL_ERROR", "Invalid Codex tool identity");
    }
    if known.len() >= 4096 && !known.contains(id) {
        return err("PROTOCOL_ERROR", "Turn tool limit exceeded");
    }
    ctx.emit(
        if known.insert(id.into()) {
            "tool.start"
        } else {
            "tool.input"
        },
        json!({"id":id,"name":name,"input":input}),
    )
    .await;
    if done {
        ctx.emit(
            "tool.end",
            json!({"id":id,"result":result,"isError":failed}),
        )
        .await;
    }
    Ok(())
}
pub async fn run(
    ctx: Context,
    prompt: String,
    rx: mpsc::Receiver<Control>,
    tx: mpsc::Sender<Control>,
) -> Result<()> {
    match s(&ctx.session, "provider") {
        "codex" => codex(ctx, prompt, rx, tx).await,
        "omp" => omp(ctx, prompt, rx, tx).await,
        "claude" => claude(ctx, prompt, rx, tx).await,
        _ => err("UNSUPPORTED", "Unknown provider"),
    }
}
async fn codex(
    ctx: Context,
    prompt: String,
    mut controls: mpsc::Receiver<Control>,
    tx: mpsc::Sender<Control>,
) -> Result<()> {
    let cwd = ctx.host.directory(s(&ctx.session, "cwd")).await?;
    let mut wire = Wire::spawn(
        &ctx.host,
        &ctx.executable,
        &strings(&["app-server", "--listen", "stdio://"]),
        &cwd,
        "codex",
    )?;
    wire.request("initialize",json!({"clientInfo":{"name":"dsh_remote_agents","version":env!("CARGO_PKG_VERSION")},"capabilities":null})).await?;
    wire.send(json!({"method":"initialized","params":{}}))
        .await?;
    let inherited = wire
        .request("config/read", json!({"cwd":cwd,"includeLayers":false}))
        .await?["config"]
        .clone();
    let settings = &ctx.session["settings"];
    let mut options = if settings["permissions"] == "cli" {
        let mut v = json!({});
        for (from, to) in [
            ("approval_policy", "approvalPolicy"),
            ("sandbox_mode", "sandbox"),
            ("approvals_reviewer", "approvalsReviewer"),
        ] {
            if !inherited[from].is_null() {
                v[to] = inherited[from].clone()
            }
        }
        v
    } else {
        settings::codex_policy(s(settings, "permissions"))
    };
    options["cwd"] = json!(cwd);
    let model = if settings["model"].is_null() {
        &inherited["model"]
    } else {
        &settings["model"]
    };
    if !model.is_null() {
        options["model"] = model.clone()
    }
    let effort = if settings["effort"].is_null() {
        &inherited["model_reasoning_effort"]
    } else {
        &settings["effort"]
    };
    if !effort.is_null() {
        options["config"] = json!({"model_reasoning_effort":effort})
    }
    let resume = s(&ctx.session, "providerSessionId");
    if !resume.is_empty() {
        options["threadId"] = json!(resume)
    }
    let result = wire
        .request(
            if resume.is_empty() {
                "thread/start"
            } else {
                "thread/resume"
            },
            options,
        )
        .await?;
    let thread = s(&result["thread"], "id").to_owned();
    if !valid_wire_id(&thread)
        || (!resume.is_empty() && thread != resume)
        || ctx.host.directory(s(&result["thread"], "cwd")).await? != cwd
    {
        return err(
            "PROTOCOL_ERROR",
            "Codex thread identity or directory mismatch",
        );
    };
    ctx.emit("provider.session", json!({"id":thread})).await;
    ctx.emit("provider.settings",json!({"model":result["model"],"effort":result["reasoningEffort"],"permissions":result["approvalPolicy"],"sandbox":result["sandbox"]["type"]})).await;
    let mut args =
        json!({"threadId":thread,"input":[{"type":"text","text":prompt,"text_elements":[]}]});
    if !settings["effort"].is_null() {
        args["effort"] = settings["effort"].clone()
    }
    let response = wire.request("turn/start", args).await?;
    let turn = s(&response["turn"], "id").to_owned();
    if !valid_wire_id(&turn) {
        return err("PROTOCOL_ERROR", "Invalid Codex turn acknowledgement");
    };
    let mut texts: Vec<(String, String)> = vec![];
    let mut known = HashSet::new();
    let mut approvals = HashMap::new();
    loop {
        let incoming = tokio::select! { control=controls.recv()=>Incoming::Control(control),frame=wire.next()=>Incoming::Frame(frame) };
        match incoming {
            Incoming::Control(control) => match control {
                Some(Control::Abort) | None => {
                    let _=wire.send(json!({"id":"stop","method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}})).await;
                    wire.close().await;
                    return err("INTERRUPTED", "Turn interrupted");
                }
                Some(Control::Approval { wire: key, allow }) => {
                    if let Some(id) = approvals.remove(&key) {
                        wire.send(json!({"id":id,"result":{"decision":if allow{"accept"}else{"decline"}}})).await?
                    }
                }
            },
            Incoming::Frame(frame) => {
                let frame = frame?;
                let method = s(&frame, "method");
                let p = &frame["params"];
                if method.is_empty() {
                    continue;
                }
                if frame.get("id").is_some() {
                    let id = frame["id"].clone();
                    let supported = matches!(
                        method,
                        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
                    );
                    if !supported {
                        wire.send(if method=="item/permissions/requestApproval"{json!({"id":id,"result":{"permissions":{},"scope":"turn"}})}else{json!({"id":id,"error":{"code":-32601,"message":"Only command and file approvals are supported"}})}).await?;
                        return err(
                            "UNSUPPORTED",
                            format!(
                                "Unsupported interaction: {method}. Continue in the native CLI."
                            ),
                        );
                    }
                    if p["threadId"] != thread || p["turnId"] != turn {
                        wire.send(json!({"id":id,"result":{"decision":"decline"}}))
                            .await?;
                        continue;
                    }
                    let key = id.to_string();
                    if approvals.insert(key.clone(), id).is_some() {
                        return err("PROTOCOL_ERROR", "Duplicate Codex approval");
                    };
                    ctx.ask(&key,json!({"kind":"permission","title":if method.contains("commandExecution"){"Allow command?"}else{"Allow file changes?"},"description":p.get("reason").unwrap_or(&p["command"]),"details":{"toolName":if method.contains("commandExecution"){"commandExecution"}else{"fileChange"},"input":{"command":p["command"],"cwd":p["cwd"],"itemId":p["itemId"]},"grant":"this call only"}}),tx.clone(),300000).await;
                    continue;
                }
                if p["threadId"] != thread {
                    continue;
                }
                if method == "serverRequest/resolved" {
                    let key = p["requestId"].to_string();
                    approvals.remove(&key);
                    ctx.expire(Some(&key)).await;
                    continue;
                }
                if p.get("turnId").unwrap_or(&p["turn"]["id"]) != &json!(turn) {
                    continue;
                }
                if method == "item/agentMessage/delta" {
                    update_text(&mut texts, s(p, "itemId"), s(p, "delta"), true)?;
                    ctx.emit("text.done", json!({"text":join_text(&texts,"\n\n")}))
                        .await;
                } else if matches!(method, "item/started" | "item/completed") {
                    let item = &p["item"];
                    let done = method == "item/completed";
                    let id = s(item, "id");
                    let failed = matches!(s(item, "status"), "failed" | "declined");
                    match s(item,"type"){
         "agentMessage"=>{update_text(&mut texts,id,s(item,"text"),false)?;ctx.emit("text.done",json!({"text":join_text(&texts,"\n\n")})).await;},
         "commandExecution"=>tool(&ctx,&mut known,id,"commandExecution",json!({"command":item["command"],"cwd":item["cwd"]}),json!({"content":[{"type":"text","text":item.get("aggregatedOutput").unwrap_or(&json!(""))}],"details":{"exitCode":item["exitCode"]}}),done,failed||item["exitCode"].as_i64().is_some_and(|c|c!=0)).await?,
         "fileChange"=>tool(&ctx,&mut known,id,"fileChange",json!({"changes":item["changes"]}),item["status"].clone(),done,failed).await?,
         "mcpToolCall"=>tool(&ctx,&mut known,id,&format!("mcp__{}__{}",s(item,"server"),s(item,"tool")),item["arguments"].clone(),item.get("error").unwrap_or(&item["result"]).clone(),done,failed||!item["error"].is_null()).await?,
         "webSearch"=>tool(&ctx,&mut known,id,"web_search",json!({"query":item["query"],"action":item["action"]}),item["action"].clone(),done,false).await?,
         "collabAgentToolCall"=>tool(&ctx,&mut known,id,"agent",json!({"description":item["tool"],"prompt":item["prompt"],"agents":item["receiverThreadIds"]}),item["agentsStates"].clone(),done,failed).await?,
         "plan"=>tool(&ctx,&mut known,id,"Plan",json!({}),item["text"].clone(),done,false).await?,_=>{}}
                } else if matches!(
                    method,
                    "item/commandExecution/outputDelta" | "item/fileChange/outputDelta"
                ) {
                    ctx.emit("tool.update", json!({"id":p["itemId"],"text":p["delta"]}))
                        .await;
                } else if method == "turn/plan/updated" {
                    let todos=p["plan"].as_array().into_iter().flatten().map(|s|json!({"content":s["step"],"status":if s["status"]=="inProgress"{json!("in_progress")}else{s["status"].clone()}})).collect::<Vec<_>>();
                    tool(
                        &ctx,
                        &mut known,
                        &format!("plan-{turn}"),
                        "update_plan",
                        json!({"todos":todos}),
                        p["explanation"].clone(),
                        true,
                        false,
                    )
                    .await?;
                } else if method == "turn/completed" {
                    ctx.emit("text.done", json!({"text":join_text(&texts,"\n\n")}))
                        .await;
                    ctx.expire(None).await;
                    wire.close().await;
                    if p["turn"]["status"] == "completed" {
                        return Ok(());
                    }
                    return err(
                        "CLI_ERROR",
                        format!(
                            "Codex turn {}: {}",
                            s(&p["turn"], "status"),
                            s(&p["turn"]["error"], "message")
                        ),
                    );
                }
            }
        }
    }
}
fn join_text(texts: &[(String, String)], separator: &str) -> String {
    texts
        .iter()
        .map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(separator)
}
fn update_text(
    texts: &mut Vec<(String, String)>,
    id: &str,
    value: &str,
    delta: bool,
) -> Result<()> {
    if id.is_empty() || id.len() > 512 {
        return err("PROTOCOL_ERROR", "Missing message identity");
    }
    if let Some((_, v)) = texts.iter_mut().find(|(k, _)| k == id) {
        if delta {
            v.push_str(value)
        } else {
            *v = value.into()
        }
    } else {
        texts.push((id.into(), value.into()))
    }
    if texts.len() > 4096 || texts.iter().map(|(_, t)| t.len()).sum::<usize>() > 64 * 1024 * 1024 {
        return err("PROTOCOL_ERROR", "Turn text exceeds limit");
    }
    Ok(())
}
async fn omp(
    ctx: Context,
    prompt: String,
    mut controls: mpsc::Receiver<Control>,
    tx: mpsc::Sender<Control>,
) -> Result<()> {
    if prompt.trim_start().starts_with(['/', '!']) {
        return err(
            "UNSUPPORTED",
            "OMP slash and shell commands are not supported in structured chat",
        );
    }
    let cwd = ctx.host.directory(s(&ctx.session, "cwd")).await?;
    let directory = if ctx.host.remote() {
        if !safe_id(&ctx.namespace) || !safe_id(&ctx.sid) {
            return err("INVALID_INPUT", "Invalid owned session directory");
        }
        let path = format!(
            "~/.dsh/remote-agents/omp-sessions/{}/{}",
            ctx.namespace, ctx.sid
        );
        let q = crate::hosts::shell_path(&path)?;
        ctx.host
            .shell(
                &format!("umask 077; mkdir -p {q} && test ! -L {q} && chmod 700 {q}"),
                4096,
            )
            .await?;
        ctx.host.directory(&path).await?
    } else {
        let path = ctx.session_root.join(&ctx.sid);
        std::fs::create_dir_all(&path)?;
        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return err("INVALID_INPUT", "Unsafe OMP session directory");
        };
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        path.canonicalize()?.to_string_lossy().into_owned()
    };
    let settings = &ctx.session["settings"];
    let mut args = strings(&[
        "--mode",
        "rpc-ui",
        "--no-title",
        "--no-pty",
        "--cwd",
        &cwd,
        "--session-dir",
        &directory,
    ]);
    for (key, flag) in [
        ("permissions", "--approval-mode"),
        ("model", "--model"),
        ("effort", "--thinking"),
    ] {
        if let Some(value) = settings[key].as_str() {
            if key != "permissions" || value != "cli" {
                args.extend([flag.into(), value.into()])
            }
        }
    }
    let resume = s(&ctx.session, "providerSessionId");
    if !resume.is_empty() {
        args.push("--continue".into())
    };
    let mut wire = Wire::spawn(&ctx.host, &ctx.executable, &args, &cwd, "omp")?;
    let ready = wire.ready().await?;
    if ready["protocolVersion"] != 1
        || !ready["supportedProtocolVersions"]
            .as_array()
            .is_some_and(|a| a.contains(&json!(2)))
    {
        return err("PROTOCOL_ERROR", "OMP requires protocol v2");
    };
    if wire
        .request("negotiate_protocol", json!({"protocolVersion":2}))
        .await?["protocolVersion"]
        != 2
    {
        return err("PROTOCOL_ERROR", "OMP protocol negotiation failed");
    };
    let state = wire.request("get_state", json!({})).await?;
    let native = s(&state, "sessionId");
    if native.is_empty()
        || native.len() > 512
        || (!resume.is_empty() && native != resume)
        || state.get("cwd").is_some_and(|v| v != &json!(cwd))
    {
        return err("PROTOCOL_ERROR", "OMP native session identity/cwd mismatch");
    };
    if let Some(file) = state["sessionFile"].as_str() {
        let path = std::path::Path::new(file);
        if !path.starts_with(&directory)
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return err(
                "PROTOCOL_ERROR",
                "OMP session escaped its private directory",
            );
        }
    }
    ctx.emit("provider.session", json!({"id":native})).await;
    ctx.emit("provider.settings",json!({"model":if state["model"]["id"].is_string(){json!(format!("{}/{}",s(&state["model"],"provider"),s(&state["model"],"id")))}else{Value::Null},"effort":state["thinkingLevel"],"permissions":state["approvalMode"]})).await;
    let prompt_id = id();
    let admission = wire
        .request_id("prompt", json!({"message":prompt}), &prompt_id)
        .await?;
    if admission["agentInvoked"] == false {
        wire.close().await;
        return Ok(());
    };
    let mut texts: Vec<(String, String)> = vec![];
    let mut tool_texts = HashMap::new();
    let mut approvals: HashMap<String, Option<String>> = HashMap::new();
    let mut completed = false;
    let mut settled = false;
    loop {
        let incoming = tokio::select! { control=controls.recv()=>Incoming::Control(control),frame=wire.next()=>Incoming::Frame(frame) };
        match incoming {
            Incoming::Control(control) => match control {
                Some(Control::Abort) | None => {
                    let _ = wire.send(json!({"id":"interrupt","type":"abort"})).await;
                    wire.close().await;
                    return err("INTERRUPTED", "OMP turn interrupted");
                }
                Some(Control::Approval { wire: key, allow }) => {
                    if let Some(choice) = approvals.remove(&key) {
                        let frame = if let Some(once) = choice {
                            json!({"type":"extension_ui_response","id":key,"value":if allow{once}else{"Deny".into()}})
                        } else {
                            json!({"type":"extension_ui_response","id":key,"confirmed":allow})
                        };
                        wire.send(frame).await?
                    }
                }
            },
            Incoming::Frame(frame) => {
                let frame = frame?;
                match s(&frame,"type"){
         "rpc_frame_error"=>return err("PROTOCOL_ERROR","OMP transport overflow"),
         "message_start"|"message_update"|"message_end"=>{if frame["message"]["role"]!="assistant"{continue}let message_id=s(&frame,"messageId");let old=texts.iter().find(|(k,_)|k==message_id).map(|(_,s)|s.as_str()).unwrap_or("");let text=if frame["message"]["content"].is_array(){text_of(&frame["message"])}else if frame["assistantMessageEvent"]["type"]=="text_delta"{format!("{old}{}",s(&frame["assistantMessageEvent"],"delta"))}else{old.into()};update_text(&mut texts,message_id,&text,false)?;ctx.emit("text.done",json!({"text":join_text(&texts,"")})).await;},
         "tool_execution_start"=>ctx.emit("tool.start",json!({"id":frame["toolCallId"],"name":frame["toolName"],"input":frame["args"]})).await,
         "tool_execution_update"=>{let key=s(&frame,"toolCallId").to_owned();let next=text_of(&frame["partialResult"]);let old=tool_texts.insert(key,next.clone()).unwrap_or_default();let delta=next.strip_prefix(&old).unwrap_or(&next);ctx.emit("tool.update",json!({"id":frame["toolCallId"],"text":delta})).await;},
         "tool_execution_end"=>ctx.emit("tool.end",json!({"id":frame["toolCallId"],"result":frame["result"],"isError":frame["isError"]})).await,
         "prompt_result"=>if frame["id"]==prompt_id{if frame["status"]!="completed"{return err("CLI_ERROR",format!("OMP turn {}",s(&frame,"status")))}completed=true;settled|=frame["sessionSettled"]==true},
         "session_settled"=>settled=true,"agent_start"=>settled=false,
         "extension_ui_request"=>{let method=s(&frame,"method");let key=s(&frame,"id");if method=="cancel"{let target=s(&frame,"targetId");approvals.remove(target);ctx.expire(Some(target)).await;continue}if ["notify","setStatus","setWidget","setTitle","set_editor_text"].contains(&method){continue}if key.is_empty()||approvals.contains_key(key){return err("PROTOCOL_ERROR","Invalid OMP dialog identity")};let options=frame["options"].as_array();let once=if options.is_some_and(|a|a.contains(&json!("Approve Once"))){"Approve Once"}else{"Approve"};let select=method=="select"&&s(&frame,"title").starts_with("Allow tool: ")&&options.is_some_and(|a|a.len()>=2&&a.last()==Some(&json!("Deny"))&&a.iter().filter(|v|v==&&json!(once)).count()==1&&a.iter().filter(|v|v==&&json!("Deny")).count()==1&&a.iter().all(|v|{let Some(t)=v.as_str()else{return false};t==once||t=="Deny"||t.starts_with("Approve ")&&t.ends_with(" for this session")||once=="Approve Once"&&(["Approve","Approve File","Always Approve","Always Approve File"].contains(&t)||t.starts_with("Approve Directory: ")||t.starts_with("Always Approve Directory: "))})&&a.iter().map(Value::to_string).collect::<HashSet<_>>().len()==a.len());if method!="confirm"&&!select{wire.send(json!({"type":"extension_ui_response","id":key,"cancelled":true})).await?;ctx.emit("tool.start",json!({"id":format!("unsupported-{key}"),"name":"Unsupported OMP dialog","input":{"method":method}})).await;ctx.emit("tool.end",json!({"id":format!("unsupported-{key}"),"isError":true,"result":"Dialog cancelled: only boolean approvals are supported."})).await;continue}approvals.insert(key.into(),if select{Some(once.into())}else{None});ctx.ask(key,json!({"kind":"permission","title":frame["title"],"description":frame.get("message").unwrap_or(&frame["title"]),"details":if select{json!({"options":frame["options"],"grant":"this call only"})}else{Value::Null}}),tx.clone(),frame["timeout"].as_u64().unwrap_or(300000).clamp(1,300000)).await;},_=>{}}
                if completed && settled {
                    ctx.emit("text.done", json!({"text":join_text(&texts,"")}))
                        .await;
                    ctx.expire(None).await;
                    wire.close().await;
                    return Ok(());
                }
            }
        }
    }
}
#[derive(Default)]
struct ClaudeText {
    messages: Vec<(String, BTreeMap<usize, (String, String, bool)>)>,
    current: String,
    sequence: usize,
    seen: HashSet<String>,
    tools: HashSet<String>,
    ended: HashSet<String>,
    stream_tools: HashMap<usize, String>,
}
impl ClaudeText {
    fn blocks(&mut self, id: &str) -> &mut BTreeMap<usize, (String, String, bool)> {
        let index = if let Some(i) = self.messages.iter().position(|(k, _)| k == id) {
            i
        } else {
            self.messages.push((id.into(), BTreeMap::new()));
            self.messages.len() - 1
        };
        &mut self.messages[index].1
    }
    fn text(&self) -> String {
        self.messages
            .iter()
            .flat_map(|(_, b)| b.values())
            .filter(|(kind, _, _)| kind == "text")
            .map(|(_, text, _)| text.as_str())
            .collect::<Vec<_>>()
            .join("")
    }
}
async fn claude(
    ctx: Context,
    prompt: String,
    mut controls: mpsc::Receiver<Control>,
    tx: mpsc::Sender<Control>,
) -> Result<()> {
    let node = required(&ctx.config, "nodeExecutable", 4096)?;
    let bridge = required(&ctx.config, "claudeBridge", 4096)?;
    let local = Host {
        machine: json!({"type":"local"}),
    };
    let mut wire = Wire::spawn(
        &local,
        &node,
        &[bridge],
        std::env::current_dir()?.to_str().unwrap_or("/"),
        "bridge",
    )?;
    wire.send(json!({"type":"start","session":ctx.session,"executable":ctx.executable,"prompt":prompt,"backendBinary":std::env::current_exe()?.to_string_lossy(),"machine":ctx.host.machine})).await?;
    let mut text = ClaudeText::default();
    let mut approvals: HashSet<String> = HashSet::new();
    let mut native = s(&ctx.session, "providerSessionId").to_owned();
    let mut result_seen = false;
    let mut result_error = None;
    loop {
        let incoming = tokio::select! { control=controls.recv()=>Incoming::Control(control),frame=wire.next()=>Incoming::Frame(frame) };
        match incoming {
            Incoming::Control(control) => match control {
                Some(Control::Abort) | None => {
                    let _ = wire.send(json!({"type":"abort"})).await;
                    wire.close().await;
                    return err("INTERRUPTED", "Claude turn interrupted");
                }
                Some(Control::Approval { wire: key, allow }) => {
                    if approvals.remove(&key) {
                        wire.send(json!({"type":"approval","id":key,"allow":allow&&!result_seen}))
                            .await?
                    }
                }
            },
            Incoming::Frame(frame) => {
                let frame = frame?;
                match s(&frame, "type") {
                    "bridge_error" => return err("CLI_ERROR", clip(s(&frame, "message"), 2048)),
                    "bridge_end" => {
                        wire.close().await;
                        if !result_seen {
                            return err("CLI_ERROR", "Claude stream ended without a result");
                        }
                        return if let Some(error) = result_error {
                            err("CLI_ERROR", error)
                        } else {
                            Ok(())
                        };
                    }
                    "bridge_cancel" => {
                        let key = s(&frame, "id");
                        approvals.remove(key);
                        ctx.expire(Some(key)).await;
                    }
                    "bridge_approval" => {
                        let key = s(&frame, "id");
                        if key.is_empty() || !approvals.insert(key.into()) {
                            return err("PROTOCOL_ERROR", "Invalid Claude approval identity");
                        }
                        if result_seen
                            || frame["toolName"] == "AskUserQuestion"
                            || frame["requiresUserInteraction"] == true
                        {
                            approvals.remove(key);
                            wire.send(json!({"type":"approval","id":key,"allow":false}))
                                .await?;
                            continue;
                        }
                        ctx.ask(key,json!({"kind":"tool","title":frame.get("title").filter(|v|v.is_string()).cloned().unwrap_or(json!(format!("Allow {}?",s(&frame,"toolName")))),"description":frame.get("description").filter(|v|v.is_string()).cloned().unwrap_or(json!(format!("Claude requests permission to use {}",s(&frame,"toolName")))),"details":{"toolName":frame["toolName"],"input":frame["input"]}}),tx.clone(),300000).await;
                    }
                    "sdk_message" => {
                        let m = &frame["message"];
                        if !s(m, "parent_tool_use_id").is_empty()
                            || !s(m, "agent_id").is_empty()
                            || !s(m, "agentId").is_empty()
                        {
                            continue;
                        }
                        let kind = s(m, "type");
                        if kind == "system" && m["subtype"] == "init" || kind == "result" {
                            let found = s(m, "session_id");
                            if !found.is_empty() {
                                if !native.is_empty() && native != found {
                                    return err(
                                        "PROTOCOL_ERROR",
                                        "Claude changed the owned session identity",
                                    );
                                }
                                native = found.into();
                                ctx.emit("provider.session", json!({"id":native})).await;
                            }
                            if kind == "system" {
                                ctx.emit("provider.settings",json!({"model":m["model"],"effort":m["effort"],"permissions":m["permissionMode"]})).await;
                            }
                        }
                        if kind == "result" {
                            result_seen = true;
                            ctx.expire(None).await;
                            approvals.clear();
                            if m["subtype"] != "success" || m["is_error"] == true {
                                result_error = Some(if m["errors"].is_array() {
                                    m["errors"]
                                        .as_array()
                                        .unwrap()
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .collect::<Vec<_>>()
                                        .join("\n")
                                } else if m["result"].is_string() {
                                    s(m, "result").into()
                                } else {
                                    format!("Claude result: {}", s(m, "subtype"))
                                });
                            } else if text.text().is_empty() && m["result"].is_string() {
                                ctx.emit("text.done", json!({"text":m["result"]})).await;
                            }
                            continue;
                        }
                        if result_seen {
                            continue;
                        }
                        if kind == "stream_event" {
                            let event = &m["event"];
                            match s(event, "type") {
                                "message_start" => {
                                    text.sequence += 1;
                                    text.current = event["message"]["id"]
                                        .as_str()
                                        .map(String::from)
                                        .unwrap_or(format!("partial-{}", text.sequence));
                                    text.stream_tools.clear();
                                }
                                "content_block_start" => {
                                    if text.current.is_empty() {
                                        text.sequence += 1;
                                        text.current = format!("partial-{}", text.sequence)
                                    }
                                    let block = &event["content_block"];
                                    let key = text.current.clone();
                                    let i = event["index"].as_u64().unwrap_or(0) as usize;
                                    text.blocks(&key).entry(i).or_insert((
                                        s(block, "type").into(),
                                        s(block, "text").into(),
                                        false,
                                    ));
                                    if block["type"] == "tool_use" {
                                        let id = s(block, "id");
                                        if text.tools.insert(id.into()) {
                                            ctx.emit("tool.start",json!({"id":id,"name":block["name"],"input":block["input"]})).await;
                                        }
                                        text.stream_tools.insert(i, id.into());
                                    }
                                }
                                "content_block_delta" => {
                                    let delta = &event["delta"];
                                    let i = event["index"].as_u64().unwrap_or(0) as usize;
                                    if delta["type"] == "text_delta" {
                                        if text.current.is_empty() {
                                            text.sequence += 1;
                                            text.current = format!("partial-{}", text.sequence)
                                        }
                                        let key = text.current.clone();
                                        let b = text.blocks(&key).entry(i).or_insert((
                                            "text".into(),
                                            String::new(),
                                            false,
                                        ));
                                        if !b.2 {
                                            b.1.push_str(s(delta, "text"));
                                            ctx.emit("text.done", json!({"text":text.text()}))
                                                .await;
                                        }
                                    } else if delta["type"] == "input_json_delta" {
                                        if let Some(id) = text.stream_tools.get(&i) {
                                            ctx.emit(
                                                "tool.update",
                                                json!({"id":id,"text":delta["partial_json"]}),
                                            )
                                            .await;
                                        }
                                    }
                                }
                                _ => {}
                            }
                        } else if kind == "assistant" {
                            let uuid = s(m, "uuid");
                            if !uuid.is_empty() && !text.seen.insert(uuid.into()) {
                                continue;
                            }
                            let key = if !s(&m["message"], "id").is_empty() {
                                s(&m["message"], "id").to_owned()
                            } else if !text.current.is_empty() {
                                text.current.clone()
                            } else {
                                text.sequence += 1;
                                format!("assistant-{}", text.sequence)
                            };
                            if text.current.starts_with("partial-")
                                && text.current != key
                                && !text.messages.iter().any(|(k, _)| k == &key)
                            {
                                if let Some((k, _)) =
                                    text.messages.iter_mut().find(|(k, _)| k == &text.current)
                                {
                                    *k = key.clone();
                                }
                                text.current = key.clone();
                            }
                            for b in m["message"]["content"].as_array().into_iter().flatten() {
                                let blocks = text.blocks(&key);
                                let index = blocks
                                    .iter()
                                    .find(|(_, v)| !v.2 && v.0 == s(b, "type"))
                                    .map(|(i, _)| *i)
                                    .unwrap_or_else(|| {
                                        blocks.keys().last().map(|i| i + 1).unwrap_or(0)
                                    });
                                blocks.insert(
                                    index,
                                    (s(b, "type").into(), s(b, "text").into(), true),
                                );
                                if b["type"] == "tool_use" {
                                    let id = s(b, "id");
                                    ctx.emit(
                                        if text.tools.insert(id.into()) {
                                            "tool.start"
                                        } else {
                                            "tool.input"
                                        },
                                        json!({"id":id,"name":b["name"],"input":b["input"]}),
                                    )
                                    .await;
                                }
                            }
                            ctx.emit("text.done", json!({"text":text.text()})).await;
                        } else if kind == "user" {
                            for b in m["message"]["content"].as_array().into_iter().flatten() {
                                if b["type"] == "tool_result"
                                    && text.ended.insert(s(b, "tool_use_id").into())
                                {
                                    ctx.emit("tool.end",json!({"id":b["tool_use_id"],"result":b["content"],"isError":b["is_error"]})).await;
                                }
                            }
                        } else if kind == "tool_progress" {
                            ctx.emit("tool.update",json!({"id":m["tool_use_id"],"text":format!("Running {}",s(m,"tool_name"))})).await;
                        }
                        if text.messages.len() > 4096
                            || text.tools.len() > 4096
                            || text.text().len() > 64 * 1024 * 1024
                        {
                            return err("PROTOCOL_ERROR", "Claude turn exceeds bounds");
                        }
                    }
                    _ => return err("PROTOCOL_ERROR", "Unknown SDK bridge frame"),
                }
            }
        }
    }
}
