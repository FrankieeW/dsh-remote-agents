use crate::common::*;
use serde_json::{Value, json};
use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};
#[derive(Clone)]
pub struct Host {
    pub machine: Value,
}
pub fn valid_ssh(m: &Value) -> bool {
    let h = s(m, "host");
    let host_ok = !h.is_empty()
        && h.len() <= 253
        && (h.parse::<std::net::Ipv6Addr>().is_ok()
            || (h.as_bytes()[0].is_ascii_alphanumeric()
                && h.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))));
    let user_ok = m.get("user").is_none_or(|v| {
        v.as_str().is_some_and(|u| {
            !u.is_empty()
                && u.len() <= 64
                && (u.as_bytes()[0].is_ascii_alphabetic() || u.starts_with('_'))
                && u.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
    });
    let port_ok = m
        .get("port")
        .is_none_or(|v| v.as_u64().is_some_and(|p| (1..=65535).contains(&p)));
    host_ok && user_ok && port_ok
}
pub fn shell_path(path: &str) -> Result<String> {
    if path == "~" {
        return Ok("\"$HOME\"".into());
    }
    if let Some(rest) = path.strip_prefix("~/") {
        if rest.chars().any(|c| c < ' ') {
            return err("INVALID_INPUT", "Invalid path");
        }
        return Ok(format!("\"$HOME\"/{}", quote(rest)));
    }
    absolute(path)?;
    Ok(quote(path))
}
impl Host {
    pub fn remote(&self) -> bool {
        s(&self.machine, "type") == "ssh"
    }
    pub fn ssh_args(&self, command: &str) -> Result<Vec<String>> {
        if !valid_ssh(&self.machine) {
            return err("INVALID_INPUT", "Invalid SSH target");
        }
        let mut a = [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
        ]
        .map(String::from)
        .to_vec();
        if let Some(u) = self.machine.get("user") {
            a.extend(["-l".into(), u.as_str().unwrap().into()])
        }
        if let Some(p) = self.machine.get("port") {
            a.extend(["-p".into(), p.to_string()])
        }
        a.extend(["--".into(), s(&self.machine, "host").into(), command.into()]);
        Ok(a)
    }
    pub fn command(&self, file: &str, args: &[String], cwd: Option<&str>) -> Result<Command> {
        let mut c = if self.remote() {
            let command = format!(
                "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; cd {} && exec {}",
                shell_path(cwd.unwrap_or("~"))?,
                std::iter::once(file)
                    .chain(args.iter().map(String::as_str))
                    .map(quote)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let mut c = Command::new("ssh");
            c.args(self.ssh_args(&command)?);
            c
        } else {
            let mut c = Command::new(file);
            c.args(args);
            if let Some(d) = cwd {
                c.current_dir(d);
            }
            c
        };
        c.kill_on_drop(true);
        c.process_group(0);
        Ok(c)
    }
    pub fn spawn(&self, file: &str, args: &[String], cwd: &str) -> Result<Child> {
        let mut c = self.command(file, args, Some(cwd))?;
        Ok(c.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| Error::new("SPAWN_FAILED", "Could not start the selected CLI"))?)
    }
    pub async fn run(
        &self,
        file: &str,
        args: &[String],
        cwd: Option<&str>,
        seconds: u64,
        max: usize,
    ) -> Result<String> {
        let mut c = self.command(file, args, cwd)?;
        let mut child = c
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|_| Error::new("SPAWN_FAILED", "Could not execute the selected command"))?;
        let pid = child.id();
        let mut out = child.stdout.take().unwrap().take((max + 1) as u64);
        let mut stderr = child.stderr.take().unwrap().take((max + 1) as u64);
        let output = tokio::time::timeout(Duration::from_secs(seconds), async {
            let mut o = vec![];
            let mut e = vec![];
            let (a, b, status) = tokio::join!(
                out.read_to_end(&mut o),
                stderr.read_to_end(&mut e),
                child.wait()
            );
            a?;
            b?;
            let status = status?;
            if o.len() > max || e.len() > max {
                return err("OUTPUT_LIMIT", "Command output exceeded limit");
            }
            if !status.success() {
                return err(
                    &status.code().unwrap_or(-1).to_string(),
                    "CLI command failed; check its installation, authentication and SSH connection",
                );
            }
            String::from_utf8(o).map_err(|_| Error::new("INVALID_UTF8", "CLI output is not UTF-8"))
        })
        .await;
        if output.is_err() {
            kill_group(pid);
            let _ = child.kill().await;
            return err("TIMEOUT", "CLI operation timed out");
        }
        output.unwrap()
    }
    pub async fn shell(&self, command: &str, max: usize) -> Result<String> {
        if self.remote() {
            let local = Host {
                machine: json!({"type":"local"}),
            };
            local
                .run("ssh", &self.ssh_args(command)?, None, 15, max)
                .await
        } else {
            self.run("sh", &["-c".into(), command.into()], None, 15, max)
                .await
        }
    }
    pub async fn executable(&self, name: &str, configured: Option<&str>) -> Result<Option<String>> {
        if self.remote() {
            let command = format!(
                "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; command -v {} || true",
                quote(name)
            );
            let p = self.shell(&command, 4096).await?;
            let p = p.trim();
            return Ok(if p.starts_with('/') && !p.chars().any(|c| c < ' ') {
                Some(p.into())
            } else {
                None
            });
        }
        let mut candidates = vec![];
        if let Some(p) = configured {
            candidates.push(PathBuf::from(p))
        } else {
            for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
                if dir.is_absolute() {
                    candidates.push(dir.join(name))
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                candidates.push(Path::new(&home).join(".local/bin").join(name))
            }
            for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
                candidates.push(Path::new(d).join(name))
            }
        }
        Ok(candidates
            .into_iter()
            .find(|p| {
                p.is_absolute()
                    && p.metadata()
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            })
            .map(|p| p.to_string_lossy().into()))
    }
    pub async fn directory(&self, path: &str) -> Result<String> {
        let q = shell_path(path)?;
        if self.remote() {
            let p = self.shell(&format!("cd {q} && pwd -P"), 4096).await?;
            absolute(p.trim())?;
            return Ok(p.trim().into());
        }
        let expanded = if path == "~" {
            PathBuf::from(
                std::env::var("HOME")
                    .map_err(|_| Error::new("HOME_MISSING", "Home directory unavailable"))?,
            )
        } else if let Some(p) = path.strip_prefix("~/") {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(p)
        } else {
            PathBuf::from(path)
        };
        let p = expanded.canonicalize()?;
        if !p.is_dir() {
            return err("INVALID_INPUT", "Path is not a directory");
        }
        Ok(p.to_string_lossy().into())
    }
    pub async fn browse(&self, path: &str) -> Result<Value> {
        shell_path(path)?;
        let (base, prefix) = if path.ends_with('/') || path == "~" {
            (path.to_owned(), String::new())
        } else {
            let p = Path::new(path);
            (
                p.parent()
                    .unwrap_or(Path::new("/"))
                    .to_string_lossy()
                    .into(),
                p.file_name().unwrap_or_default().to_string_lossy().into(),
            )
        };
        let base = self.directory(&base).await?;
        let mut names = vec![];
        let mut truncated = false;
        if self.remote() {
            let command = format!(
                "cd {} || exit; n=0; for p in ./* ./.[!.]* ./..?*; do [ -d \"$p\" ] || continue; name=${{p#./}}; case \"$name\" in {}*) ;; *) continue ;; esac; n=$((n+1)); [ \"$n\" -le 200 ] || break; printf '%s\\0' \"$name\"; done; [ \"$n\" -le 200 ] || printf '__TRUNCATED__\\0'",
                quote(&base),
                quote(&prefix)
            );
            for n in self.shell(&command, 1024 * 1024).await?.split('\0') {
                if n == "__TRUNCATED__" {
                    truncated = true
                } else if !n.is_empty() {
                    names.push(n.to_owned())
                }
            }
        } else {
            for e in std::fs::read_dir(&base)? {
                let e = e?;
                if e.path().is_dir() {
                    names.push(e.file_name().to_string_lossy().into_owned())
                }
            }
        }
        names.retain(|n| {
            !n.chars().any(|c| c < ' ' || c == '\u{7f}')
                && n.to_lowercase().starts_with(&prefix.to_lowercase())
        });
        names.sort();
        truncated |= names.len() > 100;
        Ok(
            json!({"base":base,"entries":names.into_iter().take(100).map(|name|json!({"path":format!("{}/{}/",base.trim_end_matches('/'),name),"name":name})).collect::<Vec<_>>(),"truncated":truncated}),
        )
    }
}
pub fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
}
