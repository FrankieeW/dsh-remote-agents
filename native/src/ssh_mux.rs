//! Opt-in OpenSSH connection reuse (ControlMaster) for the backend's own SSH
//! commands. Sockets live in a private directory; anything unexpected about
//! that directory disables reuse instead of weakening it.
use crate::{common::*, machines::machine_key};
use serde_json::Value;
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::OnceLock,
};

/// sun_path holds 104 bytes on macOS (108 on Linux) including the NUL, and
/// OpenSSH appends a 17-character temporary suffix while creating a socket.
const MAX_SOCKET_PATH: usize = 86;
const NAME_LEN: usize = 16;
/// How long an idle shared connection stays open.
const PERSIST_SECONDS: u32 = 60;

static STATE_DIR: OnceLock<PathBuf> = OnceLock::new();
static CONTROL_DIR: OnceLock<Option<String>> = OnceLock::new();

/// Turns reuse on for this process. The directory is created on first use, so
/// read-only callers never write anything.
pub fn enable(state_dir: &Path) {
    let _ = STATE_DIR.set(state_dir.to_owned());
}
fn control_dir() -> Option<&'static str> {
    let state = STATE_DIR.get()?;
    CONTROL_DIR
        .get_or_init(|| {
            let uid = unsafe { libc::getuid() };
            [state.join("ssh"), PathBuf::from(format!("/tmp/dsh-remote-agents-{uid}"))]
                .iter()
                .find_map(|dir| usable(dir, uid))
        })
        .as_deref()
}
/// A short, safe, private directory owned by `uid`, created if missing.
fn usable(dir: &Path, uid: u32) -> Option<String> {
    let text = dir.to_str()?;
    if !text.starts_with('/')
        || text.len() + 1 + NAME_LEN > MAX_SOCKET_PATH
        || !text.bytes().all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
    {
        return None;
    }
    match std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return None,
    }
    let meta = std::fs::symlink_metadata(dir).ok()?;
    (meta.is_dir() && meta.uid() == uid && meta.permissions().mode() & 0o077 == 0).then(|| text.to_owned())
}
/// One socket per destination (host case-insensitive, user, port).
fn socket(dir: &str, machine: &Value) -> String {
    format!("{dir}/{}", &hash(machine_key(machine))[..NAME_LEN])
}
/// `-o` options that let this command share a connection to the same destination.
pub fn options(machine: &Value) -> Vec<String> {
    let Some(dir) = control_dir() else {
        return vec![];
    };
    [
        "ControlMaster=auto".to_owned(),
        format!("ControlPath={}", socket(dir, machine)),
        format!("ControlPersist={PERSIST_SECONDS}"),
    ]
    .into_iter()
    .flat_map(|option| ["-o".to_owned(), option])
    .collect()
}
/// After a timeout the shared connection may be dead (for example after a
/// network change). `-O stop` makes the next command open a fresh connection
/// while sessions still using the old one continue undisturbed.
pub fn stop_args(machine: &Value) -> Option<Vec<String>> {
    let dir = control_dir()?;
    let mut args = vec!["-o".into(), format!("ControlPath={}", socket(dir, machine)), "-O".into(), "stop".into()];
    if let Some(user) = machine.get("user").and_then(Value::as_str) {
        args.extend(["-l".into(), user.into()])
    }
    if let Some(port) = machine.get("port") {
        args.extend(["-p".into(), port.to_string()])
    }
    args.extend(["--".into(), s(machine, "host").into()]);
    Some(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_short_private_directories_are_used() {
        let uid = unsafe { libc::getuid() };
        let base = tempfile::tempdir_in("/tmp").unwrap();
        let fresh = base.path().join("ssh");
        assert_eq!(usable(&fresh, uid).as_deref(), fresh.to_str());
        assert_eq!(std::fs::metadata(&fresh).unwrap().permissions().mode() & 0o777, 0o700);
        let open = base.path().join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(usable(&open, uid), None, "group/other access is refused");
        let link = base.path().join("link");
        std::os::unix::fs::symlink(&fresh, &link).unwrap();
        assert_eq!(usable(&link, uid), None, "symlinks are refused");
        assert_eq!(usable(&base.path().join("has space"), uid), None);
        assert_eq!(usable(&base.path().join("x".repeat(80)), uid), None, "socket paths must fit sun_path");
        assert_eq!(usable(&fresh, uid + 1), None, "another owner is refused");
    }
    #[test]
    fn sockets_are_per_destination_and_fixed_length() {
        let a = socket("/d", &json!({"host":"Dev"}));
        assert_eq!(a, socket("/d", &json!({"host":"dev"})));
        assert_ne!(a, socket("/d", &json!({"host":"dev","user":"u"})));
        assert_eq!(a.len(), "/d/".len() + NAME_LEN);
    }
}
