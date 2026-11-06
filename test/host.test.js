import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, inject } from "../src/index.js";

test("host registers isolated authenticated RPC without creating processes at load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-fleet-host-"));
  let registered;
  apply(
    {
      inject(services, register) {
        assert.deepEqual(services, ["skills"]);
        register({
          skills: {
            registerProvider(factory) {
              assert.equal(factory().name, "remote-agents-import-skill");
            },
          },
        });
      },
      connection: {
        rpc: {
          handle(channel, handler) {
            registered = { channel, handler };
          },
        },
      },
    },
    { statePath: join(dir, "state.json") },
  );
  assert.deepEqual(inject, ["connection", "webServer"]);
  assert.equal(registered.channel, "/remote-agents");
  const denied = await registered.handler("snapshot", {}, undefined, {
    principal: { kind: "guest" },
  });
  assert.equal(denied.error.code, "forbidden");
  const result = await registered.handler("snapshot", {}, undefined, {
    principal: { kind: "owner" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.machines[0].id, "local");
  assert.deepEqual(result.value.agents, []);
});
