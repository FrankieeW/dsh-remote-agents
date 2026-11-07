//! Machine identity, SSH destination parsing and connection diagnostics.
use crate::{
    common::*,
    hosts::{Captured, Host, valid_ssh},
};
use serde_json::{Value, json};

const DESTINATION_HELP: &str = "Use an SSH alias, user@host, host:port or ssh://user@host:port. Passwords and SSH options are not accepted.";

/// Parses an SSH destination. The strict form (Herdr catalogs) accepts `host`,
/// `user@host` and `ssh://user@host:port`; the lenient form (typed by a user)
/// also accepts `host:port`, `user@host:port` and `[v6]:port`.
pub fn parse_target(t: &str, lenient: bool) -> Option<Value> {
    if t.is_empty() || t.len() > 512 || t.chars().any(|c| c.is_whitespace() || c == '%') {
        return None;
    }
    let uri = t.starts_with("ssh://");
    let mut raw = t.strip_prefix("ssh://").unwrap_or(t);
    if uri {
        raw = raw.strip_suffix('/').unwrap_or(raw)
    }
    let parts = raw.split('@').collect::<Vec<_>>();
    if parts.len() > 2 {
        return None;
    }
    let mut v = json!({});
    let host = if parts.len() == 2 {
        v["user"] = json!(parts[0]);
        parts[1]
    } else {
        parts[0]
    };
    let ports = uri || lenient;
    if host.starts_with('[') {
        let end = host.find(']')?;
        v["host"] = json!(&host[1..end]);
        let rest = &host[end + 1..];
        if !rest.is_empty() {
            if !ports {
                return None;
            }
            v["port"] = json!(rest.strip_prefix(':')?.parse::<u16>().ok()?);
        }
    } else if ports && (host.matches(':').count() == 1 || uri && host.contains(':')) {
        let (h, p) = host.rsplit_once(':')?;
        v["host"] = json!(h);
        v["port"] = json!(p.parse::<u16>().ok()?);
    } else {
        v["host"] = json!(host)
    }
    valid_ssh(&v).then_some(v)
}

/// Duplicate-detection identity. OpenSSH matches host names case-insensitively
/// and IPv6 literals have several spellings.
pub fn machine_key(m: &Value) -> String {
    let host = s(m, "host");
    let host = host
        .parse::<std::net::Ipv6Addr>()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| host.to_ascii_lowercase());
    json!([host, m["user"], m["port"]]).to_string()
}

/// Whether two records reach the same SSH endpoint.
pub fn same_connection(a: &Value, b: &Value) -> bool {
    machine_key(a) == machine_key(b)
}

/// `user@host:port`, bracketing IPv6 hosts when a port follows.
pub fn address(m: &Value) -> String {
    let host = s(m, "host");
    let port = m.get("port").map(|p| format!(":{p}")).unwrap_or_default();
    let host = if !port.is_empty() && host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let user = m
        .get("user")
        .and_then(Value::as_str)
        .map(|u| format!("{u}@"))
        .unwrap_or_default();
    format!("{user}{host}{port}")
}

/// The terminal command that verifies this machine's host key.
pub fn ssh_command(m: &Value) -> String {
    let port = m.get("port").map(|p| format!(" -p {p}")).unwrap_or_default();
    let user = m
        .get("user")
        .and_then(Value::as_str)
        .map(|u| format!("{u}@"))
        .unwrap_or_default();
    format!("ssh{port} {user}{}", s(m, "host"))
}

/// Connection fields from `target` or from explicit `host`/`user`/`port`.
pub fn connection(p: &Value) -> Result<Value> {
    let invalid = || Error::new("INVALID_INPUT", DESTINATION_HELP);
    if let Some(target) = p.get("target") {
        if ["host", "user", "port"].iter().any(|k| p.get(*k).is_some()) {
            return err("INVALID_INPUT", "Use either target or host/user/port");
        }
        return parse_target(target.as_str().ok_or_else(invalid)?.trim(), true)
            .ok_or_else(invalid);
    }
    let mut v = json!({"host": p["host"]});
    for k in ["user", "port"] {
        if let Some(value) = p.get(k) {
            v[k] = value.clone()
        }
    }
    valid_ssh(&v).then_some(v).ok_or_else(invalid)
}

pub fn has_connection(p: &Value) -> bool {
    ["target", "host", "user", "port"]
        .iter()
        .any(|k| p.get(*k).is_some())
}

/// A trimmed display name of at most 128 characters.
pub fn name(v: &Value) -> Result<String> {
    let name = text(v, 128, false)?;
    let name = name.trim();
    if name.is_empty() {
        return err("INVALID_INPUT", "Machine name is empty");
    }
    Ok(name.into())
}

/// The requested name, or the address when none was given.
pub fn display_name(p: &Value, connection: &Value) -> Result<String> {
    match p.get("name") {
        None | Some(Value::Null) => Ok(clip(&address(connection), 128)),
        Some(v) => name(v),
    }
}

/// An optional boolean request flag.
pub fn flag(p: &Value, key: &str) -> Result<bool> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => err("INVALID_INPUT", format!("{key} must be a boolean")),
    }
}

