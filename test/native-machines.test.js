import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeBackend } from "../src/native/client.js";
import { installFakeSsh } from "./helpers/fake-ssh.js";

const fake = await installFakeSsh();
after(() => fake.remove());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const available = (program) => {
  try {
    execFileSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const hasTmux = available("tmux");
const hasPerl = available("perl");
// macOS accounts default to zsh; without its startup files, for hermetic runs.
if (available("zsh")) process.env.FAKE_LOGIN_SHELL = "zsh -f";

/** Stops the isolated tmux server of one fleet namespace and removes its socket. */
async function killTmux(namespace) {
  const socket = `dsh-fleet-${namespace}`;
  try {
    const path = execFileSync("tmux", ["-L", socket, "display-message", "-p", "#{socket_path}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    if (path) await rm(path, { force: true });
  } catch {
    // No server is running for this namespace.
  }
}

async function fixture(t, { base = tmpdir(), ...options } = {}) {
  const root = await mkdtemp(join(base, "dsh-machines-"));
  const statePath = join(root, "state", "fleet.json");
  const config = {
    statePath,
    codexExecutable: fake.codex,
    claudeExecutable: join(root, "missing-claude"),
    ompExecutable: join(root, "missing-omp"),
    ...options,
  };
  let backend = new NativeBackend(config);
  const namespace = async () => JSON.parse(await readFile(statePath, "utf8")).namespace;
  t.after(async () => {
    await backend.close();
    if (hasTmux) await killTmux(await namespace().catch(() => "none"));
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    statePath,
    namespace,
    call: (method, params = {}) => backend.request(method, params),
    /** A fresh backend process, with empty in-memory caches. */
    async restart() {
      await backend.close();
      backend = new NativeBackend(config);
    },
  };
}
/** Resolves once `check(snapshot)` holds, polling the backend. */
async function until(f, check) {
  for (let i = 0; i < 200; i++) {
    if (check(await f.call("snapshot"))) return;
    await wait(25);
  }
  throw new Error("Condition was not reached");
}
async function timed(promise) {
  const start = Date.now();
  await promise.catch(() => {});
  return Date.now() - start;
}

test("SSH destinations accept user@host and ssh:// forms and deduplicate host names case-insensitively", async (t) => {
  const f = await fixture(t);
  const a = await f.call("addMachine", { name: "A", target: "alice@loop-a1" });
  assert.deepEqual([a.host, a.user, a.port], ["loop-a1", "alice", undefined]);
  const b = await f.call("addMachine", { target: "ssh://bob@[::1]:2222" });
  assert.deepEqual([b.host, b.user, b.port, b.name], ["::1", "bob", 2222, "bob@[::1]:2222"]);
  assert.equal((await f.call("addMachine", { target: "LOOP-A1:2200" })).port, 2200);
  await assert.rejects(f.call("addMachine", { name: "dup", target: "alice@LOOP-A1" }), { code: "CONFLICT" });
  await assert.rejects(f.call("addMachine", { name: "dup", host: "Loop-A1", user: "alice" }), { code: "CONFLICT" });
  for (const target of ["-oProxyCommand=x", "a b", "user@host/path", "ssh://u:p@host", "host;rm", ""])
    await assert.rejects(f.call("addMachine", { target }), { code: "INVALID_INPUT" }, target);
  await f.call("probe", { machineId: a.id });
  assert.ok((await fake.log()).some((line) => line.includes("-l alice -- loop-a1")));
});

test("connection tests report SSH, tmux and CLI checks separately with actionable SSH errors", async (t) => {
  const f = await fixture(t);
  const expected = { "keyfail-2": "HOST_KEY", "changed-2": "HOST_KEY_CHANGED", "denied-2": "AUTH", "nowhere-2": "DNS" };
  for (const [host, code] of Object.entries(expected)) {
    const machine = await f.call("addMachine", { target: host });
    const result = await f.call("probe", { machineId: machine.id });
    assert.equal(result.ok, false, host);
    assert.equal(result.ssh.code, code, host);
    assert.doesNotMatch(result.error, /CLI command failed/, host);
  }
  const stored = (await f.call("snapshot")).machines.find((m) => m.host === "keyfail-2");
  assert.equal(stored.lastCheck.ok, false);
  assert.match(stored.lastCheck.message, /ssh keyfail-2/);
  const notmux = await f.call("addMachine", { target: "notmux-2" });
  const result = await f.call("probe", { machineId: notmux.id });
  assert.deepEqual([result.ok, result.ssh.ok, result.tmux.ok, result.tmux.code], [true, true, false, "NOT_FOUND"]);
  assert.equal(result.clis.find((cli) => cli.id === "codex").available, true);
  assert.equal((await f.call("probe", { machineId: "local" })).ok, true);
});

test("a slow machine never delays other machines, sends or Stop", async (t) => {
  const f = await fixture(t);
  const slow = await f.call("addMachine", { target: "slow-3" });
  const loop = await f.call("addMachine", { target: "loop-3" });
  const session = await f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: loop.id });
  await f.call("chatList");
  const probe = f.call("probe", { machineId: slow.id });
  await wait(200);
  const timings = await Promise.all([
    timed(f.call("snapshot")),
    timed(f.call("chatList")),
    timed(f.call("workspaceBrowse", { machineId: "local", path: `${f.root}/` })),
    timed(f.call("chatSend", { id: session.id, text: "WAIT", requestId: "r1" })),
    timed(f.call("chatInterrupt", { id: "unrelated-session" })),
    timed(f.call("addMachine", { target: "loop-3b" })),
  ]);
  for (const ms of timings) assert.ok(ms < 1500, `operation waited ${ms}ms for the slow machine`);
  assert.equal((await probe).ssh.code, "TIMEOUT");
  await f.call("chatInterrupt", { id: session.id });
});

test("removing a machine keeps its conversations recoverable and re-adding restores them", async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { name: "Build", target: "loop-4" });
  const session = await f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: machine.id });
  await f.call("chatSend", { id: session.id, text: "WAIT", requestId: "w1" });
  await assert.rejects(f.call("removeMachine", { machineId: machine.id }), { code: "BUSY" });
  await f.call("chatInterrupt", { id: session.id });
  const removed = await f.call("removeMachine", { machineId: machine.id });
  assert.deepEqual([removed.removed, removed.retained, removed.sessions], [true, true, 1]);
  assert.ok((await f.call("snapshot")).machines.find((m) => m.id === machine.id).removedAt);
  assert.ok((await f.call("workspaceCatalog")).machines.some((m) => m.id === machine.id && m.removedAt));
  await assert.rejects(f.call("chatSend", { id: session.id, text: "again", requestId: "w2" }), { code: "MACHINE_REMOVED" });
  await assert.rejects(f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: machine.id }), { code: "MACHINE_REMOVED" });
  const again = await f.call("addMachine", { name: "Build again", target: "LOOP-4" });
  assert.deepEqual([again.id, again.restored, again.removedAt, again.name], [machine.id, true, undefined, "Build again"]);
  await f.call("chatOptions", { id: session.id });
  await f.call("removeMachine", { machineId: machine.id });
  assert.equal((await f.call("restoreMachine", { machineId: machine.id })).removedAt, undefined);
  const bare = await f.call("addMachine", { target: "loop-4b" });
  assert.equal((await f.call("removeMachine", { machineId: bare.id })).retained, false);
  assert.equal((await f.call("snapshot")).machines.some((m) => m.id === bare.id), false);
});

