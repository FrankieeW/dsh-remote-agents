use dsh_remote_agents_backend::{common::*, engine::Engine, hosts::Host};
use serde_json::{Value, json};
use std::{os::unix::process::CommandExt, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};
#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.first().is_some_and(|v| v == "--version") {
        println!("dsh-remote-agents-backend {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if args.first().is_some_and(|v| v == "--claude-ssh") {
        if let Err(e) = exec_ssh(&args[1..]) {
            eprintln!("{}", e.message);
            std::process::exit(1)
        }
        return;
    }
    if !args.is_empty() {
        eprintln!("Use stdio JSON requests or --version");
        std::process::exit(2)
    }
    if let Err(e) = serve().await {
        eprintln!("{}: {}", e.code, e.message);
        std::process::exit(1)
    }
}
fn exec_ssh(args: &[String]) -> Result<()> {
    if args.len() < 3 {
        return err("INVALID_INPUT", "Invalid Claude SSH transport");
    };
    let machine: Value = serde_json::from_str(&args[0])?;
    let host = Host { machine };
    let command = format!(
        "export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; cd {} && exec {}",
        dsh_remote_agents_backend::hosts::shell_path(&args[1])?,
        args[2..]
            .iter()
            .map(|s| quote(s))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let error = std::process::Command::new("ssh")
        .args(host.ssh_args(&command)?)
        .exec();
    Err(error.into())
}
async fn serve() -> Result<()> {
    let mut input = BufReader::new(tokio::io::stdin());
    let (tx, mut rx) = mpsc::channel::<Value>(64);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = rx.recv().await {
            let Ok(mut bytes) = serde_json::to_vec(&v) else {
                break;
            };
            bytes.push(b'\n');
            if stdout.write_all(&bytes).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    let mut engine: Option<Arc<Engine>> = None;
    let semaphore = Arc::new(tokio::sync::Semaphore::new(32));
    let mut calls = tokio::task::JoinSet::new();
    let mut input_error = None;
    loop {
        let mut line = vec![];
        let read = (&mut input)
            .take(5 * 1024 * 1024)
            .read_until(b'\n', &mut line)
            .await;
        let n = match read {
            Ok(n) => n,
            Err(e) => {
                input_error = Some(e.into());
                break;
            }
        };
        if n == 0 {
            break;
        }
        if n >= 5 * 1024 * 1024 || !line.ends_with(b"\n") {
            input_error = Some(Error::new(
                "PROTOCOL_ERROR",
                "Invalid or oversized backend request",
            ));
            break;
        };
        let frame: Value = match serde_json::from_slice(&line) {
            Ok(v) => v,
            Err(_) => {
                let _=tx.send(json!({"id":null,"ok":false,"error":{"code":"INVALID_JSON","message":"Invalid request JSON"}})).await;
                continue;
            }
        };
        let id = frame["id"].clone();
        if !id.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 128) {
            continue;
        }
        let method = s(&frame, "method");
        if method == "initialize" {
            let result = if engine.is_some() {
                err("CONFLICT", "Backend already initialized")
            } else {
                match Engine::new(frame["params"].clone()) {
                    Ok(e) => {
                        engine = Some(e);
                        Ok(
                            json!({"protocolVersion":1,"backend":"rust","version":env!("CARGO_PKG_VERSION")}),
                        )
                    }
                    Err(e) => Err(e),
                }
            };
            let _ = tx.send(response(id, result)).await;
            continue;
        }
        if method == "shutdown" {
            if let Some(e) = &engine {
                e.shutdown().await
            }
            let _ = tx.send(response(id, Ok(json!({"stopped":true})))).await;
            break;
        }
        let Some(e) = engine.clone() else {
            let _ = tx
                .send(response(
                    id,
                    err("NOT_READY", "Initialize the backend first"),
                ))
                .await;
            continue;
        };
        let method = method.to_owned();
        let p = frame["params"].clone();
        let tx = tx.clone();
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        calls.spawn(async move {
            let result = e.call(&method, p).await;
            let _ = tx.send(response(id, result)).await;
            drop(permit);
        });
        while calls.try_join_next().is_some() {}
    }
    if let Some(e) = engine {
        e.shutdown().await
    }
    calls.abort_all();
    while calls.join_next().await.is_some() {}
    drop(tx);
    let _ = writer.await;
    match input_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
fn response(id: Value, result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"id":id,"ok":true,"value":value}),
        Err(error) => json!({"id":id,"ok":false,"error":error.json()}),
    }
}
