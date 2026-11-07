//! Durable, host-owned tool records. UI bounds apply only to read projections.
use crate::common::*;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

pub struct ToolHistory {
    root: PathBuf,
    indexes: HashMap<String, Vec<Value>>,
}

fn directory(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.into()),
    }
    if !fs::symlink_metadata(path)?.is_dir() {
        return err(
            "INVALID_PATH",
            "Tool history directory is not a real directory",
        );
    }
    Ok(())
}
fn open_read(path: &Path) -> Result<std::fs::File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return err("INVALID_PATH", "Tool history is not a regular file");
    }
    Ok(file)
}
fn part(path: &Path, offset: u64, limit: usize) -> Result<Value> {
    let mut file = open_read(path)?;
    let size = file.metadata()?.len();
    if offset > size {
        return err("INVALID_INPUT", "Offset exceeds tool data");
    }
    file.seek(SeekFrom::Start(offset))?;
    let mut data = vec![0; limit.min((size - offset) as usize)];
    file.read_exact(&mut data)?;
    let end = match std::str::from_utf8(&data) {
        Ok(_) => data.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => return err("INVALID_INPUT", "Offset must be a UTF-8 boundary"),
    };
    let text = std::str::from_utf8(&data[..end])
        .map_err(|_| Error::new("INVALID_STATE", "Invalid UTF-8 tool record"))?;
    Ok(
        json!({"text":text,"offset":offset,"nextOffset":offset+end as u64,"size":size,"hasMore":offset+(end as u64)<size}),
    )
}
fn contains(path: &Path, query: &[u8]) -> Result<bool> {
    let mut file = open_read(path)?;
    let mut tail = Vec::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            return Ok(false);
        }
        tail.extend(buffer[..n].iter().map(u8::to_ascii_lowercase));
        if tail.windows(query.len()).any(|w| w == query) {
            return Ok(true);
        }
        let keep = query.len().saturating_sub(1).min(tail.len());
        tail.drain(..tail.len() - keep);
    }
}
impl ToolHistory {
    pub fn forget(&mut self, sid: &str, mid: &str) {
        self.indexes.remove(&format!("{sid}/{mid}"));
    }
    pub fn reader(&self) -> Self {
        Self::new(self.root.clone())
    }
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            indexes: HashMap::new(),
        }
    }
    fn turn(&self, sid: &str, mid: &str) -> Result<PathBuf> {
        if !safe_id(sid) || !safe_id(mid) {
            return err("INVALID_INPUT", "Invalid tool history identity");
        }
        // Every path component below the state directory is checked, including ancestors.
        directory(&self.root)?;
        let session = self.root.join(sid);
        directory(&session)?;
        let turn = session.join(mid);
        directory(&turn)?;
        Ok(turn)
    }
    pub fn index(&self, sid: &str, mid: &str) -> Result<Vec<Value>> {
        let key = format!("{sid}/{mid}");
        if let Some(items) = self.indexes.get(&key) {
            return Ok(items.clone());
        }
        let path = self.turn(sid, mid)?.join("index.json");
        let value = load_or(&path, json!([]), 8 * 1024 * 1024)?;
        let rows = value
            .as_array()
            .ok_or_else(|| Error::new("INVALID_STATE", "Invalid tool index"))?;
        if rows
            .iter()
            .any(|v| s(v, "id").is_empty() || s(v, "id").len() > 128)
        {
            return err("INVALID_STATE", "Invalid archived tool identity");
        }
        Ok(rows.clone())
    }
    fn tool_dir(&self, sid: &str, mid: &str, tool: &str) -> Result<PathBuf> {
        let path = self.turn(sid, mid)?.join(hash(tool));
        directory(&path)?;
        Ok(path)
    }
    pub fn preview(&self, sid: &str, mid: &str, tool: &str, limit: usize) -> Result<Value> {
        let dir = self.tool_dir(sid, mid, tool)?;
        let mut meta = read_json(&dir.join("meta.json"), 65536)?;
        let mut shortened = false;
        for field in ["input", "result", "text"] {
            let page = part(&dir.join(field), 0, limit)?;
            shortened |= page["hasMore"] == true;
            meta[field] = if field != "text" && page["hasMore"] != true {
                serde_json::from_str(s(&page, "text"))?
            } else {
                json!(s(&page, "text"))
            };
        }
        meta["truncated"] = json!(shortened);
        meta["archived"] = json!(true);
        Ok(meta)
    }
    pub fn record(
        &mut self,
        sid: &str,
        mid: &str,
        kind: &str,
        p: &Value,
    ) -> Result<(usize, Option<Value>, Option<Value>)> {
        let tid = s(p, "id");
        if tid.is_empty() || tid.len() > 128 {
            return err("PROTOCOL_ERROR", "Invalid tool identity");
        }
        let key = format!("{sid}/{mid}");
        let mut items = self.index(sid, mid)?;
        let existing = items.iter().position(|v| v["id"] == tid);
        if kind == "tool.start" && existing.is_some() {
            return Ok((items.len(), None, None));
        }
        if kind != "tool.start" && existing.is_none() {
            return Ok((items.len(), None, None));
        }
        let dir = self.tool_dir(sid, mid, tid)?;
        match kind {
            "tool.start" => {
                let meta = json!({"id":tid,"name":s(p,"name"),"status":"running"});
                atomic_write(&dir.join("input"), &serde_json::to_vec(&p["input"])?)?;
                atomic_write(&dir.join("result"), b"null")?;
                atomic_write(&dir.join("text"), b"")?;
                atomic_json(&dir.join("meta.json"), &meta, 65536)?;
                items.push(meta);
                atomic_json(
                    &self.turn(sid, mid)?.join("index.json"),
                    &json!(items),
                    8 * 1024 * 1024,
                )?;
                self.indexes.insert(key, items.clone());
            }
            "tool.input" => atomic_write(&dir.join("input"), &serde_json::to_vec(&p["input"])?)?,
            "tool.update" if p["replace"] == true => {
                atomic_write(&dir.join("text"), s(p, "text").as_bytes())?
            }
            "tool.update" => {
                let mut file = OpenOptions::new()
                    .append(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(dir.join("text"))?;
                if !file.metadata()?.is_file() {
                    return err("INVALID_PATH", "Invalid tool output file");
                }
                file.write_all(s(p, "text").as_bytes())?;
                file.sync_data()?;
            }
            "tool.end" => {
                atomic_write(&dir.join("result"), &serde_json::to_vec(&p["result"])?)?;
                let mut meta = read_json(&dir.join("meta.json"), 65536)?;
                meta["isError"] = json!(p["isError"] == true);
                meta["status"] = json!(if p["isError"] == true {
                    "error"
                } else {
                    "done"
                });
                atomic_json(&dir.join("meta.json"), &meta, 65536)?;
            }
            _ => return Ok((items.len(), None, None)),
        }
        let position = existing.unwrap_or(items.len() - 1);
        let preview = if position >= items.len().saturating_sub(16) {
            Some(self.preview(sid, mid, tid, 4096)?)
        } else {
            None
        };
        let todo = if matches!(
            s(&items[position], "name").to_lowercase().as_str(),
            "todo" | "todowrite" | "todo_write" | "update_plan" | "update_todos"
        ) && matches!(kind, "tool.start" | "tool.input" | "tool.end")
        {
            Some(self.preview(sid, mid, tid, 65536)?)
        } else {
            None
        };
        Ok((items.len(), preview, todo))
    }
    pub fn read(&self, sid: &str, mid: &str, p: &Value) -> Result<Value> {
        let items = self.index(sid, mid)?;
        if items.len() < p["minimumCount"].as_u64().unwrap_or(0) as usize {
            return err(
                "HISTORY_UNAVAILABLE",
                "Tool archive index is missing saved records",
            );
        }
        if p.get("toolId").is_some() {
            let tid = required(p, "toolId", 128)?;
            if !items.iter().any(|v| v["id"] == tid) {
                return err("NOT_FOUND", "Tool is not in this message");
            }
            let field = s(p, "field");
            if !matches!(field, "input" | "result" | "text") {
                return err("INVALID_INPUT", "Choose input, result or text");
            }
            let offset = usize_param(p, "offset", 0, usize::MAX)?;
            let limit = usize_param(p, "limit", 65536, 65536)?.max(4);
            let mut result = part(
                &self.tool_dir(sid, mid, &tid)?.join(field),
                offset as u64,
                limit,
            )?;
            result["toolId"] = json!(tid);
            result["field"] = json!(field);
            return Ok(result);
        }
        let offset = usize_param(p, "offset", 0, usize::MAX)?;
        let limit = usize_param(p, "limit", 16, 32)?.max(1);
        let query = p.get("query").and_then(Value::as_str).unwrap_or("");
        if query.len() > 512 {
            return err("INVALID_INPUT", "Search is too long");
        }
        let q = query
            .as_bytes()
            .iter()
            .map(u8::to_ascii_lowercase)
            .collect::<Vec<_>>();
        let mut matching = Vec::new();
        for item in &items {
            let mut matched = q.is_empty()
                || s(item, "name")
                    .as_bytes()
                    .windows(q.len())
                    .any(|w| w.eq_ignore_ascii_case(&q));
            if !matched {
                let dir = self.tool_dir(sid, mid, s(item, "id"))?;
                for field in ["input", "result", "text"] {
                    if contains(&dir.join(field), &q)? {
                        matched = true;
                        break;
                    }
                }
            }
            if matched {
                matching.push(item);
            }
        }
        let tools = matching
            .iter()
            .skip(offset)
            .take(limit)
            .map(|v| self.preview(sid, mid, s(v, "id"), 4096))
            .collect::<Result<Vec<_>>>()?;
        let next = offset + tools.len();
        Ok(
            json!({"tools":tools,"totalTools":items.len(),"matchedTools":matching.len(),"offset":offset,"nextOffset":next,"hasMore":next<matching.len()}),
        )
    }
}
