import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  mkdir,
  stat,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { NativeBackend } from "../src/native/client.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-tests-"));
  const make = async (name, source) => {
    const file = join(root, name);
    await writeFile(file, "#!" + process.execPath + "\n" + source, {
      mode: 0o700,
    });
    await chmod(file, 0o700);
    return file;
  };
  const codex = await make(
    "codex",
    await readFile("scripts/fixtures/codex-process.cjs", "utf8"),
  );
  const omp = await make(
    "omp",
    await readFile("scripts/fixtures/omp-process.cjs", "utf8"),
  );
  const claude = await make("claude", "console.log('2.1.318')");
  const config = {
    statePath: join(root, "state", "fleet.json"),
    codexExecutable: codex,
    ompExecutable: omp,
    claudeExecutable: claude,
    claudeBridge: resolve("scripts/fixtures/claude-bridge.cjs"),
  };
  let backend = new NativeBackend(config);
  t.after(async () => {
    await backend.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    config,
    get backend() {
      return backend;
    },
    call: (...args) => backend.request(...args),
    async restart() {
      await backend.close();
      backend = new NativeBackend(config);
    },
  };
}
async function settled(f, id, status = "idle") {
  for (let i = 0; i < 300; i++) {
    const s = await f.call("chatGet", { id });
    if (s.status === status) return s;
    if (s.status === "error" && status !== "error") throw Error(s.error);
    await wait(10);
  }
  throw Error("Native turn timed out");
}

for (const provider of ["codex", "omp", "claude"])
  test(`Rust ${provider}: real protocol process, text, approval, interrupt and owned resume`, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.call("health")).backend, "rust");
    const session = await f.call("chatCreate", { provider, cwd: f.root });
    let result = await f.call("chatSend", {
      id: session.id,
      text: "hello",
      requestId: "one",
    });
    assert.equal(result.accepted, true);
    let done = await settled(f, session.id);
    assert.match(
      done.messages.at(-1).text,
      provider === "codex"
        ? /PACKAGED_OK/
        : provider === "omp"
          ? /OMP_NATIVE_OK/
          : /CLAUDE_NATIVE_OK/,
    );
    if (provider !== "claude")
      assert.equal(done.messages.at(-1).tools.length, 1);
    const nativeId = done.providerSessionId;
    assert.equal(
      (
        await f.call("chatSend", {
          id: session.id,
          text: "hello",
          requestId: "one",
        })
      ).duplicate,
      true,
    );
    await assert.rejects(
      f.call("chatSend", {
        id: session.id,
        text: "different",
        requestId: "one",
      }),
      { code: "CONFLICT" },
    );
    await f.call("chatSend", {
      id: session.id,
      text: "APPROVAL",
      requestId: "two",
    });
    const pending = await settled(f, session.id, "waiting");
    assert.equal(pending.pendingApprovals.length, 1);
    await assert.rejects(
      f.call("chatApprove", {
        id: "foreign",
        approvalId: pending.pendingApprovals[0].id,
        allow: true,
      }),
    );
    await f.call("chatApprove", {
      id: session.id,
      approvalId: pending.pendingApprovals[0].id,
      allow: false,
    });
    done = await settled(f, session.id);
    assert.match(done.messages.at(-1).text, /DENIED|DECISION_decline/);
    await assert.rejects(
      f.call("chatApprove", {
        id: session.id,
        approvalId: pending.pendingApprovals[0].id,
        allow: true,
      }),
      { code: "APPROVAL_NOT_FOUND" },
    );
    await f.call("chatSend", {
      id: session.id,
      text: "WAIT",
      requestId: "three",
    });
    await f.call("chatInterrupt", { id: session.id });
    await f.restart();
    assert.equal(
      (await f.call("chatGet", { id: session.id })).status,
      "interrupted",
    );
    await f.call("chatSend", {
      id: session.id,
      text: "resume",
      requestId: "four",
    });
    done = await settled(f, session.id);
    assert.equal(done.providerSessionId, nativeId);
    assert.equal(done.messages.length, 8);
  });

