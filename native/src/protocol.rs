use crate::{
    common::*,
    hosts::{Host, kill_group},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::VecDeque, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
};
struct Chunk {
    id: String,
    count: usize,
    next: usize,
    size: usize,
    data: Vec<u8>,
}
#[derive(Default)]
pub struct Decoder {
    chunk: Option<Chunk>,
}
impl Decoder {
    pub fn frame(&mut self, v: Value) -> Result<Option<Value>> {
        if !v.is_object() || !v["type"].is_string() {
            return err("PROTOCOL_ERROR", "Invalid OMP frame object");
        }
        if v["type"] != "rpc_chunk" {
            if self.chunk.is_some() {
                return err("PROTOCOL_ERROR", "OMP chunk sequence interrupted");
            }
            return Ok(Some(v));
        }
        let id = s(&v, "chunkId");
        let index = v["index"].as_u64().unwrap_or(u64::MAX) as usize;
        let count = v["count"].as_u64().unwrap_or(0) as usize;
        let size = v["byteLength"].as_u64().unwrap_or(0) as usize;
        if id.is_empty()
            || id.len() > 128
            || !(2..=256).contains(&count)
            || index >= count
            || !(1024 * 1024..=64 * 1024 * 1024).contains(&size)
        {
            return err("PROTOCOL_ERROR", "Invalid OMP chunk metadata");
        }
        let data = STANDARD
            .decode(s(&v, "data"))
            .map_err(|_| Error::new("PROTOCOL_ERROR", "Invalid OMP chunk data"))?;
        if data.is_empty() || data.len() > 256 * 1024 || STANDARD.encode(&data) != s(&v, "data") {
            return err("PROTOCOL_ERROR", "Non-canonical OMP chunk data");
        }
        if self.chunk.is_none() {
            if index != 0 {
                return err("PROTOCOL_ERROR", "OMP chunks must start at zero");
            }
            self.chunk = Some(Chunk {
                id: id.into(),
                count,
                next: 0,
                size,
                data: vec![],
            })
        }
        let c = self.chunk.as_mut().unwrap();
        if c.id != id
            || c.count != count
            || c.size != size
            || c.next != index
            || c.data.len() + data.len() > size
        {
            return err("PROTOCOL_ERROR", "OMP chunk sequence mismatch");
        }
        c.data.extend(data);
        c.next += 1;
        if c.next < count {
            return Ok(None);
        }
        if c.data.len() != size {
            return err("PROTOCOL_ERROR", "OMP chunk length mismatch");
        }
        let complete: Value = serde_json::from_slice(&c.data)?;
        self.chunk = None;
        if !complete.is_object() || !complete["type"].is_string() || complete["type"] == "rpc_chunk"
        {
            return err("PROTOCOL_ERROR", "Nested chunks forbidden");
        }
        Ok(Some(complete))
    }
}
pub struct Wire {
    pub child: Child,
    stdin: ChildStdin,
    rx: mpsc::Receiver<Result<Value>>,
    queue: VecDeque<Value>,
    queue_bytes: usize,
    sequence: u64,
    kind: String,
    reader: tokio::task::JoinHandle<()>,
    stderr: tokio::task::JoinHandle<()>,
}
impl Wire {
    pub fn spawn(host: &Host, file: &str, args: &[String], cwd: &str, kind: &str) -> Result<Self> {
        let mut child = host.spawn(file, args, cwd)?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::channel(2);
        let max = if kind == "omp" {
            1024 * 1024
        } else {
            8 * 1024 * 1024
        };
        let omp = kind == "omp";
        let reader = tokio::spawn(async move {
            let mut read = BufReader::new(stdout);
            let mut decoder = Decoder::default();
            loop {
                let mut line = vec![];
                let result: Result<Option<Value>> = async {
                    let n = (&mut read)
                        .take(max + 1)
                        .read_until(b'\n', &mut line)
                        .await?;
                    if n == 0 {
                        return err("PROCESS_EXIT", "CLI output ended");
                    }
                    if n as u64 > max {
                        return err("PROTOCOL_ERROR", "CLI frame exceeds limit");
                    }
                    if !line.ends_with(b"\n") {
                        return err("PROTOCOL_ERROR", "Incomplete CLI frame");
                    }
                    if line.iter().all(|c| c.is_ascii_whitespace()) {
                        return Ok(None);
                    }
                    let v: Value = serde_json::from_slice(&line)?;
                    if !v.is_object() {
                        return err("PROTOCOL_ERROR", "CLI frame must be an object");
                    }
                    if omp { decoder.frame(v) } else { Ok(Some(v)) }
                }
                .await;
                match result {
                    Ok(Some(v)) => {
                        if tx.send(Ok(v)).await.is_err() {
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => {
                        let _ = tx.send(Err(e)).await;
                        break;
                    }
                }
            }
        });
        let stderr = tokio::spawn(async move {
            let mut buf = [0; 8192];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            rx,
            queue: VecDeque::new(),
            queue_bytes: 0,
            sequence: 0,
            kind: kind.into(),
            reader,
            stderr,
        })
    }
    pub async fn send(&mut self, v: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&v)?;
        if bytes.len() > 8 * 1024 * 1024 {
            return err("PROTOCOL_ERROR", "Outgoing frame exceeds limit");
        }
        bytes.push(b'\n');
        tokio::time::timeout(Duration::from_secs(20), self.stdin.write_all(&bytes))
            .await
            .map_err(|_| Error::new("TIMEOUT", "CLI input backpressure timeout"))??;
        Ok(())
    }
    async fn receive(&mut self) -> Result<Value> {
        self.rx
            .recv()
            .await
            .ok_or_else(|| Error::new("PROCESS_EXIT", "CLI process ended"))?
    }
    pub async fn next(&mut self) -> Result<Value> {
        if let Some(v) = self.queue.pop_front() {
            self.queue_bytes = self.queue_bytes.saturating_sub(v.to_string().len());
            return Ok(v);
        }
        self.receive().await
    }
    pub async fn ready(&mut self) -> Result<Value> {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let v = self.next().await?;
                if v["type"] == "ready" {
                    return Ok(v);
                }
            }
        })
        .await
        .map_err(|_| Error::new("TIMEOUT", "OMP startup timeout"))?
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = format!("native-{}", self.sequence);
        self.request_id(method, params, &id).await
    }
    pub async fn request_id(&mut self, method: &str, params: Value, id: &str) -> Result<Value> {
        let frame = if self.kind == "omp" {
            let mut v = params;
            v["id"] = json!(id);
            v["type"] = json!(method);
            v
        } else if self.kind == "claude-options" {
            let mut request = params;
            request["subtype"] = json!(method);
            json!({"type":"control_request","request_id":id,"request":request})
        } else {
            json!({"id":id,"method":method,"params":params})
        };
        self.send(frame).await?;
        tokio::time::timeout(Duration::from_secs(20),async{loop{let v=self.receive().await?;let response_id=if self.kind=="claude-options"{s(&v["response"],"request_id")}else{s(&v,"id")};if response_id==id{if self.kind=="omp"{if v["command"]!=method||!v["success"].is_boolean(){return err("PROTOCOL_ERROR","OMP response correlation mismatch")}if v["success"]!=true{return err("CLI_ERROR",format!("OMP rejected {method}"))}return Ok(v["data"].clone())}if self.kind=="claude-options"{if v["response"]["subtype"]=="error"{return err("CLI_ERROR","Claude configuration request failed")}return Ok(v["response"]["response"].clone())}if v.get("error").is_some(){return err("CLI_ERROR",clip(s(&v["error"],"message"),2048))}return Ok(v["result"].clone())}
if self.kind=="claude-options"&&v["type"]=="control_request"{self.send(json!({"type":"control_response","response":{"subtype":"error","request_id":v["request_id"],"error":"Configuration lookup cannot approve tools"}})).await?;continue}self.queue_bytes+=v.to_string().len();if self.queue_bytes>8*1024*1024{return err("PROTOCOL_ERROR","Early CLI messages exceed limit")}self.queue.push_back(v);}}).await.map_err(|_|Error::new("TIMEOUT",format!("{method} response timed out")))?
    }
    pub async fn close(&mut self) {
        kill_group(self.child.id());
        if tokio::time::timeout(Duration::from_millis(500), self.child.wait())
            .await
            .is_err()
        {
            if let Some(pid) = self.child.id() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
            let _ = self.child.kill().await;
        }
    }
}
impl Drop for Wire {
    fn drop(&mut self) {
        if let Some(pid) = self.child.id() {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        self.reader.abort();
        self.stderr.abort();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_chunks() {
        let mut d = Decoder::default();
        assert!(d.frame(json!({"type":"rpc_chunk","chunkId":"a","index":1,"count":2,"byteLength":1024*1024,"data":"YQ=="})).is_err());
    }
    #[test]
    fn reassembles_large_frames_and_rejects_interleaving() {
        let original = json!({"type":"message_end","text":"x".repeat(1024*1024)});
        let bytes = serde_json::to_vec(&original).unwrap();
        let chunks = bytes.chunks(256 * 1024).collect::<Vec<_>>();
        let mut decoder = Decoder::default();
        for (index, data) in chunks.iter().enumerate() {
            let decoded = decoder.frame(json!({"type":"rpc_chunk","chunkId":"large","index":index,"count":chunks.len(),"byteLength":bytes.len(),"data":STANDARD.encode(data)})).unwrap();
            if index + 1 == chunks.len() {
                assert_eq!(decoded, Some(original.clone()));
            } else {
                assert!(decoded.is_none());
            }
        }
        let mut decoder = Decoder::default();
        decoder.frame(json!({"type":"rpc_chunk","chunkId":"large","index":0,"count":chunks.len(),"byteLength":bytes.len(),"data":STANDARD.encode(chunks[0])})).unwrap();
        assert!(decoder.frame(json!({"type":"ready"})).is_err());
        assert!(Decoder::default().frame(json!({"missing":"type"})).is_err());
    }
}
