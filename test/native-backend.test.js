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
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { NativeBackend } from "../src/native/client.js";
import { PERMISSIONS } from "../src/chat/settings.js";
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
  const claude = await make(
    "claude",
    await readFile("scripts/fixtures/claude-process.cjs", "utf8"),
  );
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
          session: "dev.session",
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
  const recovered = await f.call('chatRecoverOmpTools',{id:sid,messageId});
  assert.equal(recovered.messages[0].toolCount,21);
  assert.equal(recovered.messages[0].toolsArchived,true);
  assert.deepEqual(recovered.messages[0].tools.map(tool => tool.id), Array.from({length:16}, (_, i) => `tool-${i + 5}`));
  const full = await f.call('chatToolHistory',{id:sid,messageId,toolId:'tool-20',field:'result'});
  assert.equal(JSON.parse(full.text).content[0].text.length,10000);
  assert.ok(!full.text.includes('PRIVATE'));
  await assert.rejects(f.call('chatRecoverOmpTools',{id:sid,messageId}),{code:'CONFLICT'});
});

test('full tool archives retain later calls, Unicode output, search, streams and restart',async t=>{
  const f=await fixture(t), session=await f.call('chatCreate',{provider:'omp',cwd:f.root});
  const admitted=await f.call('chatSend',{id:session.id,text:'MANY_TOOLS',requestId:'many'});
  const state=await settled(f,session.id), message=state.messages.at(-1);
  assert.equal(message.toolCount,40);assert.equal(message.tools.length,16);assert.equal(message.toolsTruncated,undefined);
  const latestIds = Array.from({length:16}, (_, i) => `many-${i + 24}`);
  assert.deepEqual(message.tools.map(tool => tool.id), latestIds);
  assert.equal(message.tools.find(tool => tool.id === 'many-38').status, 'done');
  assert.equal(message.tools.find(tool => tool.id === 'many-38').text, 'stream-start\nstream-end');
  assert.equal(message.latestTodoTool.result.details.phases[0].tasks[0].content,'Fortieth tool kept');
  const p={id:session.id,messageId:admitted.assistantMessageId};
  const ids=[];let offset=0;
  for(;;){const page=await f.call('chatToolHistory',{...p,offset});ids.push(...page.tools.map(t=>t.id));if(!page.hasMore)break;offset=page.nextOffset;}
  assert.equal(new Set(ids).size,40);assert.equal(ids.at(-1),'many-39');
  const found=await f.call('chatToolHistory',{...p,query:'END_MARKER_38'});assert.equal(found.matchedTools,1);assert.equal(found.tools[0].id,'many-38');
  let raw='',position=0;
  for(;;){const chunk=await f.call('chatToolHistory',{...p,toolId:'many-38',field:'result',offset:position,limit:65533});assert.ok(Buffer.byteLength(chunk.text)<=65533);raw+=chunk.text;if(!chunk.hasMore)break;assert.ok(chunk.nextOffset>position);position=chunk.nextOffset;}
  assert.equal(JSON.parse(raw).content[0].text,'中文🙂'.repeat(30000)+'END_MARKER_38');
  const stream=await f.call('chatToolHistory',{...p,toolId:'many-38',field:'text'});assert.equal(stream.text,'stream-start\nstream-end');
  const other=await f.call('chatCreate',{provider:'codex',cwd:f.root});
  await assert.rejects(f.call('chatToolHistory',{...p,id:other.id}),{code:'NOT_FOUND'});
  await assert.rejects(f.call('chatToolHistory',{...p,toolId:'../../bad',field:'result'}),{code:'NOT_FOUND'});
  await assert.rejects(f.call('chatToolHistory',{...p,toolId:'many-38',field:'../meta.json'}),{code:'INVALID_INPUT'});
  await f.restart();
  const restored = (await f.call('chatGet',{id:session.id})).messages.at(-1);
  assert.equal(restored.toolCount,40);
  assert.deepEqual(restored.tools.map(tool => tool.id), latestIds);
  assert.equal((await f.call('chatToolHistory',{...p,offset:32})).tools.length,8);
  // Archived SSH-session reads are host-owned and need no live machine connection.
  await f.backend.close();
  const savedPath=join(f.root,'state','conversations.json'), saved=JSON.parse(await readFile(savedPath,'utf8'));
  saved.sessions.find(s=>s.id===session.id).machineId='offline-ssh';
  await writeFile(savedPath,JSON.stringify(saved));await f.restart();
  assert.equal((await f.call('chatToolHistory',{...p,offset:32})).tools.length,8);
  const archiveDir=join(f.root,'state','tool-history',session.id,p.messageId);
  assert.equal((await stat(archiveDir)).mode & 0o777,0o700);
  assert.equal((await stat(join(archiveDir,'index.json'))).mode & 0o777,0o600);
  await rm(join(archiveDir,'index.json'));
  await assert.rejects(f.call('chatToolHistory',{...p,minimumCount:0}),{code:'HISTORY_UNAVAILABLE'});
});

