import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { FleetManager } from "../src/core/index.js";

test(
  "real isolated local tmux shell lifecycle",
  { skip: process.env.DSH_FLEET_SMOKE !== "1", timeout: 30000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-fleet-smoke-"));
    const fleet = new FleetManager({ statePath: join(dir, "fleet.json") });
    assert.equal((await fleet.probe("local")).ok, true);
    const agent = await fleet.start({
      name: "isolated-smoke",
      cwd: process.cwd(),
      kind: "shell",
    });
    try {
      await fleet.send(agent.id, { text: "printf 'FLEET_%s_OK\\n' SMOKE" });
      let result;
      for (let i = 0; i < 20; i++) {
        result = await fleet.read(agent.id);
        if (result.output.includes("FLEET_SMOKE_OK")) break;
        await setTimeout(100);
      }
      assert.equal(result.status, "running");
      assert.match(result.output, /FLEET_SMOKE_OK/);
    } finally {
      await fleet.stop(agent.id);
    }
    assert.equal((await fleet.read(agent.id)).status, "exited");
  },
);
