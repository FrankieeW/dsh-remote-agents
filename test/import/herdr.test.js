import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../reference/src/core/index.js";
import { parseSSHTarget } from "../reference/src/import/herdr.js";

const profile = (changes = {}) => ({
  id: "a".repeat(32),
  label: "Development",
  target: "dev-alias",
  session: "default",
  enabled: true,
  ...changes,
});
const catalog = (profiles = [profile()]) =>
  JSON.stringify({ version: 1, selected_profile: null, ssh: profiles });
const session = (
  workspaces = [
    { identity_cwd: "/srv/project", custom_name: "Project", tabs: [] },
  ],
) => JSON.stringify({ version: 3, workspaces });
async function fixture({ nested = false, executor } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fleet-import-test-"));
  const statePath = join(
    directory,
    ...(nested ? ["not-created"] : []),
    "state.json",
  );
  let calls = 0;
  const manager = new FleetManager({
    statePath,
    executor:
      executor ??
      (async () => {
        calls++;
        throw new Error("Execution forbidden in static import");
      }),
  });
  return { manager, statePath, directory, calls: () => calls };
}

async function importInput(manager, input) {
  const preview = await manager.previewHerdr(input);
  return manager.importHerdr({ ...input, confirmation: preview.digest });
}

test("preview on nonexistent state is fully read-only, stable, and never executes", async () => {
  const f = await fixture({ nested: true });
  const input = {
    machinesText: catalog(),
    sessionText: session(),
    projectMachineId: "local",
  };
  const preview = await f.manager.previewHerdr(input);
  assert.deepEqual(preview.summary, {
    machines: 1,
    projects: 1,
    duplicates: 0,
  });
  assert.equal((await f.manager.previewHerdr(input)).digest, preview.digest);
  await assert.rejects(access(join(f.directory, "not-created")), {
    code: "ENOENT",
  });
  assert.equal(f.calls(), 0);
  const imported = await f.manager.importHerdr({
    ...input,
    confirmation: preview.digest,
  });
  assert.deepEqual(imported.imported, { machines: 1, projects: 1 });
  const state = await f.manager.snapshot();
  assert.equal(state.projects[0].machineId, "local");
  assert.equal(state.projects[0].source, "herdr");
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  assert.equal(f.calls(), 0);
});

test("credentials, commands, native sessions and histories never enter result or state", async () => {
  const f = await fixture();
  const secret = "DO_NOT_COPY_SECRET_123";
  const input = {
    machinesText: catalog([
      profile({
        password: secret,
        command: secret,
        env: { TOKEN: secret },
        nativeSession: secret,
      }),
    ]),
    sessionText: session([
      {
        identity_cwd: "/safe/project",
        custom_name: "Safe",
        agent_resume: secret,
        launch_argv: [secret],
        agent_session: secret,
        secret,
        tabs: [{ panes: { 0: { cwd: "/must-not-import", history: secret } } }],
      },
    ]),
    projectMachineId: "local",
  };
  const result = await importInput(f.manager, input);
  assert.ok(!JSON.stringify(result).includes(secret));
  const stored = await readFile(f.statePath, "utf8");
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes("/must-not-import"));
  assert.ok(!stored.includes("nativeSession"));
  assert.equal(f.calls(), 0);
});

test("session mapping is explicit and cannot reference a newly imported machine", async () => {
  const f = await fixture({ nested: true });
  for (const projectMachineId of [undefined, "", "not-existing"]) {
    await assert.rejects(
      f.manager.previewHerdr({
        machinesText: catalog(),
        sessionText: session(),
        projectMachineId,
      }),
      { code: "INVALID_IMPORT" },
    );
  }
  await assert.rejects(access(join(f.directory, "not-created")), {
    code: "ENOENT",
  });
});

test("structured SSH targets preserve user and port; reject options, passwords, commands and URI extras", () => {
  assert.deepEqual(parseSSHTarget("alias"), { host: "alias" });
  assert.deepEqual(parseSSHTarget("alice@dev.example"), {
    host: "dev.example",
    user: "alice",
  });
  assert.deepEqual(parseSSHTarget("ssh://alice@dev.example:2222"), {
    host: "dev.example",
    user: "alice",
    port: 2222,
  });
  assert.deepEqual(parseSSHTarget("ssh://alice@[2001:db8::1]:2200"), {
    host: "2001:db8::1",
    user: "alice",
    port: 2200,
  });
  for (const bad of [
    "-oProxyCommand=evil",
    "host;rm",
    "user@host command",
    "ssh://user:password@host",
    "ssh://host/path",
    "ssh://host?x=1",
    "ssh://host#x",
    "ssh://host:0",
    "ssh://host:65536",
    "ssh://%61@host",
    "a\nb",
    "a\u001bb",
    "a@b@c",
    "ssh://-host",
    "user@host:2222",
  ])
    assert.equal(parseSSHTarget(bad), null, bad);
});