test("Rust settings, metadata, exports and data ownership persist across restart", async (t) => {
  const f = await fixture(t);
  const s = await f.call("chatCreate", { provider: "codex", cwd: f.root });
  await f.call("chatConfigure", {
    id: s.id,
    patch: { permissions: "read-only" },
    expectedRevision: 0,
  });
  await assert.rejects(
    f.call("chatConfigure", {
      id: s.id,
      patch: { model: "stale" },
      expectedRevision: 0,
    }),
    { code: "CONFLICT" },
  );
  await f.call("chatConfigure", {
    id: s.id,
    patch: { effort: "low" },
    expectedRevision: 1,
  });
  await f.call("chatMetadata", {
    id: s.id,
    name: "Native history",
    pinned: true,
  });
  await f.call("chatSend", { id: s.id, text: "hello", requestId: "one" });
  await settled(f, s.id);
  await f.call("chatMetadata", { id: s.id, archived: true });
  const exported = JSON.parse(
    (await f.call("chatExport", { id: s.id, format: "json" })).content,
  );
  assert.equal(exported.requests, undefined);
  assert.equal(exported.providerSessionId, undefined);
  assert.equal(
    (await f.call("chatSearch", { query: "PACKAGED_OK" }))[0].id,
    s.id,
  );
  const other = new NativeBackend(f.config);
  try {
    await assert.rejects(other.request("chatGet", { id: s.id }), {
      code: "STATE_LOCKED",
    });
  } finally {
    await other.close();
  }
  await f.restart();
  const restored = await f.call("chatGet", { id: s.id });
  assert.deepEqual(restored.settings, {
    model: null,
    effort: "low",
    permissions: "read-only",
  });
  assert.equal(restored.name, "Native history");
  assert.equal(restored.pinned, true);
  assert.equal(restored.archived, true);
  assert.equal(
    (await stat(join(f.root, "state", "conversations.json"))).mode & 0o777,
    0o600,
  );
});

test("Rust fleet preview stays read-only, atomic import binds exact sources and rejects unsafe hosts", async (t) => {
  const f = await fixture(t);
  await f.call("snapshot");
  await assert.rejects(access(join(f.root, "state")), { code: "ENOENT" });
  for (const host of ["-oProxyCommand=bad", "user@host", "host;bad"])
    await assert.rejects(f.call("addMachine", { name: "bad", host }));
  const input = {
    machinesText: JSON.stringify({
      version: 1,
      ssh: [
        {
          id: "a".repeat(32),
          label: "Remote",
          session: "dev",
          enabled: true,
          target: "ssh://dev@server.example:2222",
          password: "PRIVATE",
        },
      ],
    }),
  };
  const preview = await f.call("previewHerdr", input);
  assert.equal(preview.summary.machines, 1);
  assert.ok(!JSON.stringify(preview).includes("PRIVATE"));
  await assert.rejects(
    f.call("importHerdr", { ...input, confirmation: "0".repeat(64) }),
    { code: "STALE_PREVIEW" },
  );
  const imported = await f.call("importHerdr", {
    ...input,
    confirmation: preview.digest,
  });
  assert.equal(imported.imported.machines, 1);
  const snapshot = await f.call("snapshot");
  assert.equal(snapshot.machines[1].user, "dev");
  assert.equal(snapshot.machines[1].port, 2222);
  await assert.rejects(
    f.call("importHerdr", { ...input, confirmation: preview.digest }),
    { code: "STALE_PREVIEW" },
  );
});

