import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager, shellQuote } from "../reference/src/core/index.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dsh-core-test-"));
  const calls = [];
  let session;
  let owner;
  let dead = "0";
  let broken = false;
  let output = "one\ntwo\nthree\n";
  const executor = async (file, args, options) => {
    calls.push({ file, args, options });
    if (broken) throw Object.assign(new Error("offline"), { code: 255 });
    assert.equal(file, "tmux");
    assert.equal(args[0], "-L");
    assert.match(args[1], /^dsh-fleet-/);
    assert.ok(options.timeout > 0 && options.maxBuffer > 0);
    const action = args[2];
    if (action === "has-session")
      throw Object.assign(new Error("missing"), { code: 1 });
    if (action === "new-session") {
      session = args[args.indexOf("-s") + 1];
      return { stdout: "$0\n" };
    }
    if (action === "set-option" && args.includes("@dsh_fleet_owner"))
      owner = args.at(-1);
    if (action === "display-message")
      return { stdout: `${session}\t${owner}\t${dead}\t$0\n` };
    if (action === "capture-pane") return { stdout: output };
    if (action === "-V") return { stdout: "tmux 3.4\n" };
    return { stdout: "", stderr: "" };
  };
  const statePath = join(directory, "state.json");
  const manager = new FleetManager({ statePath, executor });
  return {
    manager,
    statePath,
    calls,
    executor,
    setOwner: (value) => {
      owner = value;
    },
    setDead: (value) => {
      dead = value;
    },
    setBroken: (value) => {
      broken = value;
    },
    setOutput: (value) => {
      output = value;
    },
  };
}
const startInput = {
  name: "Test",
  cwd: "/tmp/project",
  kind: "codex",
  args: [],
};

test("initial state is local-only, persisted 0600 and snapshot never executes", async () => {
  const f = await fixture();
  const state = await f.manager.snapshot();
  assert.deepEqual(state.machines, [
    { id: "local", name: "Local", type: "local" },
  ]);
  assert.equal(f.calls.length, 0);
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  state.machines[0].name = "changed";
  assert.equal((await f.manager.snapshot()).machines[0].name, "Local");
});

test("lifecycle checks ownership, quotes startup, bounds capture and uses literal text", async () => {
  const f = await fixture();
  const agent = await f.manager.start({
    ...startInput,
    args: ["hello'; touch /tmp/nope; '", "$(uname)"],
  });
  assert.equal(agent.status, "running");
  assert.ok(
    f.calls.some((call) =>
      call.args.includes(
        shellQuote("exec") +
          " " +
          shellQuote("codex") +
          " " +
          shellQuote("hello'; touch /tmp/nope; '") +
          " " +
          shellQuote("$(uname)"),
      ),
    ),
  );
  const result = await f.manager.read(agent.id, { lines: 2 });
  assert.equal(result.output, "two\nthree");
  assert.equal(result.truncated, true);
  await f.manager.send(agent.id, { text: "-n ; $(rm -rf /)", enter: false });
  assert.deepEqual(f.calls.at(-1).args.slice(-3), [
    "-l",
    "--",
    "-n ; $(rm -rf /)",
  ]);
  await f.manager.interrupt(agent.id);
  assert.equal(f.calls.at(-1).args.at(-1), "C-c");
  assert.equal((await f.manager.stop(agent.id)).status, "exited");
  const count = f.calls.length;
  await f.manager.stop(agent.id);
  assert.equal(f.calls.length, count);
  assert.equal((await f.manager.read(agent.id)).status, "exited");
  assert.ok(!f.calls.some((call) => call.args.includes("kill-server")));
});

test("ownership mismatch cannot send, capture or stop", async () => {
  const f = await fixture();
  const agent = await f.manager.start(startInput);
  f.setOwner("not-ours");
  const before = f.calls.length;
  assert.equal((await f.manager.read(agent.id)).status, "unknown");
  await assert.rejects(f.manager.stop(agent.id), {
    code: "OWNERSHIP_UNVERIFIED",
  });
  await assert.rejects(f.manager.send(agent.id, { text: "hello" }), {
    code: "OWNERSHIP_UNVERIFIED",
  });
  assert.ok(
    f.calls.slice(before).every((call) => call.args[2] === "display-message"),
  );
  assert.equal((await f.manager.snapshot()).agents[0].status, "unknown");
});

test("dead pane is exited, transport failure unknown, never inferred LLM status", async () => {
  const f = await fixture();
  const agent = await f.manager.start(startInput);
  f.setDead("1");
  assert.equal((await f.manager.read(agent.id)).status, "exited");
  await assert.rejects(f.manager.send(agent.id, { text: "hello" }), {
    code: "NOT_RUNNING",
  });
  f.setBroken(true);
  assert.equal((await f.manager.read(agent.id)).status, "unknown");
  assert.equal((await f.manager.probe()).ok, false);
  const count = f.calls.length;
  await f.manager.snapshot();
  assert.equal(f.calls.length, count);
});

