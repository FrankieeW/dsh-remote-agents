use crate::common::*;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
#[derive(Clone)]
struct Entry {
    parent: Option<String>,
    offset: u64,
    length: usize,
    kind: String,
    role: String,
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
fn at(reader: &mut BufReader<std::fs::File>, e: &Entry) -> Result<Value> {
    reader.seek(SeekFrom::Start(e.offset))?;
    let mut bytes = vec![0; e.length];
    reader.read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}
fn bounded(v: &Value, max: usize) -> Value {
    let t = v.to_string();
    if t.chars().count() > max {
        Value::String(format!("{}…", clip(&t, max)))
    } else {
        v.clone()
    }
}
pub fn original(root: &Path, session: &Value, p: &Value) -> Result<Value> {
    if session["provider"] != "omp"
        || session
            .get("machineId")
            .and_then(Value::as_str)
            .unwrap_or("local")
            != "local"
    {
        return err(
            "HISTORY_UNAVAILABLE",
            "Original-history lookup supports local OMP sessions only",
        );
    }
    let sid = s(session, "id");
    let native = s(session, "providerSessionId");
    if !safe_id(sid) || !safe_id(native) {
        return err("HISTORY_UNAVAILABLE", "Missing owned OMP history identity");
    }
    let message_id = s(p, "messageId");
    let requests = session["requests"]
        .as_array()
        .ok_or_else(|| Error::new("HISTORY_UNAVAILABLE", "Missing request history"))?;
    let request_index = requests
        .iter()
        .position(|r| s(r, "assistantMessageId") == message_id)
        .ok_or_else(|| Error::new("HISTORY_UNAVAILABLE", "Message has no request record"))?;
    if !session["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| s(m, "id") == message_id && m["role"] == "assistant")
    {
        return err(
            "HISTORY_UNAVAILABLE",
            "Message is not retained in this session",
        );
    }
    let directory = root.join(sid);
    if std::fs::symlink_metadata(&directory)?
        .file_type()
        .is_symlink()
    {
        return err(
            "HISTORY_UNAVAILABLE",
            "Refusing a history directory symlink",
        );
    }
    let matches = std::fs::read_dir(directory)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_file())
                && e.file_name()
                    .to_string_lossy()
                    .ends_with(&format!("_{native}.jsonl"))
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return err(
            "HISTORY_UNAVAILABLE",
            "Could not uniquely identify OMP history",
        );
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(matches[0].path())?;
    let size = file.metadata()?.len();
    if size > 256 * 1024 * 1024 {
        return err(
            "HISTORY_UNAVAILABLE",
            "OMP history exceeds the 256 MiB indexing limit",
        );
    };
    let mut reader = BufReader::new(file);
    let mut entries = HashMap::new();
    let mut last = None;
    let mut offset = 0;
    let mut headers = 0;
    // First pass retains only identity/parent/offset metadata, never provider envelopes.
    while offset < size {
        let mut line = Vec::new();
        let n = (&mut reader)
            .take((size - offset).min(8 * 1024 * 1024 + 1))
            .read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n > 8 * 1024 * 1024 {
            return err("HISTORY_UNAVAILABLE", "OMP record exceeds 8 MiB");
        };
        let current = offset;
        offset += n as u64;
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        let row: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) if offset == size => break,
            Err(_) => return err("HISTORY_UNAVAILABLE", "Invalid OMP history record"),
        };
        if row["type"] == "session" {
            headers += 1;
            if s(&row, "id") != native || s(&row, "cwd") != s(session, "cwd") {
                return err(
                    "HISTORY_UNAVAILABLE",
                    "OMP history identity or project directory mismatch",
                );
            }
        }
        if row["id"].is_string() && row.get("parentId").is_some() {
            let id = s(&row, "id").to_owned();
            if id.len() > 256 || entries.len() >= 1_000_000 {
                return err("HISTORY_UNAVAILABLE", "History index limit exceeded");
            }
            let entry = Entry {
                parent: row["parentId"].as_str().map(String::from),
                offset: current,
                length: n,
                kind: s(&row, "type").into(),
                role: s(&row["message"], "role").into(),
            };
            if entries.insert(id.clone(), entry).is_some() {
                return err("HISTORY_UNAVAILABLE", "Duplicate OMP record identity");
            }
            last = Some(id)
        }
    }
    if headers != 1 {
        return err(
            "HISTORY_UNAVAILABLE",
            "OMP session header missing or duplicated",
        );
    }
    let mut chain = vec![];
    let mut visited = HashSet::new();
    while let Some(id) = last {
        if !visited.insert(id.clone()) {
            return err("HISTORY_UNAVAILABLE", "OMP history parent cycle");
        }
        let e = entries
            .get(&id)
            .ok_or_else(|| Error::new("HISTORY_UNAVAILABLE", "Incomplete OMP parent chain"))?;
        chain.push(e.clone());
        last = e.parent.clone()
    }
    chain.reverse();
    let users = chain
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == "message" && e.role == "user")
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    if users.len() <= request_index {
        return err(
            "HISTORY_UNAVAILABLE",
            "This turn is not yet saved in the original OMP history; refresh later",
        );
    };
    if users.len() > requests.len() {
        return err(
            "HISTORY_UNAVAILABLE",
            "Native history differs from this conversation",
        );
    };
    for (i, entry) in users.iter().enumerate() {
        let row = at(&mut reader, &chain[*entry])?;
        if hash(text_of(&row["message"])) != s(&requests[i], "textHash") {
            return err(
                "HISTORY_UNAVAILABLE",
                "Native history cannot be matched safely",
            );
        }
    }
    let end = users.get(request_index + 1).copied().unwrap_or(chain.len());
    let mut calls: Vec<(String, String, Entry, usize, Option<Entry>)> = vec![];
    let mut lookup = HashMap::new();
    let mut text = String::new();
    let mut text_length = 0;
    for e in &chain[users[request_index] + 1..end] {
        if e.kind != "message" {
            continue;
        }
        let row = at(&mut reader, e)?;
        let m = &row["message"];
        if e.role == "assistant" {
            let value = text_of(m);
            if !value.is_empty() {
                if text_length > 0 {
                    text_length += 2;
                    if text.chars().count() < 65536 {
                        text.push_str("\n\n")
                    }
                }
                text_length += value.chars().count();
                let remaining = 65536 - text.chars().count().min(65536);
                text.push_str(&clip(&value, remaining))
            }
            if let Some(blocks) = m["content"].as_array() {
                for (index, b) in blocks.iter().enumerate() {
                    let id = s(b, "id");
                    if b["type"] == "toolCall"
                        && !id.is_empty()
                        && id.len() <= 512
                        && !lookup.contains_key(id)
                    {
                        lookup.insert(id.to_owned(), calls.len());
                        calls.push((id.into(), clip(s(b, "name"), 128), e.clone(), index, None))
                    }
                }
            }
        } else if e.role == "toolResult" {
            if let Some(i) = lookup.get(s(m, "toolCallId")) {
                calls[*i].4 = Some(e.clone())
            }
        }
    }
    let offset = usize_param(p, "offset", 0, 1_000_000)?;
    let limit = usize_param(p, "limit", 16, 32)?;
    if limit == 0 {
        return err("INVALID_INPUT", "Invalid page limit");
    }
    let tool_id = p.get("toolId").and_then(Value::as_str);
    let indices =
        if let Some(id) = tool_id {
            vec![*lookup.get(id).ok_or_else(|| {
                Error::new("HISTORY_UNAVAILABLE", "Tool is not part of this turn")
            })?]
        } else {
            (offset..(offset + limit).min(calls.len())).collect()
        };
    let bound = if tool_id.is_some() { 256 * 1024 } else { 4096 };
    let mut tools = vec![];
    for i in indices {
        let (id, name, e, index, result) = &calls[i];
        let row = at(&mut reader, e)?;
        let input = row["message"]["content"][*index]["arguments"].clone();
        let mut output = Value::Null;
        let mut failed = false;
        if let Some(e) = result {
            let row = at(&mut reader, e)?;
            let m = &row["message"];
            failed = m["isError"] == true;
            output = json!({"content":m["content"].as_array().into_iter().flatten().filter(|b|b["type"]=="text"&&b["text"].is_string()).map(|b|json!({"type":"text","text":b["text"]})).collect::<Vec<_>>(),"details":m["details"]})
        }
        let bounded_input = bounded(&input, bound);
        let bounded_result = bounded(&output, bound);
        tools.push(json!({"id":id,"name":name,"input":bounded_input,"result":bounded_result,"text":"","status":if result.is_none(){"running"}else if failed{"error"}else{"done"},"isError":failed,"truncated":false,"previewTruncated":bounded_input!=input||bounded_result!=output}));
    }
    if tool_id.is_some() {
        return Ok(json!({"tool":tools[0],"detailLimit":bound}));
    }
    let next = offset + tools.len();
    Ok(
        json!({"source":"OMP original history","totalTools":calls.len(),"offset":offset,"nextOffset":next,"hasMore":next<calls.len(),"tools":tools,"text":text,"textLength":text_length,"textPreviewTruncated":text_length>65536,"snapshot":true}),
    )
}