test("Rust OMP history indexes more than 16 tools and never returns provider credentials", async (t) => {
  const f = await fixture(t);
  await f.backend.close();
  const stateDir = join(f.root, "state");
  const sid = "owned-app",
    native = "owned-native",
    messageId = "reply";
  await mkdir(join(stateDir, "omp-sessions", sid), { recursive: true });
  const session = {
    id: sid,
    provider: "omp",
    providerSessionId: native,
    machineId: "local",
    cwd: f.root,
    name: "Original history",
    status: "idle",
    settings: { model: null, effort: null, permissions: "cli" },
    messages: [
      {
        id: messageId,
        role: "assistant",
        text: "preview",
        tools: [],
        toolsTruncated: true,
      },
    ],
    requests: [
      {
        requestId: "one",
        assistantMessageId: messageId,
        textHash: createHash("sha256").update("hello").digest("hex"),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(
    join(stateDir, "conversations.json"),
    JSON.stringify({ version: 1, sessions: [session] }),
  );
  const rows = [{ type: "session", id: native, cwd: f.root }];
  let parent = null;
  const add = (message) => {
    const id = "entry-" + rows.length;
    rows.push({ type: "message", id, parentId: parent, message });
    parent = id;
  };
  add({ role: "user", content: [{ type: "text", text: "hello" }] });
  for (let i = 0; i < 21; i++) {
    add({
      role: "assistant",
      credentialId: "PRIVATE",
      providerPayload: { secret: "PRIVATE" },
      content: [
        {
          type: "toolCall",
          id: "tool-" + i,
          name: "read",
          arguments: { path: "file" },
        },
      ],
    });
    add({
      role: "toolResult",
      toolCallId: "tool-" + i,
      content: [{ type: "text", text: "x".repeat(10000) }],
    });
  }
  await writeFile(
    join(stateDir, "omp-sessions", sid, "test_" + native + ".jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  await f.restart();
  const page = await f.call("chatOmpHistory", { id: sid, messageId });
  assert.equal(page.totalTools, 21);
  assert.equal(page.tools.length, 16);
  assert.equal(page.hasMore, true);
  assert.ok(!JSON.stringify(page).includes("PRIVATE"));
  const next = await f.call("chatOmpHistory", {
    id: sid,
    messageId,
    offset: 16,
  });
  assert.equal(next.tools.length, 5);
  const tool = await f.call("chatOmpHistory", {
    id: sid,
    messageId,
    toolId: "tool-0",
  });
  assert.equal(tool.tool.result.content[0].text.length, 10000);
});

test("Rust CLI options retain provider catalogs and managed Codex restrictions", async (t) => {
  const f = await fixture(t);
  for (const provider of ["codex", "omp"]) {
    const s = await f.call("chatCreate", { provider, cwd: f.root });
    const options = await f.call("chatOptions", { id: s.id });
    assert.ok(options.models.length > 0);
    assert.equal(options.provider, provider);
    if (provider === "codex")
      assert.equal(
        options.permissions.find((p) => p.id === "yolo").disabled,
        true,
      );
  }
});

test("Rust shuts down an owned process during a pending turn without replaying it", async (t) => {
  const f = await fixture(t);
  const s = await f.call("chatCreate", { provider: "omp", cwd: f.root });
  await f.call("chatSend", {
    id: s.id,
    text: "WAIT",
    requestId: "stop-on-close",
  });
  await new Promise((r) => setTimeout(r, 100));
  await f.restart();
  const restored = await f.call("chatGet", { id: s.id });
  assert.equal(restored.status, "interrupted");
  assert.equal(restored.pendingApprovals.length, 0);
  assert.equal(restored.messages.length, 2);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await f.call("chatGet", { id: s.id })).messages.length, 2);
});

test("Rust rich dialogs are denied and provider errors remain explicit", async (t) => {
  const f = await fixture(t);
  for (const provider of ["omp", "claude"]) {
    const s = await f.call("chatCreate", { provider, cwd: f.root });
    await f.call("chatSend", { id: s.id, text: "RICH", requestId: "rich" });
    const done = await settled(f, s.id);
    assert.match(done.messages.at(-1).text, /RICH_CANCELLED|DENIED/);
    assert.equal(done.pendingApprovals.length, 0);
  }
  const s = await f.call("chatCreate", { provider: "claude", cwd: f.root });
  await f.call("chatSend", { id: s.id, text: "ERROR", requestId: "error" });
  assert.match((await settled(f, s.id, "error")).error, /Fixture quota error/);
});