test("imported SSH user and port use dedicated argv options", async () => {
  const calls = [];
  const f = await fixture({
    executor: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "tmux 3.4" };
    },
  });
  await importInput(f.manager, {
    machinesText: catalog([profile({ target: "ssh://alice@host:2222" })]),
  });
  assert.equal(calls.length, 0);
  const machine = (await f.manager.snapshot()).machines.find(
    (item) => item.type === "ssh",
  );
  await f.manager.probe(machine.id);
  assert.equal(calls[0].file, "ssh");
  const args = calls[0].args;
  assert.equal(args[args.indexOf("-l") + 1], "alice");
  assert.equal(args[args.indexOf("-p") + 1], "2222");
  assert.equal(args[args.indexOf("--") + 1], "host");
});

test("deduplicates connection primitives, warns about native sessions, and is idempotent after re-preview", async () => {
  const f = await fixture();
  const input = {
    machinesText: catalog([
      profile(),
      profile({ id: "b".repeat(32), session: "other", label: "Other" }),
      profile({ id: "c".repeat(32), target: "other-user@dev-alias" }),
    ]),
    sessionText: session(),
    projectMachineId: "local",
  };
  const first = await importInput(f.manager, input);
  assert.deepEqual(first.summary, { machines: 2, projects: 1, duplicates: 1 });
  assert.ok(
    first.warnings.some((item) =>
      item.includes("session selection is not migrated"),
    ),
  );
  const second = await importInput(f.manager, input);
  assert.deepEqual(second.imported, { machines: 0, projects: 0 });
  assert.equal(second.summary.duplicates, 4);
  assert.equal((await f.manager.snapshot()).machines.length, 3);
  assert.equal((await f.manager.snapshot()).projects.length, 1);
});

test("stale digest and changed payload are rejected without changing business state", async () => {
  const f = await fixture();
  const input = { machinesText: catalog() };
  const preview = await f.manager.previewHerdr(input);
  await f.manager.addMachine({ name: "Other", host: "other" });
  const before = await readFile(f.statePath, "utf8");
  await assert.rejects(
    f.manager.importHerdr({ ...input, confirmation: preview.digest }),
    { code: "STALE_PREVIEW" },
  );
  assert.equal(await readFile(f.statePath, "utf8"), before);
  const current = await f.manager.previewHerdr(input);
  await assert.rejects(
    f.manager.importHerdr({
      machinesText: catalog([profile({ target: "different" })]),
      confirmation: current.digest,
    }),
    { code: "STALE_PREVIEW" },
  );
  assert.equal(await readFile(f.statePath, "utf8"), before);
});

