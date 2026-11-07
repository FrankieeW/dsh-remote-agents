//! Concrete `Host` aliases from the user's OpenSSH client configuration.
//! Only alias names and the HostName/User/Port declared for them are read.
//! ssh itself is never run, so `Match exec` commands are not triggered.
use crate::{common::*, hosts::valid_ssh, machines::machine_key};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 32;
const MAX_DEPTH: usize = 8;
const MAX_BYTES: u64 = 1024 * 1024;
const MAX_HOSTS: usize = 500;

#[derive(Default)]
struct Scan {
    hosts: Vec<Value>,
    warnings: Vec<String>,
    files: usize,
}

/// `{hosts:[{alias,hostName?,user?,port?}],warnings}` from `~/.ssh/config`.
pub fn hosts(home: &Path) -> Value {
    let mut scan = Scan::default();
    let config = home.join(".ssh").join("config");
    if config.exists() {
        scan.file(&config, home, &mut vec![], 0);
    }
    json!({"hosts":scan.hosts,"warnings":scan.warnings})
}

/// Names the saved machine (active first, else removed) that uses each alias
/// as its whole destination.
pub fn with_machines(list: Value, machines: &[Value]) -> Value {
    let mut list = list;
    for host in list["hosts"].as_array_mut().into_iter().flatten() {
        let key = machine_key(&json!({"host": host["alias"]}));
        let same = |m: &&Value| s(m, "type") == "ssh" && machine_key(m) == key;
        let found = machines
            .iter()
            .filter(same)
            .find(|m| m.get("removedAt").is_none())
            .or_else(|| machines.iter().find(same));
        if let Some(m) = found {
            host["machineId"] = m["id"].clone();
            if m.get("removedAt").is_some() {
                host["removed"] = json!(true)
            }
        }
    }
    list
}