test('archive storage failure stops a turn and is visible instead of silently losing tools',async t=>{
  const f=await fixture(t), session=await f.call('chatCreate',{provider:'omp',cwd:f.root});
  await mkdir(join(f.root,'outside'));
  await symlink(join(f.root,'outside'),join(f.root,'state','tool-history'));
  await f.call('chatSend',{id:session.id,text:'hello',requestId:'bad-store'});
  const state=await settled(f,session.id,'error');
  assert.match(state.messages.at(-1).toolHistoryError,/Could not save complete tool history/);
  await assert.rejects(access(join(f.root,'outside',session.id)));
});

test("Rust CLI options retain provider catalogs and managed Codex restrictions", async (t) => {
  const f = await fixture(t);
  for (const provider of ["codex", "omp", "claude"]) {
    const s = await f.call("chatCreate", { provider, cwd: f.root });
    const options = await f.call("chatOptions", { id: s.id });
    assert.ok(options.models.length > 0);
    assert.equal(options.provider, provider);
    assert.deepEqual(
      options.permissions.map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      PERMISSIONS[provider],
    );
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

test("Rust resolves standalone Node for the Claude bridge when the host is Electron", async (t) => {
  const f = await fixture(t);
  f.config.nodeExecutable = null;
  await f.restart();
  const session = await f.call("chatCreate", {
    provider: "claude",
    cwd: f.root,
  });
  await f.call("chatSend", {
    id: session.id,
    text: "hello",
    requestId: "electron-fallback",
  });
  assert.equal(
    (await settled(f, session.id)).messages.at(-1).text,
    "CLAUDE_NATIVE_OK",
  );
});

test("automatic names follow the first prompt, preserve manual names, and survive restart", async (t) => {
  const f = await fixture(t),
    session = await f.call("chatCreate", { provider: "codex", cwd: f.root });
  assert.equal(session.name, "New conversation");
  assert.equal(session.nameSource, "auto");
  const prompt = "为左侧栏添加可折叠工具分组并保存用户设置";
  await f.call("chatSend", {
    id: session.id,
    text: prompt,
    requestId: "title-one",
  });
  const named = await settled(f, session.id);
  assert.ok(prompt.startsWith(named.name));
  assert.ok(Buffer.byteLength(named.name) <= 40);
  assert.equal(named.nameSource, "auto");
  assert.equal(named.messages[0].text, prompt);
  await f.call("chatMetadata", { id: session.id, name: "我的发布计划" });
  assert.equal(
    (
      await f.call("chatSend", {
        id: session.id,
        text: prompt,
        requestId: "title-one",
      })
    ).duplicate,
    true,
  );
  await f.call("chatSend", {
    id: session.id,
    text: "WAIT",
    requestId: "title-two",
  });
  await f.call("chatMetadata", { id: session.id, name: "手动标题优先" });
  await f.call("chatInterrupt", { id: session.id });
  await f.restart();
  assert.equal(
    (await f.call("chatGet", { id: session.id })).name,
    "手动标题优先",
  );
  const restored = await f.call("chatMetadata", {
    id: session.id,
    autoName: true,
  });
  assert.equal(restored.name, named.name);
  assert.equal(restored.nameSource, "auto");
  await assert.rejects(
    f.call("chatMetadata", {
      id: session.id,
      name: "ambiguous",
      autoName: true,
    }),
    { code: "INVALID_INPUT" },
  );
  const manual = await f.call("chatCreate", {
    provider: "omp",
    cwd: f.root,
    name: "Pinned project",
  });
  await f.call("chatSend", {
    id: manual.id,
    text: "hello",
    requestId: "manual",
  });
  assert.equal((await settled(f, manual.id)).name, "Pinned project");
});

test("existing default titles are backfilled without changing custom names or messages", async (t) => {
  const f = await fixture(t);
  await f.backend.close();
  await mkdir(join(f.root, "state"), { recursive: true });
  const make = (id, provider, name) => ({
    id,
    provider,
    name,
    cwd: f.root,
    machineId: "local",
    status: "idle",
    settings: { model: null, effort: null, permissions: "cli" },
    messages: [
      {
        id: id + "-message",
        role: "user",
        text: "整理工作区并补充测试",
        tools: [],
      },
    ],
    requests: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const sessions = [
    make("legacy-omp", "omp", "omp chat"),
    make("legacy-codex", "codex", "My custom title"),
  ];
  await writeFile(
    join(f.root, "state", "conversations.json"),
    JSON.stringify({ version: 1, sessions }),
  );
  await f.restart();
  const auto = await f.call("chatGet", { id: "legacy-omp" }),
    manual = await f.call("chatGet", { id: "legacy-codex" });
  assert.equal(auto.name, "整理工作区并补充测试");
  assert.equal(auto.nameSource, "auto");
  assert.equal(manual.name, "My custom title");
  assert.equal(manual.nameSource, "manual");
  assert.deepEqual(auto.messages, sessions[0].messages);
});

for (const provider of ["claude", "codex", "omp"])
  test(`Rust ${provider}: commands preserve history and settings revisions across restart`, async (t) => {
    const f = await fixture(t);
    const session = await f.call("chatCreate", { provider, cwd: f.root });
    const command = (text, extra = {}) => f.call("chatCommand", {
      id: session.id, text, requestId: text, ...extra,
    });
    await f.call("chatSend", { id: session.id, text: "hello", requestId: "prompt" });
    const original = await settled(f, session.id);
    const model = await command("/model custom/example", { expectedRevision: 0 });
    assert.equal(model.session.settings.model, "custom/example");
    await assert.rejects(command("/effort low", { expectedRevision: 0 }), { code: "CONFLICT" });
    const effort = await command("/effort low", { expectedRevision: 1 });
    assert.equal(effort.session.settings.effort, "low");
    await assert.rejects(command("/permissions invalid-mode"), { code: "INVALID_INPUT" });
    await command("/rename 命令会话");
    await command("/pin on");
    await command("/archive on");
    const beforeRestart = await f.call("chatGet", { id: session.id });
    assert.equal(beforeRestart.name, "命令会话");
    assert.equal(beforeRestart.pinned, true);
    assert.equal(beforeRestart.archived, true);
    assert.equal(beforeRestart.settingsRevision, 2);
    assert.equal(beforeRestart.providerSessionId, original.providerSessionId);
    assert.deepEqual(beforeRestart.messages, original.messages);
    const exported = await command("/export json");
    assert.deepEqual(JSON.parse(exported.file.content).messages, original.messages);
    await f.restart();
    const restored = await f.call("chatGet", { id: session.id });
    assert.equal(restored.settings.model, "custom/example");
    assert.equal(restored.settings.effort, "low");
    assert.equal(restored.name, "命令会话");
    assert.equal(restored.pinned, true);
    await command("/model default", { expectedRevision: 2 });
    const reset = await command("/effort default", { expectedRevision: 3 });
    assert.equal(reset.session.settings.model, null);
    assert.equal(reset.session.settings.effort, null);
  });

test("Rust slash admission fails without transcript pollution; active commands expire approvals", async (t) => {
  const f = await fixture(t);
  for (const provider of ["claude", "codex", "omp"]) {
    const session = await f.call("chatCreate", { provider, cwd: f.root });
    for (const text of ["/model example", "/unknown", ...(provider === "omp" ? [" !ls"] : [])]) {
      await assert.rejects(f.call("chatSend", { id: session.id, text, requestId: text }), { code: "UNSUPPORTED" });
    }
    const clean = await f.call("chatGet", { id: session.id });
    assert.equal(clean.status, "idle");
    assert.deepEqual(clean.messages, []);
    await assert.rejects(f.call("chatCommand", { id: session.id, text: "/unknown", requestId: "unknown" }));
    await f.call("chatSend", { id: session.id, text: "APPROVAL", requestId: "approval" });
    const pending = await settled(f, session.id, "waiting");
    await assert.rejects(f.call("chatCommand", { id: session.id, text: "/rename running", requestId: "rename" }), { code: "BUSY" });
    await assert.rejects(f.call("chatCommand", { id: session.id, text: "/new", requestId: "new" }), { code: "BUSY" });
    const status = await f.call("chatCommand", { id: session.id, text: "/status", requestId: "status" });
    assert.equal(status.session.status, "waiting");
    await f.call("chatCommand", { id: session.id, text: "/stop", requestId: "stop" });
    const stopped = await settled(f, session.id, "interrupted");
    assert.deepEqual(stopped.pendingApprovals, []);
    await assert.rejects(f.call("chatApprove", { id: session.id, approvalId: pending.pendingApprovals[0].id, allow: true }), { code: "APPROVAL_NOT_FOUND" });
  }
});

test("Rust new-session command retries survive restart and offline closed sessions", async (t) => {
  const f = await fixture(t);
  const source = await f.call("chatCreate", { provider: "omp", cwd: f.root, settings: { model: "custom/example", effort: "low", permissions: "cli" } });
  await f.call("chatSend", { id: source.id, text: "hello", requestId: "old" });
  const old = await settled(f, source.id);
  await f.call("chatClose", { id: source.id });
  await f.backend.close();
  await rm(f.config.ompExecutable);
  await f.restart();
  const command = text => f.call("chatCommand", { id: source.id, text, requestId: "offline-" + text });
  const help = await command("/help");
  assert.ok(help.commands.some(c => c.name === "new"));
  const status = await command("/status");
  assert.equal(status.session.status, "closed");
  const file = await command("/export json");
  assert.deepEqual(JSON.parse(file.file.content).messages, old.messages);
  await assert.rejects(command("/rename closed"), { code: "CLOSED" });
  const created = await command("/new");
  assert.notEqual(created.session.id, source.id);
  assert.deepEqual(created.session.settings, source.settings);
  assert.equal(created.session.cwd, source.cwd);
  assert.equal(created.session.machineId, source.machineId);
  assert.deepEqual(created.session.messages, []);
  assert.equal(created.session.providerSessionId, undefined);
  await f.restart();
  const retry = await command("/new");
  assert.equal(retry.session.id, created.session.id);
  assert.equal((await f.call("chatList")).sessions.length, 2);
  await assert.rejects(f.call("chatCommand", { id: source.id, text: "/status", requestId: "offline-/new" }), { code: "CONFLICT" });
  assert.deepEqual((await f.call("chatGet", { id: source.id })).messages, old.messages);
});
