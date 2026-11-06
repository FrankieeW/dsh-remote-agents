import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, inject } from "../src/index.js";
import { ENDPOINTS } from "../src/rpc.js";

test("host uses owner-only shared Fetch routes without a webServer dependency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-fleet-host-"));
  const routes = new Map();
  const disposers = [];
  apply(
    {
      effect(fn) {
        disposers.push(fn());
      },
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
        fetch: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        },
      },
    },
    { statePath: join(dir, "state.json") },
  );
  assert.deepEqual(inject, ["connection"]);
  assert.equal(routes.size, ENDPOINTS.length);
  const route = routes.get("/api/remote-agents/snapshot");
  assert.deepEqual(route.methods, ["POST"]);
  assert.equal(route.requestBody, "buffered");
  const invoke = (body, headers = { "content-type": "application/json" }) =>
    route.fetch(
      new Request("http://localhost/api/remote-agents/snapshot", {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const result = await (
    await invoke({
      type: "client-request",
      rpcId: "test-id",
      method: "remote-agents/snapshot",
      payload: {},
    })
  ).json();
  assert.equal(result.type, "server-response");
  assert.equal(result.rpcId, "test-id");
  assert.equal(result.result.ok, true);
  assert.equal(result.result.value.machines[0].id, "local");
  assert.equal(
    (
      await invoke({
        type: "client-request",
        rpcId: "test-id",
        method: "remote-agents/stop",
        payload: {},
      })
    ).status,
    400,
  );
  assert.equal((await invoke("invalid")).status, 400);
  assert.equal((await invoke("{}", {})).status, 415);
  assert.equal((await invoke("x".repeat(70000))).status, 413);
  for (const dispose of disposers) await dispose();
  assert.equal(routes.size, 0, "plugin unload removes its exact routes");
});
