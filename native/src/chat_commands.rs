use crate::{chat::ChatStore, common::*, settings};
use serde_json::{Value, json};

const MAX_NEW_RECEIPTS: usize = 128;

pub struct Command {
    pub name: &'static str,
    pub argument: String,
    pub text: String,
    pub request_id: String,
}

pub fn catalog() -> Value {
    json!([
        {"name":"help","usage":"/help","description":"Show conversation commands","allowActive":true,"allowClosed":true},
        {"name":"status","usage":"/status","description":"Show conversation status and settings","allowActive":true,"allowClosed":true},
        {"name":"model","usage":"/model [selector|default]","description":"Show available models or choose a model","allowActive":false,"allowClosed":false},
        {"name":"effort","usage":"/effort [value|default]","description":"Show or change reasoning effort","allowActive":false,"allowClosed":false},
        {"name":"permissions","usage":"/permissions [mode]","description":"Show or change permission mode","allowActive":false,"allowClosed":false},
        {"name":"rename","usage":"/rename <name>","description":"Rename this conversation","allowActive":false,"allowClosed":false},
        {"name":"pin","usage":"/pin [on|off]","description":"Show or change pinned state","allowActive":false,"allowClosed":false},
        {"name":"archive","usage":"/archive [on|off]","description":"Show or change archived state","allowActive":false,"allowClosed":false},
        {"name":"new","usage":"/new","description":"Start a fresh conversation with the same agent, directory, and settings","allowActive":false,"allowClosed":true},
        {"name":"stop","usage":"/stop","description":"Interrupt the current turn","allowActive":true,"allowClosed":false},
        {"name":"export","usage":"/export [markdown|json]","description":"Download this conversation","allowActive":true,"allowClosed":true}
    ])
}

pub fn parse(p: &Value) -> Result<Command> {
    let raw_text = required(p, "text", 65536)?;
    let input = raw_text.trim();
    let Some(body) = input.strip_prefix('/') else {
        return err("INVALID_INPUT", "Use a slash command such as /help");
    };
    let (name, argument) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
    let name = match name {
        "help" => "help",
        "status" => "status",
        "model" => "model",
        "effort" => "effort",
        "permissions" => "permissions",
        "rename" => "rename",
        "pin" => "pin",
        "archive" => "archive",
        "new" => "new",
        "stop" => "stop",
        "export" => "export",
        _ => return err("INVALID_INPUT", "Unknown command. Use /help to see available commands."),
    };
    let argument = argument.trim();
    let valid = match name {
        "help" | "status" | "new" | "stop" => argument.is_empty(),
        "rename" => !argument.is_empty() && argument.chars().count() <= 100,
        "pin" | "archive" => matches!(argument, "" | "on" | "off"),
        "export" => matches!(argument, "" | "markdown" | "json"),
        _ => argument.split_whitespace().count() <= 1 && argument.chars().count() <= 256,
    };
    if !valid {
        let commands = catalog();
        let usage = commands.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        return err("INVALID_INPUT", format!("Usage: {}", s(usage, "usage")));
    }
    let request_id = required(p, "requestId", 128)?;
    if request_id.trim().is_empty() {
        return err("INVALID_INPUT", "requestId must not be blank");
    }
    Ok(Command { name, argument: argument.into(), text: raw_text, request_id })
}

pub fn reject_prompt(provider: &str, value: &Value) -> Result<()> {
    let prompt = value.as_str().unwrap_or("").trim_start();
    if prompt.starts_with('/') {
        return err("UNSUPPORTED", "Slash commands must use chatCommand. Use /help to see available commands.");
    }
    if provider == "omp" && prompt.starts_with('!') {
        return err("UNSUPPORTED", "OMP shell commands are unavailable in structured chat. Send a normal message or use /help for conversation commands.");
    }
    Ok(())
}

fn display(value: &Value) -> &str {
    value.as_str().unwrap_or("default (follow CLI)")
}

impl ChatStore {
    pub fn command_guard(&self, sid: &str, command: &Command) -> Result<()> {
        let session = &self.state["sessions"][self.index(sid)?];
        if session["status"] == "closed" && !matches!(command.name, "help" | "status" | "export" | "new") {
            return err("CLOSED", "Session is closed; use /new to start a fresh conversation");
        }
        if (self.live.contains_key(sid) || matches!(s(session, "status"), "running" | "waiting"))
            && !matches!(command.name, "help" | "status" | "stop" | "export")
        {
            return err("BUSY", "Finish the current turn or use /stop before running this command");
        }
        Ok(())
    }

    pub fn command_receipt(&self, sid: &str, command: &Command) -> Result<Option<Value>> {
        let source = &self.state["sessions"][self.index(sid)?];
        if let Some(receipt) = source["commandRequests"].as_array().into_iter().flatten()
            .find(|r| r["requestId"] == command.request_id)
        {
            if receipt["textHash"] != hash(&command.text) {
                return err("CONFLICT", "requestId already identifies a different command");
            }
            return Ok(Some(json!({"command":"new","message":"Fresh conversation created; previous history is retained.","session":self.snapshot(s(receipt,"sessionId"))?})));
        }
        Ok(None)
    }

