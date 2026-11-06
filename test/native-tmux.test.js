import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBackend } from "../src/native/client.js";
test(
  "Rust backend real isolated tmux ownership, literal input, capture and stop",
  { skip: process.env.DSH_FLEET_SMOKE !== "1", timeout: 30000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-rust-tmux-"));
    const backend = new NativeBackend({ statePath: join(root, "fleet.json") });
    let agent;
    try {
      assert.equal(
        (await backend.request("probe", { machineId: "local" })).ok,
        true,
      );
      agent = await backend.request("start", {
        name: "Rust isolated smoke",
        cwd: root,
        kind: "shell",
      });
      await backend.request("send", {
        agentId: agent.id,
        text: "printf 'RUST_%s_OK\\n' SMOKE",
      });
      let snapshot;
      for (let n = 0; n < 30; n++) {
        snapshot = await backend.request("read", { agentId: agent.id });
        if (snapshot.output.includes("RUST_SMOKE_OK")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(snapshot.output, /RUST_SMOKE_OK/);
      assert.equal(snapshot.status, "running");
      await backend.request("stop", { agentId: agent.id });
      assert.equal(
        (await backend.request("read", { agentId: agent.id })).status,
        "exited",
      );
    } finally {
      if (agent)
        await backend.request("stop", { agentId: agent.id }).catch(() => {});
      await backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