test("Stop clears records whose session vanished and Forget releases unreachable machines", { skip: !hasTmux }, async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { target: "loop-5" });
  const gone = await f.call("start", { machineId: machine.id, name: "gone", cwd: f.root, kind: "shell" });
  assert.equal(gone.status, "running");
  await killTmux(await f.namespace());
  const read = await f.call("read", { agentId: gone.id });
  assert.equal(read.status, "exited");
  assert.match(read.diagnostic, /no longer exists/);
  const stopped = await f.call("stop", { agentId: gone.id });
  assert.ok(stopped.stoppedAt);
  const stranded = await f.call("start", { machineId: machine.id, name: "stranded", cwd: f.root, kind: "shell" });
  await fake.down("loop-5");
  t.after(() => fake.up("loop-5"));
  await assert.rejects(f.call("stop", { agentId: stranded.id }), { code: "UNREACHABLE", message: /refused/i });
  await assert.rejects(f.call("removeMachine", { machineId: machine.id }), { code: "CONFLICT", message: /stranded/ });
  await assert.rejects(f.call("forgetAgent", { agentId: stranded.id }), { code: "CONFLICT" });
  assert.deepEqual(await f.call("forgetAgent", { agentId: stranded.id, force: true }), { agentId: stranded.id, forgotten: true });
  assert.equal((await f.call("removeMachine", { machineId: machine.id })).removed, true);
});