/// The machine id of a request; absent means the local machine.
pub fn machine_param(p: &Value) -> Result<String> {
    match p.get("machineId") {
        None => Ok("local".into()),
        Some(Value::String(id)) if !id.is_empty() && id.len() <= 128 => Ok(id.clone()),
        Some(_) => err("INVALID_INPUT", "machineId must be a machine id string"),
    }
}

/// A host for a destination that is not saved yet.
pub fn candidate(connection: &Value) -> Host {
    let mut machine = connection.clone();
    machine["id"] = json!("");
    machine["type"] = json!("ssh");
    Host { machine }
}

/// The last non-empty line without control characters.
pub fn last_line(t: &str) -> String {
    let line = t
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .last()
        .unwrap_or("");
    clip(&line.chars().filter(|c| !c.is_control()).collect::<String>(), 240)
}

/// Classifies an OpenSSH client failure (exit 255). Only the local client's
/// own diagnostics are interpreted; remote program output is never surfaced.
pub fn ssh_failure(m: &Value, stderr: &str) -> (&'static str, String) {
    let lower = stderr.to_ascii_lowercase();
    let host = s(m, "host");
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if has(&["remote host identification has changed"]) {
        let entry = match m.get("port") {
            Some(port) => format!("'[{host}]:{port}'"),
            None => host.to_owned(),
        };
        (
            "HOST_KEY_CHANGED",
            format!(
                "The host key of {host} changed. If that is expected, run `ssh-keygen -R {entry}`, then verify the new key with `{}` in a terminal.",
                ssh_command(m)
            ),
        )
    } else if has(&["host key verification failed", "host key is known"]) {
        (
            "HOST_KEY",
            format!(
                "The host key of {host} is not trusted yet. Run `{}` once in a terminal to verify it, then test again.",
                ssh_command(m)
            ),
        )
    } else if has(&["permission denied", "too many authentication failures"]) {
        (
            "AUTH",
            "SSH authentication failed. Load your key into ssh-agent or set IdentityFile in ~/.ssh/config; passwords and interactive prompts are not supported.".into(),
        )
    } else if has(&[
        "could not resolve hostname",
        "name or service not known",
        "nodename nor servname",
        "name resolution",
    ]) {
        (
            "DNS",
            format!("{host} could not be resolved. Check the host name or its Host alias in ~/.ssh/config."),
        )
    } else if has(&["connection refused"]) {
        (
            "REFUSED",
            format!("{host} refused the SSH connection. Check that sshd is running and the port is correct."),
        )
    } else if has(&["timed out"]) {
        (
            "TIMEOUT",
            format!("Connecting to {host} timed out. Check the network, VPN or firewall."),
        )
    } else if has(&["no route to host", "network is unreachable", "host is down"]) {
        ("UNREACHABLE", format!("{host} is unreachable. Check the network or VPN."))
    } else if has(&["bad configuration option", "ssh_config", ".ssh/config"]) {
        (
            "SSH_CONFIG",
            format!("Your SSH configuration has an error: {}", last_line(stderr)),
        )
    } else {
        let line = last_line(stderr);
        (
            "SSH_FAILED",
            if line.is_empty() {
                "SSH failed without an error message.".into()
            } else {
                format!("SSH failed: {line}")
            },
        )
    }
}

fn exit_label(code: Option<i32>) -> String {
    code.map_or("signal".into(), |c| c.to_string())
}

fn failed(code: &str, message: impl Into<String>) -> Value {
    json!({"ok":false,"code":code,"message":message.into()})
}

/// Whether the machine accepts a non-interactive SSH command.
pub async fn check_ssh(host: &Host) -> Value {
    if !host.remote() {
        return json!({"ok":true,"message":"Local machine"});
    }
    match host.capture("true", &[], None, 15, 4096, None).await {
        Ok(Captured { code: Some(0), .. }) => json!({"ok":true}),
        Ok(c) if c.code == Some(255) => {
            let (code, message) = ssh_failure(&host.machine, &c.stderr);
            failed(code, message)
        }
        Ok(c) => failed(
            "SHELL",
            format!(
                "The remote login shell failed (exit {}). Check its startup files.",
                exit_label(c.code)
            ),
        ),
        Err(e) if e.code == "TIMEOUT" => failed(
            "TIMEOUT",
            format!(
                "Connecting to {} timed out after 15 seconds. Check the network, VPN or firewall.",
                s(&host.machine, "host")
            ),
        ),
        Err(e) => failed(&e.code, e.message),
    }
}

/// Whether tmux, needed only for legacy terminals, is installed.
pub async fn check_tmux(host: &Host) -> Value {
    let missing = || {
        failed(
            "NOT_FOUND",
            "tmux is not installed or not on PATH. It is needed only for legacy terminals.",
        )
    };
    match host.capture("tmux", &["-V".into()], None, 10, 4096, None).await {
        Ok(Captured { code: Some(0), stdout, .. }) => {
            json!({"ok":true,"version":clip(String::from_utf8_lossy(&stdout).trim(), 64)})
        }
        Ok(c) if c.code == Some(127) => missing(),
        Ok(c) if host.remote() && c.code == Some(255) => {
            let (code, message) = ssh_failure(&host.machine, &c.stderr);
            failed(code, message)
        }
        Ok(c) => failed("FAILED", format!("tmux -V failed (exit {}).", exit_label(c.code))),
        Err(e) if e.code == "SPAWN_FAILED" && !host.remote() => missing(),
        Err(e) => failed(&e.code, e.message),
    }
}

