use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn json(&self) -> Value {
        json!({"code":self.code,"message":self.message,"details":{}})
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::new("IO_ERROR", e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", "Invalid JSON data")
    }
}
pub fn err<T>(code: &str, message: impl Into<String>) -> Result<T> {
    Err(Error::new(code, message))
}
pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
pub fn text(value: &Value, max: usize, multiline: bool) -> Result<String> {
    let t = value
        .as_str()
        .ok_or_else(|| Error::new("INVALID_INPUT", "Expected text"))?;
    if t.is_empty()
        || t.chars().count() > max
        || t.chars()
            .any(|c| c == '\u{7f}' || (c < ' ' && (!multiline || !['\n', '\r', '\t'].contains(&c))))
    {
        return err("INVALID_INPUT", "Invalid text");
    }
    Ok(t.into())
}
pub fn required(v: &Value, k: &str, max: usize) -> Result<String> {
    text(&v[k], max, false)
}
pub fn safe_id(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && t.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
pub fn clip(t: &str, max: usize) -> String {
    t.chars().take(max).collect()
}
pub fn quote(t: &str) -> String {
    format!("'{}'", t.replace('\'', "'\\''"))
}
pub fn absolute(t: &str) -> Result<PathBuf> {
    if !t.starts_with('/') || t.chars().any(|c| c < ' ' || c == '\u{7f}') || t.len() > 4096 {
        return err("INVALID_INPUT", "Expected an absolute directory");
    }
    Ok(PathBuf::from(t))
}
pub fn read_bounded(path: &Path, max: u64) -> Result<Vec<u8>> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = f.metadata()?;
    if !meta.is_file() || meta.len() > max {
        return err(
            "STATE_LIMIT",
            "File is not regular or exceeds its size limit",
        );
    }
    let mut out = Vec::new();
    f.take(max + 1).read_to_end(&mut out)?;
    if out.len() as u64 > max {
        return err("STATE_LIMIT", "File exceeds its size limit");
    }
    Ok(out)
}
pub fn read_json(path: &Path, max: u64) -> Result<Value> {
    Ok(serde_json::from_slice(&read_bounded(path, max)?)?)
}
pub fn atomic_json(path: &Path, value: &Value, max: usize) -> Result<()> {
    let data = serde_json::to_vec(value)?;
    if data.len() > max {
        return err(
            "STATE_LIMIT",
            "Storage limit reached; export or archive older conversations",
        );
    }
    atomic_write(path, &data)
}
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new("INVALID_PATH", "Missing parent directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", id()));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        f.write_all(data)?;
        f.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub fn load_or(path: &Path, default: Value, max: u64) -> Result<Value> {
    if !path.exists() {
        return Ok(default);
    }
    read_json(path, max)
}
pub fn usize_param(p: &Value, key: &str, default: usize, max: usize) -> Result<usize> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= max as u64)
            .map(|n| n as usize)
            .ok_or_else(|| Error::new("INVALID_INPUT", format!("Invalid {key}"))),
    }
}
