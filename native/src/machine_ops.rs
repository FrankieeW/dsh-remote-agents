//! Machine lifecycle: keeps fleet records consistent with conversations,
//! CLI updates, OMP configuration saves and provider caches.
use crate::{common::*, engine::Engine, hosts::Host, machines};
use serde_json::{Value, json};

impl Engine {
    pub(crate) async fn machine_call(&self, method: &str, p: &Value) -> Result<Value> {
        match method {
            "addMachine" => self.add_machine(p).await,
            "updateMachine" => self.update_machine(p).await,
            "removeMachine" => self.remove_machine(p).await,
            "restoreMachine" => {
                self.fleet
                    .restore_machine(&required(p, "machineId", 128)?)
                    .await
            }
            _ => self.probe(p).await,
        }
    }
    /// Saves a machine; with `verify`, only after SSH accepts a command.
    async fn add_machine(&self, p: &Value) -> Result<Value> {
        let connection = machines::connection(p)?;
        let name = machines::display_name(p, &connection)?;
        let verify = machines::flag(p, "verify")?;
        self.fleet.ensure_new(&connection)?;
        let check = if verify {
            let result = self.check(&machines::candidate(&connection), false).await;
            if result["ok"] != true {
                let code = Some(s(&result["ssh"], "code")).filter(|c| !c.is_empty());
                return err(code.unwrap_or("SSH_FAILED"), s(&result["ssh"], "message"));
            }
            Some(machines::last_check(&result))
        } else {
            None
        };
        self.fleet.add_machine(connection, name, check).await
    }
    async fn update_machine(&self, p: &Value) -> Result<Value> {
        let id = required(p, "machineId", 128)?;
        let name = match p.get("name") {
            None | Some(Value::Null) => None,
            Some(v) => Some(machines::name(v)?),
        };
        let connection = if machines::has_connection(p) {
            Some(machines::connection(p)?)
        } else {
            None
        };
        if name.is_none() && connection.is_none() {
            return err("INVALID_INPUT", "Provide a new name or SSH destination");
        }
        if connection.is_none() {
            return self.fleet.update_machine(&id, name, None).await;
        }
        if id == "local" {
            return err("INVALID_INPUT", "The local machine has no SSH address to edit");
        }
        let _gate = self.gate.lock().await;
        self.ensure_idle(&id, "changing its address").await?;
        let updated = self.fleet.update_machine(&id, name, connection).await?;
        self.registry.forget_machine(&id).await;
        Ok(updated)
    }
    /// Keeps a tombstone while conversations reference the machine.
    async fn remove_machine(&self, p: &Value) -> Result<Value> {
        let id = required(p, "machineId", 128)?;
        if id == "local" {
            return err("INVALID_INPUT", "The local machine cannot be removed");
        }
        let _gate = self.gate.lock().await;
        self.ensure_idle(&id, "removing it").await?;
        let sessions = {
            let chat = self.chat().await?;
            let store = chat.lock().await;
            store
                .list()
                .as_array()
                .unwrap()
                .iter()
                .filter(|s| s["machineId"] == id.as_str())
                .count()
        };
        let mut result = self.fleet.remove_machine(&id, sessions > 0).await?;
        self.registry.forget_machine(&id).await;
        result["sessions"] = json!(sessions);
        Ok(result)
    }
    /// Refuses lifecycle changes while turns, CLI updates or OMP saves use the machine.
    /// Callers hold the gate so no new turn can be admitted meanwhile.
    async fn ensure_idle(&self, id: &str, action: &str) -> Result<()> {
        let live = {
            let chat = self.chat().await?;
            let store = chat.lock().await;
            store
                .live
                .keys()
                .filter(|sid| store.session(sid).is_ok_and(|s| s["machineId"] == id))
                .count()
        };
        if live > 0 {
            let turns = if live == 1 {
                "the active conversation turn".to_owned()
            } else {
                format!("the {live} active conversation turns")
            };
            return err("BUSY", format!("Stop {turns} on this machine before {action}"));
        }
        if self.registry.machine_updating(id).await {
            return err(
                "BUSY",
                format!("Wait for the CLI update on this machine to finish before {action}"),
            );
        }
        if self.omp_saving.lock().unwrap().contains(id) {
            return err(
                "BUSY",
                format!("Wait for the OMP configuration save on this machine to finish before {action}"),
            );
        }
        Ok(())
    }
    /// Tests a saved machine (and records the result) or an unsaved destination.
    async fn probe(&self, p: &Value) -> Result<Value> {
        if machines::has_connection(p) {
            let host = machines::candidate(&machines::connection(p)?);
            return Ok(self.check(&host, false).await);
        }
        let id = machines::machine_param(p)?;
        let host = self.host(&id).await?;
        let mut result = self.check(&host, true).await;
        if let Err(e) = self
            .fleet
            .record_check(&id, &host.machine, machines::last_check(&result))
            .await
        {
            result["warning"] = json!(format!("The result could not be saved: {}", e.message));
        }
        Ok(result)
    }
    /// SSH first; tmux and CLI checks only run on a reachable machine.
    async fn check(&self, host: &Host, clis: bool) -> Value {
        let ssh = machines::check_ssh(host).await;
        let (tmux, clis) = if ssh["ok"] == true {
            tokio::join!(machines::check_tmux(host), async {
                if clis {
                    self.registry.summary(host).await
                } else {
                    json!([])
                }
            })
        } else {
            (
                json!({"ok":false,"code":"SKIPPED","message":"Skipped because SSH failed"}),
                json!([]),
            )
        };
        machines::probe_result(s(&host.machine, "id"), ssh, tmux, clis)
    }
}