/// The public probe result. `ok` means the machine is reachable.
pub fn probe_result(machine_id: &str, ssh: Value, tmux: Value, clis: Value) -> Value {
    let ok = ssh["ok"] == true;
    let mut v = json!({"machineId":machine_id,"ok":ok,"checkedAt":now(),"ssh":ssh,"tmux":tmux,"clis":clis});
    if let Some(version) = v["tmux"]["version"].as_str() {
        v["version"] = json!(version)
    }
    if !ok {
        v["error"] = v["ssh"]["message"].clone()
    }
    v
}

/// The persisted summary of a probe.
pub fn last_check(result: &Value) -> Value {
    let message = if result["ok"] == true {
        "Connected".to_owned()
    } else {
        s(&result["ssh"], "message").to_owned()
    };
    let mut check = json!({"checkedAt":result["checkedAt"],"ok":result["ok"],"message":message,"ssh":result["ssh"],"tmux":result["tmux"],"clis":result["clis"]});
    if let Some(code) = result["ssh"]["code"].as_str() {
        check["code"] = json!(code)
    }
    check
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn destinations() {
        let parse = |t, lenient| parse_target(t, lenient).map(|v| address(&v));
        assert_eq!(parse("alice@dev", false).as_deref(), Some("alice@dev"));
        assert_eq!(parse("ssh://u@[::1]:2222", false).as_deref(), Some("u@[::1]:2222"));
        assert_eq!(parse("ssh://u@host:22/", false).as_deref(), Some("u@host:22"));
        assert_eq!(parse("host:2200", false), None);
        assert_eq!(parse("host:2200", true).as_deref(), Some("host:2200"));
        assert_eq!(parse("u@[fe80::1]:22", true).as_deref(), Some("u@[fe80::1]:22"));
        assert_eq!(parse("::1", true).as_deref(), Some("::1"));
        for bad in [
            "-oProxyCommand=x",
            "a;b",
            "ssh://u:p@host",
            "host/path",
            "a b",
            "u@h@x",
            "host:0",
            "host:99999",
            "",
        ] {
            assert_eq!(parse_target(bad, true), None, "{bad}");
        }
    }
    #[test]
    fn keys_ignore_host_case_and_ipv6_spelling() {
        let key = |t| machine_key(&parse_target(t, true).unwrap());
        assert_eq!(key("Dev-Box"), key("dev-box"));
        assert_eq!(key("[0:0:0:0:0:0:0:1]:22"), key("[::1]:22"));
        assert_ne!(key("Alice@dev"), key("alice@dev"));
        assert_ne!(key("dev"), key("dev:22"));
    }
    #[test]
    fn ssh_failures_are_actionable() {
        let m = json!({"host":"box","user":"u","port":2222});
        assert_eq!(ssh_command(&m), "ssh -p 2222 u@box");
        let code = |stderr| ssh_failure(&m, stderr).0;
        assert_eq!(code("No ED25519 host key is known for box\nHost key verification failed."), "HOST_KEY");
        assert_eq!(code("@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\nHost key verification failed."), "HOST_KEY_CHANGED");
        assert_eq!(code("u@box: Permission denied (publickey)."), "AUTH");
        assert_eq!(code("ssh: Could not resolve hostname box: Name or service not known"), "DNS");
        assert_eq!(code("ssh: connect to host box port 2222: Connection refused"), "REFUSED");
        assert_eq!(code("ssh: connect to host box port 2222: Operation timed out"), "TIMEOUT");
        assert_eq!(code("ssh: connect to host box port 2222: No route to host"), "UNREACHABLE");
        assert_eq!(code("/Users/u/.ssh/config: line 3: Bad configuration option: x"), "SSH_CONFIG");
        let (code, message) = ssh_failure(&m, "kex_exchange_identification: \x1b[31mConnection closed\r\n");
        assert_eq!(code, "SSH_FAILED");
        assert_eq!(message, "SSH failed: kex_exchange_identification: [31mConnection closed");
        assert!(ssh_failure(&m, "Host key verification failed.").1.contains("`ssh -p 2222 u@box`"));
    }
    #[test]
    fn request_fields() {
        assert_eq!(machine_param(&json!({})).unwrap(), "local");
        assert!(machine_param(&json!({"machineId":null})).is_err());
        assert!(connection(&json!({"target":"a","host":"b"})).is_err());
        assert_eq!(connection(&json!({"host":"dev","port":22})).unwrap()["port"], 22);
        assert_eq!(display_name(&json!({}), &json!({"host":"h","user":"u"})).unwrap(), "u@h");
        assert!(name(&json!("   ")).is_err());
        assert!(flag(&json!({"verify":"yes"}), "verify").is_err());
    }
}