/// Splits arguments like OpenSSH: whitespace-separated, double quotes group,
/// and an unquoted token starting with `#` begins a comment.
fn tokens(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut token = String::new();
    let (mut quoted, mut started) = (false, false);
    for c in text.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                started = true
            }
            '#' if !quoted && !started => break,
            c if c.is_whitespace() && !quoted => {
                if started {
                    out.push(std::mem::take(&mut token));
                    started = false
                }
            }
            c => {
                token.push(c);
                started = true
            }
        }
    }
    if started {
        out.push(token)
    }
    out
}
/// `Keyword args` or `Keyword=args`; keywords are case-insensitive.
fn directive(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (keyword, rest) = line.split_at(end);
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest);
    Some((keyword.to_ascii_lowercase(), tokens(rest)))
}
fn clean(t: &str, max: usize) -> String {
    clip(&t.chars().filter(|c| !c.is_control()).collect::<String>(), max)
}
/// HostName may use `%h` (the alias) and `%%`.
fn expand_host_name(value: &str, alias: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('%', Some('h')) => {
                chars.next();
                out.push_str(alias)
            }
            ('%', Some('%')) => {
                chars.next();
                out.push('%')
            }
            _ => out.push(c),
        }
    }
    out
}
/// `*` and `?` globbing; like glob(3), a leading `.` must be matched explicitly.
fn glob_match(pattern: &[char], name: &[char]) -> bool {
    match (pattern.first(), name.first()) {
        (None, None) => true,
        (Some('*'), _) => glob_match(&pattern[1..], name) || !name.is_empty() && glob_match(pattern, &name[1..]),
        (Some('?'), Some(_)) => glob_match(&pattern[1..], &name[1..]),
        (Some(p), Some(n)) if p == n => glob_match(&pattern[1..], &name[1..]),
        _ => false,
    }
}
fn has_glob(t: &str) -> bool {
    t.contains(['*', '?', '['])
}
impl Scan {
    fn warn(&mut self, message: String) {
        if self.warnings.len() < 20 {
            self.warnings.push(message)
        }
    }
    /// Include targets, relative to `~/.ssh`; wildcards only in the file name.
    fn include(&mut self, pattern: &str, home: &Path) -> Vec<PathBuf> {
        let path = if let Some(rest) = pattern.strip_prefix("~/") {
            home.join(rest)
        } else if pattern.starts_with('/') {
            PathBuf::from(pattern)
        } else if pattern.starts_with('~') {
            self.warn(format!("Skipped Include {pattern}: only ~/ paths are supported"));
            return vec![];
        } else {
            home.join(".ssh").join(pattern)
        };
        let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
            return vec![];
        };
        if has_glob(&dir.to_string_lossy()) || name.contains('[') {
            self.warn(format!("Skipped Include {pattern}: wildcards are supported only as * and ? in the file name"));
            return vec![];
        }
        if !has_glob(name) {
            return if path.is_file() { vec![path] } else { vec![] };
        }
        let pattern = name.chars().collect::<Vec<_>>();
        let mut found = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let file = entry.file_name().to_string_lossy().into_owned();
                let visible = !file.starts_with('.') || pattern.first() == Some(&'.');
                (visible && glob_match(&pattern, &file.chars().collect::<Vec<_>>()) && entry.path().is_file())
                    .then(|| entry.path())
            })
            .collect::<Vec<_>>();
        found.sort();
        found
    }
    /// Indices of the concrete aliases of one `Host` line.
    fn block(&mut self, patterns: &[String]) -> Vec<usize> {
        let mut block = vec![];
        for p in patterns {
            if p.contains(['*', '?', '!']) || !valid_ssh(&json!({"host": p})) {
                continue;
            }
            let index = match self.hosts.iter().position(|h| h["alias"] == p.as_str()) {
                Some(i) => i,
                None if self.hosts.len() >= MAX_HOSTS => {
                    self.warn(format!("Listed only the first {MAX_HOSTS} hosts"));
                    continue;
                }
                None => {
                    self.hosts.push(json!({"alias": p}));
                    self.hosts.len() - 1
                }
            };
            block.push(index)
        }
        block
    }
    /// OpenSSH uses the first value obtained for each option.
    fn set(&mut self, block: &[usize], keyword: &str, value: &str) {
        for &i in block {
            let host = &mut self.hosts[i];
            let alias = s(host, "alias").to_owned();
            match keyword {
                "hostname" if host.get("hostName").is_none() => {
                    host["hostName"] = json!(clean(&expand_host_name(value, &alias), 253))
                }
                "user" if host.get("user").is_none() => host["user"] = json!(clean(value, 64)),
                "port" if host.get("port").is_none() => {
                    if let Some(port) = value.parse::<u16>().ok().filter(|p| *p > 0) {
                        host["port"] = json!(port)
                    }
                }
                _ => {}
            }
        }
    }
    fn file(&mut self, path: &Path, home: &Path, block: &mut Vec<usize>, depth: usize) {
        if self.files >= MAX_FILES {
            self.warn(format!("Skipped {}: too many included files", path.display()));
            return;
        }
        self.files += 1;
        let text = match std::fs::metadata(path) {
            Ok(meta) if meta.is_file() && meta.len() <= MAX_BYTES => std::fs::read(path),
            Ok(_) => {
                self.warn(format!("Skipped {}: not a regular file of at most 1 MiB", path.display()));
                return;
            }
            Err(e) => Err(e),
        };
        let text = match text {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) => {
                self.warn(format!("Could not read {}: {e}", path.display()));
                return;
            }
        };
        for line in text.lines() {
            let Some((keyword, args)) = directive(line) else { continue };
            match keyword.as_str() {
                "host" => *block = self.block(&args),
                "match" => block.clear(),
                "include" if depth + 1 >= MAX_DEPTH => {
                    self.warn(format!("Skipped Include in {}: nested too deeply", path.display()))
                }
                "include" => {
                    for pattern in &args {
                        for included in self.include(pattern, home) {
                            // Like OpenSSH, the enclosing block resumes after the included file.
                            let mut inner = block.clone();
                            self.file(&included, home, &mut inner, depth + 1);
                        }
                    }
                }
                "hostname" | "user" | "port" => {
                    if let Some(value) = args.first() {
                        self.set(block, &keyword, value)
                    }
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn home(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        dir
    }
    fn aliases(v: &Value) -> Vec<String> {
        v["hosts"].as_array().unwrap().iter().map(|h| h["alias"].as_str().unwrap().to_owned()).collect()
    }
    fn host<'a>(v: &'a Value, alias: &str) -> &'a Value {
        v["hosts"].as_array().unwrap().iter().find(|h| h["alias"] == alias).unwrap()
    }
    #[test]
    fn concrete_aliases_keep_their_first_declared_details() {
        let dir = home(&[(
            ".ssh/config",
            "# comment\nHost dev dev2 *.corp !old\n  HostName 10.0.0.5\n  User alice\n  Port 2222\nHost=build\n    HostName = %h.example.com # trailing\nMatch host dev exec \"echo x\"\n  User mallory\nHost \"quoted box\" good_box\n  User bob\nHost dev\n  User ignored\n  Port 0\n",
        )]);
        let v = hosts(dir.path());
        assert_eq!(aliases(&v), ["dev", "dev2", "build", "good_box"]);
        let dev = host(&v, "dev");
        assert_eq!((dev["hostName"].clone(), dev["user"].clone(), dev["port"].clone()), (json!("10.0.0.5"), json!("alice"), json!(2222)));
        assert_eq!(host(&v, "build")["hostName"], "build.example.com");
        assert_eq!(host(&v, "good_box")["user"], "bob");
        assert!(host(&v, "dev2").get("hostName").is_some(), "patterns of one Host line share the block");
    }
    #[test]
    fn includes_follow_openssh_rules() {
        let dir = home(&[
            (".ssh/config", "Include config.d/*\nInclude ~/.ssh/extra.conf\nInclude /nonexistent/*\nHost outer\n  Include inner.conf\n  User carol\nHost after\n"),
            (".ssh/config.d/a.conf", "Host alpha\n  HostName a.example\n"),
            (".ssh/config.d/.hidden", "Host hidden\n"),
            (".ssh/config.d/loop.conf", "Include config.d/loop.conf\n"),
            (".ssh/extra.conf", "Host beta\n"),
            (".ssh/inner.conf", "Host inner\n  User dave\n"),
        ]);
        let v = hosts(dir.path());
        assert_eq!(aliases(&v), ["alpha", "beta", "outer", "inner", "after"]);
        assert_eq!(host(&v, "outer")["user"], "carol", "the enclosing block resumes after an Include");
        assert_eq!(host(&v, "inner")["user"], "dave");
        assert!(v["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("nested")));
    }
    #[test]
    fn known_aliases_name_their_machine() {
        let list = json!({"hosts":[{"alias":"dev"},{"alias":"old"},{"alias":"new"}],"warnings":[]});
        let machines = [
            json!({"id":"local","type":"local"}),
            json!({"id":"m1","type":"ssh","host":"DEV"}),
            json!({"id":"m2","type":"ssh","host":"old","removedAt":"2026-01-01T00:00:00Z"}),
            json!({"id":"m3","type":"ssh","host":"new","user":"someone"}),
        ];
        let v = with_machines(list, &machines);
        assert_eq!(v["hosts"][0]["machineId"], "m1");
        assert_eq!((v["hosts"][1]["machineId"].clone(), v["hosts"][1]["removed"].clone()), (json!("m2"), json!(true)));
        assert!(v["hosts"][2].get("machineId").is_none(), "a different user is a different destination");
    }
    #[test]
    fn a_missing_configuration_has_no_hosts() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(hosts(dir.path()), json!({"hosts":[],"warnings":[]}));
    }
}