    pub fn command(&mut self, p: &Value, command: &Command, options: Option<&Value>) -> Result<Value> {
        let sid = s(p, "id");
        if let Some(result) = self.command_receipt(sid, command)? { return Ok(result); }
        self.command_guard(sid, command)?;
        let source = &self.state["sessions"][self.index(sid)?];
        let argument = command.argument.as_str();
        let mut result = json!({"command":command.name});
        match command.name {
            "help" => {
                let commands = catalog();
                result["message"] = json!(commands.as_array().unwrap().iter()
                    .map(|c| format!("{} — {}", s(c,"usage"), s(c,"description")))
                    .collect::<Vec<_>>().join("\n"));
                result["commands"] = commands;
            }
            "status" => {
                result["message"] = json!(format!("{}\nAgent: {}\nStatus: {}\nMachine: {}\nDirectory: {}\nModel: {}\nEffort: {}\nPermissions: {}\nPinned: {}\nArchived: {}\nMessages: {}\nSettings revision: {}{}",
                    s(&source,"name"), s(&source,"provider"), s(&source,"status"), s(&source,"machineId"), s(&source,"cwd"),
                    display(&source["settings"]["model"]), display(&source["settings"]["effort"]), display(&source["settings"]["permissions"]),
                    source["pinned"] == true, source["archived"] == true, source["messages"].as_array().unwrap().len(), source["settingsRevision"],
                    source.get("error").and_then(Value::as_str).map(|e| format!("\nError: {e}")).unwrap_or_default()));
                result["session"] = self.snapshot(sid)?;
            }
            "model" | "effort" | "permissions" => {
                let provider = s(&source, "provider");
                if argument.is_empty() {
                    let choices = match command.name {
                        "model" => options.ok_or_else(|| Error::new("UNSUPPORTED", "Model catalog unavailable"))?["models"]
                            .as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect::<Vec<_>>().join(", "),
                        "effort" => settings::efforts(provider).join(", "),
                        _ => settings::permissions(provider).as_array().unwrap().iter().filter_map(|m| m["id"].as_str()).collect::<Vec<_>>().join(", "),
                    };
                    result["message"] = json!(format!("Current {}: {}\nChoices: {}{}", command.name, display(&source["settings"][command.name]),
                        if command.name == "permissions" { "" } else { "default, " }, choices));
                    result["session"] = self.snapshot(sid)?;
                } else {
                    let value = if argument == "default" && command.name != "permissions" { Value::Null } else { json!(argument) };
                    let mut patch = json!({});
                    patch[command.name] = value;
                    let mut request = json!({"id":sid,"patch":patch});
                    if let Some(expected) = p.get("expectedRevision") { request["expectedRevision"] = expected.clone(); }
                    let snapshot = self.configure(&request)?;
                    result["message"] = json!(format!("{}: {}", command.name, display(&snapshot["settings"][command.name])));
                    result["session"] = snapshot;
                }
            }
            "rename" | "pin" | "archive" => {
                let key = match command.name { "rename" => "name", "pin" => "pinned", _ => "archived" };
                let snapshot = if argument.is_empty() { self.snapshot(sid)? } else {
                    let mut request = json!({"id":sid});
                    request[key] = if command.name == "rename" { json!(argument) } else { json!(argument == "on") };
                    self.metadata(&request)?
                };
                result["message"] = json!(if command.name == "rename" { format!("Conversation renamed to {}", s(&snapshot,"name")) }
                    else { format!("{}: {}", key, if snapshot[key] == true { "on" } else { "off" }) });
                result["session"] = snapshot;
            }
            "new" => {
                result["session"] = self.command_new(sid, command)?;
                result["message"] = json!("Fresh conversation created; previous history is retained.");
            }
            "export" => {
                result["file"] = self.export(sid, if argument.is_empty() { "markdown" } else { argument })?;
                result["message"] = json!("Conversation exported.");
            }
            _ => return err("INVALID_INPUT", "Use the interrupt operation for /stop"),
        }
        Ok(result)
    }

    fn command_new(&mut self, sid: &str, command: &Command) -> Result<Value> {
        let index = self.index(sid)?;
        let source = self.state["sessions"][index].clone();
        if source["commandRequests"].as_array().is_some_and(|r| r.len() >= MAX_NEW_RECEIPTS) {
            return err("STATE_LIMIT", "New-conversation request history is full; run /new from a newer conversation");
        }
        let params = json!({"provider":source["provider"],"machineId":source["machineId"],"settings":source["settings"]});
        let created = self.new_session(&params, s(&source, "cwd"))?;
        let created_id = s(&created, "id").to_owned();
        let session = &mut self.state["sessions"][index];
        if session.get("commandRequests").is_none() { session["commandRequests"] = json!([]); }
        session["commandRequests"].as_array_mut().unwrap().push(json!({"requestId":command.request_id,"textHash":hash(&command.text),"sessionId":created_id}));
        self.state["sessions"].as_array_mut().unwrap().push(created);
        if let Err(error) = self.save() {
            self.state["sessions"].as_array_mut().unwrap().pop();
            self.state["sessions"][index] = source;
            return Err(error);
        }
        self.snapshot(&created_id)
    }
}