test("a crashed or stale writer never leaves machines locked", { skip: !hasPerl }, async (t) => {
  const f = await fixture(t);
  await f.call("addMachine", { target: "loop-6" });
  await writeFile(join(f.root, "state", "fleet.json.lock"), "");
  await f.call("addMachine", { target: "loop-6b" });
  const holder = spawn("perl", ["-e", 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "locked\\n"; sleep 60', join(f.root, "state", "fleet.json.writer.lock")]);
  t.after(() => holder.kill("SIGKILL"));
  await once(holder.stdout, "data");
  await assert.rejects(f.call("addMachine", { target: "loop-6c" }), { code: "STATE_LOCKED" });
  holder.kill("SIGKILL");
  await once(holder, "exit");
  assert.equal((await f.call("addMachine", { target: "loop-6c" })).host, "loop-6c");
});

test("machines can be renamed and repointed without losing conversations", async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { name: "Old", target: "loop-7" });
  await f.call("addMachine", { target: "loop-7-other" });
  const session = await f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: machine.id });
  assert.equal((await f.call("updateMachine", { machineId: machine.id, name: "Renamed" })).name, "Renamed");
  await assert.rejects(f.call("updateMachine", { machineId: machine.id, target: "LOOP-7-OTHER" }), { code: "CONFLICT" });
  await assert.rejects(f.call("updateMachine", { machineId: "local", target: "loop-x" }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call("updateMachine", { machineId: machine.id, name: "   " }), { code: "INVALID_INPUT" });
  await f.call("chatSend", { id: session.id, text: "WAIT", requestId: "u1" });
  await assert.rejects(f.call("updateMachine", { machineId: machine.id, target: "loop-7b" }), { code: "BUSY" });
  await f.call("chatInterrupt", { id: session.id });
  const moved = await f.call("updateMachine", { machineId: machine.id, target: "carol@loop-7b:2201" });
  assert.deepEqual([moved.id, moved.host, moved.user, moved.port, moved.name], [machine.id, "loop-7b", "carol", 2201, "Renamed"]);
  await f.call("chatOptions", { id: session.id, refresh: true });
  assert.ok((await fake.log()).some((line) => line.includes("-l carol -p 2201 -- loop-7b")));
  const cleared = await f.call("updateMachine", { machineId: machine.id, target: "loop-7b" });
  assert.deepEqual([cleared.user, cleared.port], [undefined, undefined]);
});

test("verified adds save only reachable machines unless saved anyway", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call("addMachine", { target: "keyfail-8", verify: true }), { code: "HOST_KEY", message: /ssh keyfail-8/ });
  assert.equal((await f.call("snapshot")).machines.length, 1);
  assert.equal((await f.call("addMachine", { target: "keyfail-8", verify: false })).host, "keyfail-8");
  assert.equal((await f.call("addMachine", { target: "loop-8", verify: true })).lastCheck.ok, true);
});

test("conversations need the string id of an active machine", async (t) => {
  const f = await fixture(t);
  for (const machineId of [null, 7, ["local"]])
    await assert.rejects(f.call("chatCreate", { provider: "codex", cwd: f.root, machineId }), { code: "INVALID_INPUT" });
  await assert.rejects(f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: "missing" }), { code: "NOT_FOUND" });
});

test("registered workspaces block machine removal with a precise message", async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { target: "loop-10" });
  const workspace = await f.call("workspaceAdd", { machineId: machine.id, path: f.root });
  await assert.rejects(f.call("removeMachine", { machineId: machine.id }), { code: "CONFLICT", message: new RegExp(workspace.name) });
  await f.call("workspaceRemove", { workspaceId: workspace.id });
  assert.equal((await f.call("removeMachine", { machineId: machine.id })).retained, false);
});

