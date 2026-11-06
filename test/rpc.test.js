import test from "node:test";
import assert from "node:assert/strict";
import { createHandler } from "../src/rpc.js";
const owner = { principal: { kind: "owner" } };
const call = (handler, method, payload = {}, peer = owner) =>
  handler(method, payload, new AbortController().signal, peer);

test("all RPC operations require an authenticated owner", async () => {
  let called = false;
  const handler = createHandler({
    snapshot() {
      called = true;
    },
  });
  for (const peer of [undefined, {}, { principal: { kind: "guest" } }]) {
    for (const method of ["snapshot", "previewHerdr", "importHerdr"]) {
      assert.equal(
        (await call(handler, method, {}, peer ?? null)).error.code,
        "forbidden",
      );
    }
  }
  assert.equal(called, false);
});
test("reject invalid payloads, prototype method names, oversized bodies and aborted requests", async () => {
  const handler = createHandler({});
  for (const payload of [null, [], "foo"])
    assert.equal(
      (await call(handler, "snapshot", payload)).error.code,
      "invalid_input",
    );
  for (const endpoint of ["constructor", "__proto__", "toString", "unknown"])
    assert.equal((await call(handler, endpoint)).error.code, "not_found");
  assert.equal(
    (await call(handler, "snapshot", { data: "x".repeat(65537) })).error.code,
    "invalid_input",
  );
  assert.equal(
    (await handler("snapshot", {}, AbortSignal.abort(), owner)).error.code,
    "cancelled",
  );
});
test("dispatch adapts API parameters and wraps values", async () => {
  const calls = [];
  const fleet = Object.fromEntries(
    [
      "snapshot",
      "addMachine",
      "removeMachine",
      "probe",
      "start",
      "read",
      "send",
      "interrupt",
      "stop",
    ].map((name) => [
      name,
      (...args) => {
        calls.push([name, ...args]);
        return "result";
      },
    ]),
  );
  const handler = createHandler(fleet);
  assert.deepEqual(await call(handler, "read", { agentId: "a" }), {
    ok: true,
    value: "result",
  });
  assert.deepEqual(calls.pop(), ["read", "a", { lines: 200 }]);
  await call(handler, "send", { agentId: "a", text: "hello" });
  assert.deepEqual(calls.pop(), ["send", "a", { text: "hello", enter: true }]);
  await call(handler, "interrupt", { agentId: "a" });
  assert.deepEqual(calls.pop(), ["interrupt", "a"]);
});
test("subprocess failures are bounded structured errors", async () => {
  const handler = createHandler({
    probe() {
      throw Object.assign(new Error("x".repeat(5000)), { code: "ssh_error" });
    },
  });
  const result = await call(handler, "probe", { machineId: "m" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ssh_error");
  assert.equal(result.error.message.length, 2000);
});