test("untrusted host, input, cwd, kind and key rejected before execution", async () => {
  const f = await fixture();
  for (const host of [
    "-oProxyCommand=evil",
    "host;whoami",
    "a b",
    "a\nb",
    "user@host",
  ]) {
    await assert.rejects(f.manager.addMachine({ name: "bad", host }), {
      code: "INVALID_INPUT",
    });
  }
  for (const changes of [
    { cwd: "relative" },
    { kind: "rm" },
    { args: ["a\nb"] },
    { args: "bad" },
    { cwd: "/tmp\nreboot" },
  ]) {
    await assert.rejects(f.manager.start({ ...startInput, ...changes }), {
      code: "INVALID_INPUT",
    });
  }
  await assert.rejects(f.manager.send("bad", { key: "C-z" }), {
    code: "INVALID_INPUT",
  });
  await assert.rejects(f.manager.send("bad", { text: "a\nb" }), {
    code: "INVALID_INPUT",
  });
  assert.equal(f.calls.length, 0);
});

test("SSH uses BatchMode, strict host checking and shell-quoted arguments", async () => {
  const f = await fixture();
  const calls = [];
  const manager = new FleetManager({
    statePath: f.statePath,
    executor: async (...args) => {
      calls.push(args);
      return { stdout: "tmux 3.4" };
    },
  });
  const machine = await manager.addMachine({
    name: "Remote",
    host: "my-safe.alias",
  });
  assert.equal((await manager.probe(machine.id)).ok, true);
  const [file, args] = calls[0];
  assert.equal(file, "ssh");
  assert.ok(args.includes("BatchMode=yes"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.equal(args.at(-2), "my-safe.alias");
  assert.match(args.at(-1), /^'tmux' '-L' 'dsh-fleet-[a-f0-9-]+' '-V'$/);
  assert.equal(shellQuote("a'b;$(id)"), "'a'\\''b;$(id)'");
});

test("separate managers serialize atomic writes without lost machines", async () => {
  const f = await fixture();
  const managers = Array.from(
    { length: 12 },
    () => new FleetManager({ statePath: f.statePath, executor: f.executor }),
  );
  await Promise.all(
    managers.map((manager, i) =>
      manager.addMachine({ name: `host ${i}`, host: `host-${i}` }),
    ),
  );
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(state.machines.length, 13);
  assert.equal(new Set(state.machines.map((machine) => machine.id)).size, 13);
  await assert.rejects(
    f.manager.addMachine({ name: "duplicate", host: "host-0" }),
    { code: "CONFLICT" },
  );
});

test("output overflow reports bounded diagnostic and unknown status", async () => {
  const f = await fixture();
  const agent = await f.manager.start(startInput);
  f.setOutput("a".repeat(300000));
  const result = await f.manager.read(agent.id);
  assert.equal(result.status, "unknown");
  assert.equal(result.output, "");
  assert.equal(result.truncated, true);
});

test("initialization failure preserves recovery record and never blindly kills", async () => {
  const f = await fixture();
  const manager = new FleetManager({
    statePath: f.statePath,
    executor: async (file, args, options) => {
      if (args.includes("@dsh_fleet_owner"))
        throw new Error("cannot set marker");
      return f.executor(file, args, options);
    },
  });
  await assert.rejects(
    manager.start(startInput),
    (error) =>
      error.code === "START_FAILED" &&
      error.message.includes("socket dsh-fleet-") &&
      error.message.includes("session dsh-"),
  );
  const { agents } = await manager.snapshot();
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, "unknown");
  assert.equal(agents[0].diagnostic, "cannot set marker");
  assert.ok(!f.calls.some((call) => call.args.includes("kill-session")));
});

test("session operations use IDs and legacy records resolve through exact pane target", async () => {
  const f = await fixture();
  const agent = await f.manager.start(startInput);
  assert.equal(agent.sessionId, "$0");
  const marker = f.calls.find((call) => call.args.includes("@dsh_fleet_owner"));
  assert.equal(marker.args[marker.args.indexOf("-t") + 1], "$0");
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  delete state.agents[0].sessionId;
  await writeFile(f.statePath, JSON.stringify(state));
  const before = f.calls.length;
  await f.manager.read(agent.id);
  assert.equal(
    f.calls[before].args[f.calls[before].args.indexOf("-t") + 1],
    `=${agent.session}:main`,
  );
  assert.equal((await f.manager.snapshot()).agents[0].sessionId, "$0");
  await f.manager.stop(agent.id);
  assert.equal(f.calls.at(-1).args.at(-1), "$0");
});

test("dsh launches its interactive tui subcommand", async () => {
  const f = await fixture();
  await f.manager.start({ ...startInput, kind: "dsh", args: ["--help"] });
  assert.ok(
    f.calls.some((call) => call.args.at(-1) === "'exec' 'dsh' 'tui' '--help'"),
  );
});

test("local cannot be removed and unused remote can be removed", async () => {
  const f = await fixture();
  await assert.rejects(f.manager.removeMachine("local"), {
    code: "INVALID_INPUT",
  });
  const machine = await f.manager.addMachine({ name: "remote", host: "alias" });
  assert.deepEqual(await f.manager.removeMachine(machine.id), {
    machineId: machine.id,
    removed: true,
  });
});