test("parallel import confirmation applies exactly once under shared file lock", async () => {
  const f = await fixture();
  const second = new FleetManager({
    statePath: f.statePath,
    executor: async () => {
      throw new Error("Forbidden");
    },
  });
  const input = { machinesText: catalog() };
  const preview = await f.manager.previewHerdr(input);
  const results = await Promise.allSettled([
    f.manager.importHerdr({ ...input, confirmation: preview.digest }),
    second.importHerdr({ ...input, confirmation: preview.digest }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "STALE_PREVIEW",
  );
  assert.equal((await f.manager.snapshot()).machines.length, 2);
});

test("invalid combined import is atomic and does not import otherwise valid machines", async () => {
  const f = await fixture();
  await f.manager.snapshot();
  const before = await readFile(f.statePath, "utf8");
  await assert.rejects(
    f.manager.importHerdr({
      machinesText: catalog(),
      sessionText: "{",
      projectMachineId: "local",
      confirmation: "x",
    }),
    { code: "INVALID_IMPORT" },
  );
  assert.equal(await readFile(f.statePath, "utf8"), before);
});

test("legacy state gets projects in memory without preview writing it, then migrates on import", async () => {
  const f = await fixture();
  await f.manager.snapshot();
  const legacy = JSON.parse(await readFile(f.statePath, "utf8"));
  delete legacy.projects;
  await writeFile(f.statePath, JSON.stringify(legacy));
  const before = await readFile(f.statePath, "utf8");
  const input = { sessionText: session(), projectMachineId: "local" };
  const preview = await f.manager.previewHerdr(input);
  assert.equal(await readFile(f.statePath, "utf8"), before);
  await f.manager.importHerdr({ ...input, confirmation: preview.digest });
  assert.equal(
    JSON.parse(await readFile(f.statePath, "utf8")).projects.length,
    1,
  );
});

test("fallback reads only direct numeric pane entries, deduplicates, and warns", async () => {
  const f = await fixture();
  const input = {
    sessionText: session([
      {
        custom_name: "Fallback",
        tabs: [
          {
            panes: {
              0: { cwd: "/a", nested: { cwd: "/nested" } },
              1: { cwd: "/b" },
              2: { cwd: "/a" },
              named: { cwd: "/wrong-key" },
            },
          },
        ],
      },
      {
        identity_cwd: "/identity",
        tabs: [{ panes: { 0: { cwd: "/ignored" } } }],
      },
    ]),
    projectMachineId: "local",
  };
  const preview = await f.manager.previewHerdr(input);
  assert.deepEqual(
    preview.projects.map((item) => item.cwd),
    ["/a", "/b", "/a", "/identity"],
  );
  assert.deepEqual(preview.summary, {
    machines: 0,
    projects: 3,
    duplicates: 1,
  });
  assert.ok(
    preview.warnings.some((item) =>
      item.includes("independent project candidates"),
    ),
  );
  assert.ok(!JSON.stringify(preview).includes("/nested"));
});

test("disabled, invalid and unsupported records skip with sanitized warnings", async () => {
  const f = await fixture();
  const preview = await f.manager.previewHerdr({
    machinesText: catalog([
      profile({ enabled: false }),
      profile({ target: "SECRET;command" }),
      profile({ id: "bad" }),
      profile({ session: ".." }),
    ]),
    sessionText: session([
      { identity_cwd: "~/relative" },
      { identity_cwd: "/bad\npath" },
      { identity_cwd: "/good" },
    ]),
    projectMachineId: "local",
  });
  assert.deepEqual(preview.summary, {
    machines: 0,
    projects: 1,
    duplicates: 0,
  });
  assert.ok(preview.warnings.length >= 6);
  assert.ok(!JSON.stringify(preview).includes("SECRET"));
});

test("strict root/version and 1 MiB UTF8 limits reject malformed imports", async () => {
  const f = await fixture();
  for (const machinesText of [
    "[]",
    "null",
    "",
    "{",
    '{"version":2,"ssh":[]}',
    '{"version":1,"ssh":{}}',
    "é".repeat(524289),
  ])
    await assert.rejects(f.manager.previewHerdr({ machinesText }), {
      code: "INVALID_IMPORT",
    });
  for (const version of [undefined, 2, 4, "3"])
    await assert.rejects(
      f.manager.previewHerdr({
        sessionText: JSON.stringify({ version, workspaces: [] }),
        projectMachineId: "local",
      }),
      { code: "INVALID_IMPORT" },
    );
  await assert.rejects(f.manager.previewHerdr({}), { code: "INVALID_IMPORT" });
});

test("read-only list never initializes the state directory", async () => {
  const f = await fixture({ nested: true });
  const state = await f.manager.snapshot({ readOnly: true });
  assert.deepEqual(state.projects, []);
  assert.equal(state.machines[0].id, "local");
  await assert.rejects(access(join(f.directory, "not-created")), {
    code: "ENOENT",
  });
  await assert.rejects(f.manager.snapshot({ readOnly: "true" }), {
    code: "INVALID_INPUT",
  });
});

test("digest binds source-only changes and excludes unrelated agent lifecycle state", async () => {
  const f = await fixture();
  await f.manager.snapshot();
  const input = {
    machinesText: catalog([profile({ password: "old-secret" })]),
  };
  const preview = await f.manager.previewHerdr(input);
  const changed = {
    machinesText: catalog([profile({ password: "new-secret" })]),
  };
  assert.notEqual(
    (await f.manager.previewHerdr(changed)).digest,
    preview.digest,
  );
  await assert.rejects(
    f.manager.importHerdr({ ...changed, confirmation: preview.digest }),
    { code: "STALE_PREVIEW" },
  );
  const state = JSON.parse(await readFile(f.statePath, "utf8"));
  state.agents.push({
    id: "12345678-1234-1234-1234-123456789abc",
    machineId: "local",
    owner: "12345678-1234-1234-1234-123456789def",
    session: "dsh-test-12345678123412341234123456789abc",
    kind: "shell",
    status: "unknown",
  });
  await writeFile(f.statePath, JSON.stringify(state));
  assert.equal((await f.manager.previewHerdr(input)).digest, preview.digest);
  const result = await f.manager.importHerdr({
    ...input,
    confirmation: preview.digest,
  });
  assert.equal(result.importedMachineIds.length, 1);
  const snapshot = await f.manager.snapshot({ readOnly: true });
  assert.equal(snapshot.machines[1].id, result.importedMachineIds[0]);
});

test("imported project mapping prevents machine removal", async () => {
  const f = await fixture();
  const machine = await f.manager.addMachine({ name: "Remote", host: "alias" });
  await importInput(f.manager, {
    sessionText: session(),
    projectMachineId: machine.id,
  });
  await assert.rejects(f.manager.removeMachine(machine.id), {
    code: "CONFLICT",
  });
  assert.equal((await f.manager.snapshot()).projects[0].machineId, machine.id);
});