test("Herdr import treats removed machines as duplicates and refuses them as project targets", async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { target: "loop-11" });
  await f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: machine.id });
  await f.call("removeMachine", { machineId: machine.id });
  const machinesText = JSON.stringify({ version: 1, ssh: [{ id: "b".repeat(32), label: "Again", session: "s", enabled: true, target: "LOOP-11" }] });
  const preview = await f.call("previewHerdr", { machinesText });
  assert.equal(preview.machines[0].action, "duplicate");
  assert.ok(preview.warnings.some((warning) => /removed/.test(warning)));
  await assert.rejects(f.call("previewHerdr", { sessionText: JSON.stringify({ version: 3, workspaces: [] }), projectMachineId: machine.id }), { code: "INVALID_IMPORT" });
});

test("slow remote work never acts on a machine that was removed or re-pointed meanwhile", async (t) => {
  const f = await fixture(t);
  const removed = await f.call("addMachine", { target: "lag-12" });
  const creating = f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: removed.id });
  await wait(200);
  assert.equal((await f.call("removeMachine", { machineId: removed.id })).retained, false);
  await assert.rejects(creating, { code: "NOT_FOUND" });
  assert.equal((await f.call("chatList")).sessions.some((s) => s.machineId === removed.id), false);

  const probed = await f.call("addMachine", { target: "lag-13" });
  const probing = f.call("probe", { machineId: probed.id });
  await wait(200);
  await f.call("updateMachine", { machineId: probed.id, target: "loop-13b" });
  assert.equal((await probing).ok, true);
  assert.equal((await f.call("snapshot")).machines.find((m) => m.id === probed.id).lastCheck, undefined, "an old address's result is not recorded");

  const moved = await f.call("addMachine", { target: "lag-14" });
  const session = await f.call("chatCreate", { provider: "codex", cwd: f.root, machineId: moved.id });
  await f.restart();
  const sending = f.call("chatSend", { id: session.id, text: "WAIT", requestId: "race" });
  await wait(200);
  await f.call("updateMachine", { machineId: moved.id, target: "loop-14b" });
  await assert.rejects(sending, { code: "CONFLICT" });
  assert.equal((await f.call("chatGet", { id: session.id })).status, "idle");
});

test("terminal starts hold their record and notice address changes", { skip: !hasTmux }, async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { target: "lag-15" });
  const starting = f.call("start", { machineId: machine.id, name: "moved", cwd: f.root, kind: "shell" });
  await wait(200);
  await f.call("updateMachine", { machineId: machine.id, target: "loop-15b" });
  await assert.rejects(starting, { code: "CONFLICT" });
  assert.equal((await f.call("snapshot")).agents.length, 0);

  const other = await f.call("addMachine", { target: "lag-16" });
  const started = f.call("start", { machineId: other.id, name: "held", cwd: f.root, kind: "shell" });
  await until(f, (state) => state.agents.length === 1);
  const agentId = (await f.call("snapshot")).agents[0].id;
  const forgetting = f.call("forgetAgent", { agentId, force: true });
  assert.equal((await started).status, "running", "creation completes before another operation on its record");
  assert.deepEqual(await forgetting, { agentId, forgotten: true });
});

test("connection reuse is opt-in and keeps its sockets in a private directory", async (t) => {
  const plain = await fixture(t);
  await plain.call("probe", { machineId: (await plain.call("addMachine", { target: "loop-17a" })).id });
  assert.ok((await fake.log()).filter((line) => line.includes("-- loop-17a")).every((line) => !line.includes("ControlMaster")));
  // Unix socket paths are short; a short state directory keeps the sockets inside it.
  const shared = await fixture(t, { base: "/tmp", sshMultiplexing: true });
  await shared.call("probe", { machineId: (await shared.call("addMachine", { target: "loop-17b" })).id });
  const lines = (await fake.log()).filter((line) => line.includes("-- loop-17b"));
  const dir = join(shared.root, "state", "ssh");
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.match(line, /-o ControlMaster=auto -o ControlPath=(\S+) -o ControlPersist=60/);
    assert.match(line.match(/ControlPath=(\S+)/)[1], new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{16}$`));
  }
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("remote commands work whatever the account's login shell is", { skip: !available("zsh") }, async (t) => {
  const f = await fixture(t);
  const machine = await f.call("addMachine", { target: "loop-18" });
  const listing = await f.call("workspaceBrowse", { machineId: machine.id, path: `${f.root}/` });
  assert.ok(listing.entries.some((entry) => entry.name === "state"), JSON.stringify(listing));
  assert.equal((await f.call("probe", { machineId: machine.id })).ok, true);
});
