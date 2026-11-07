import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import React, { act } from "react";
import { PRIMITIVES_ALIAS } from "./helpers/primitives-alias.js";

const compiled = await build({ stdin: { contents: 'export {default} from "./src/client/ChatWorkbench.jsx"; export {createWorkspaceStore} from "./src/client/workspace-store.js"; export {ToolRenderBoundary} from "./src/client/chat-messages.jsx";', resolveDir: process.cwd() }, bundle: true, write: false, format: "cjs", external: ["react"], alias: PRIMITIVES_ALIAS });
const providers = [{ id: "claude", label: "Claude Code", available: true }, { id: "omp", label: "OMP", available: false, reason: "未安装 OMP" }];
const fixture = (id = "s1") => ({ id, name: `会话 ${id}`, provider: "claude", cwd: "/fixture", status: "idle", messages: [], pendingApprovals: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function mount(api, props = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost", pretendToBeVisual: true });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const timers = new Map();
  let nextTimer = 0;
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), document, crypto: { randomUUID }, console, setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: (id) => timers.delete(id) });
  const Component = module.exports.default;
  const store = module.exports.createWorkspaceStore(api);
  const root = createRoot(document.getElementById("root"), { onCaughtError: () => {} });
  const render = async (more = {}) => act(async () => root.render(React.createElement(Component, { api, store, ...props, ...more })));
  await act(async () => store.start());
  await render();
  const buttons = () => [...document.querySelectorAll("button")];
  const button = (text) => buttons().find((node) => node.textContent.trim() === text || node.getAttribute("aria-label") === text);
  return { dom, timers, render, button,
    async renderBoundary(tool, Child) { await act(async () => root.render(React.createElement(module.exports.ToolRenderBoundary, { tool }, React.createElement(Child)))); },
    async click(text) { const node = button(text); assert.ok(node, `button ${text} exists`); await act(async () => node.click()); },
    async select(id) { await act(async () => store.select(id)); },
    async expandTool(name) {
      const row = [...document.querySelectorAll("[data-disclosure-row]")].find((node) => node.textContent.includes(name));
      assert.ok(row, `tool ${name} exists`);
      await act(async () => row.click());
    },
    async type(selector, value) { const node = document.querySelector(selector); assert.ok(node); const setter = Object.getOwnPropertyDescriptor(node instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, "value").set; await act(async () => { setter.call(node, value); node.dispatchEvent(new dom.window.Event("input", { bubbles: true })); }); },
    async submit(selector) { await act(async () => document.querySelector(selector).dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }))); },
    async tick(delay) { const entry = [...timers].find(([, timer]) => timer.delay === delay); assert.ok(entry, `timer ${delay} scheduled`); timers.delete(entry[0]); await act(async () => entry[1].fn()); },
    async cleanup() { await act(async () => root.unmount()); store.dispose(); assert.equal(timers.size, 0, "all polling timers cleared"); dom.window.close(); Object.assign(globalThis, previous); },
  };
}


test("structured messages, tools, approvals and close confirmation use explicit APIs", async () => {
  let state = fixture();
  state.messages = [{ id: "u", role: "user", text: "<img src=x onerror=alert(1)>" }, { id: "a", role: "assistant", text: "真实结构化回复", tools: [{ id: "tool", name: "read_file", input: { path: "test.txt" }, result: "tool-result", status: "done" }] }];
  state.status = "waiting";
  state.pendingApprovals = [{ id: "approval", title: "写入文件", description: "需要你的确认", details: { path: "test.txt" } }];
  const calls = [];
  const h = await mount(async (method, payload) => {
    calls.push([method, payload]);
    if (method === "chatList") return { sessions: [state], providers };
    if (method === "chatGet") return structuredClone(state);
    if (method === "chatApprove") { assert.equal(payload.approvalId, "approval"); state = { ...state, status: "idle", pendingApprovals: [] }; return state; }
    if (method === "chatClose") { state = { ...state, status: "closed" }; return state; }
    throw Error(method);
  });
  try {
    await h.select("s1");
    assert.ok(document.body.textContent.includes("真实结构化回复"));
    assert.ok(!document.body.textContent.includes("tool-result"), "tool rows start collapsed, like DSH");
    await h.expandTool("read_file");
    assert.ok(document.body.textContent.includes("tool-result"));
    assert.ok(document.body.textContent.includes('"path": "test.txt"'), "generic tools show their structured input");
    assert.equal(document.querySelector("img"), null, "message HTML is escaped");
    assert.equal(h.button("Send message").disabled, true);
    await h.click("Deny");
    assert.equal(calls.find(([method]) => method === "chatApprove")[1].allow, false);
    await h.tick(700);
    await h.click("Close session");
    assert.equal(calls.filter(([method]) => method === "chatClose").length, 0);
    assert.ok(document.querySelector('[role="alertdialog"]'));
    await h.click("Cancel");
    assert.equal(calls.filter(([method]) => method === "chatClose").length, 0);
    await h.click("Close session");
    await h.click("Confirm close");
    assert.equal(calls.filter(([method]) => method === "chatClose").length, 1);
    assert.equal(document.querySelector("textarea").disabled, true);
  } finally { await h.cleanup(); }
});

test("send failures preserve draft and explicit retry reuses requestId without poll resend", async () => {
  let sends = 0;
  const attempts = [];
  const state = fixture();
  const h = await mount(async (method, payload) => {
    if (method === "chatList") return { sessions: [state], providers };
    if (method === "chatGet") return structuredClone(state);
    if (method === "chatSend") { attempts.push(payload); sends += 1; if (sends === 1) throw Error("连接丢失，结果未知"); state.status = "running"; return { accepted: true }; }
    throw Error(method);
  });
  try {
    await h.select("s1");
    await h.type("textarea", "保留这条消息");
    assert.equal(h.button("Send message").disabled, false);
    let textarea = document.querySelector("textarea");
    await act(async () => textarea.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(sends, 0, "IME enter does not submit");
    await act(async () => textarea.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(sends, 0, "Shift+Enter does not submit");
    await h.submit(".agent-chat-composer");
    assert.equal(textarea.value, "保留这条消息");
    await h.tick(5000);
    await h.tick(10000);
    assert.equal(sends, 1, "polling never resends prompt");
    await h.render({ key: "return-from-native-session" });
    textarea = document.querySelector("textarea");
    assert.equal(textarea.value, "保留这条消息", "workspace navigation preserves drafts across content mounts");
    await h.submit(".agent-chat-composer");
    assert.equal(attempts[0].requestId, attempts[1].requestId);
    assert.equal(attempts[0].text, attempts[1].text);
    assert.equal(textarea.value, "");
    assert.equal(h.button("Send message").disabled, true);
    assert.ok(h.button("Stop generating"));
  } finally { await h.cleanup(); }
});

test("accepted sends lock duplicates and preserve newly edited drafts", async () => {
  const accepted = deferred();
  const state = fixture("created");
  const calls = [];
  const h = await mount(async (method, payload) => {
    calls.push([method, payload]);
    if (method === "chatList") return { sessions: [], providers };
    if (method === "chatCreate") throw new Error("Conversation content must not create sessions");
    if (method === "chatGet") return structuredClone(state);
    if (method === "chatSend") return accepted.promise;
    if (method === "chatInterrupt") { state.status = "interrupted"; return structuredClone(state); }
    throw Error(method);
  });
  try {
    await h.select("created");
    await h.type("textarea", "第一条");
    await h.submit(".agent-chat-composer");
    await h.submit(".agent-chat-composer");
    assert.equal(calls.filter(([method]) => method === "chatSend").length, 1, "synchronous lock blocks duplicate submissions");
    await h.type("textarea", "下一条草稿");
    state.status = "running";
    await act(async () => accepted.resolve({ accepted: true }));
    assert.equal(document.querySelector("textarea").value, "下一条草稿");
    await h.click("Stop generating");
    assert.equal(calls.filter(([method]) => method === "chatInterrupt").length, 1);
    assert.equal(document.querySelector("textarea").value, "下一条草稿");
    assert.ok(!calls.some(([method]) => ["start", "send", "read"].includes(method)), "never use terminal APIs");
  } finally { await h.cleanup(); }
});

test("selected-session request ordering ignores late responses and polling never overlaps", async () => {
  const late = deferred();
  const sessions = [fixture("s1"), fixture("s2")];
  let firstReads = 0;
  const h = await mount(async (method, payload) => {
    if (method === "chatList") return { sessions, providers };
    if (method === "chatGet" && payload.id === "s1") { firstReads += 1; return late.promise; }
    if (method === "chatGet") return { ...sessions[1], messages: [{ id: "m2", role: "assistant", text: "第二个会话内容" }] };
    throw Error(method);
  });
  try {
    await h.select("s1");
    assert.equal([...h.timers.values()].filter((timer) => timer.delay === 5000).length, 0, "no next get until current settles");
    await h.select("s2");
    await act(async () => late.resolve({ ...sessions[0], messages: [{ id: "m1", role: "assistant", text: "过期响应内容" }] }));
    assert.ok(document.body.textContent.includes("第二个会话内容"));
    assert.ok(!document.body.textContent.includes("过期响应内容"));
    assert.equal(firstReads, 1);
    assert.equal([...h.timers.values()].filter((timer) => timer.delay === 5000).length, 1);
  } finally { await h.cleanup(); }
});

test("a late ACK after remount cannot discard a newer ambiguous-send receipt", async () => {
  const firstAck = deferred();
  const secondAck = deferred();
  const state = fixture();
  const attempts = [];
  const h = await mount(async (method, payload) => {
    if (method === "chatList") return { sessions: [state], providers };
    if (method === "chatGet") return structuredClone(state);
    if (method === "chatSend") {
      attempts.push(payload);
      if (attempts.length === 1) return firstAck.promise;
      if (attempts.length === 2) return secondAck.promise;
      return { accepted: true };
    }
    throw Error(method);
  });
  try {
    await h.select("s1");
    await h.type("textarea", "First turn");
    await h.submit(".agent-chat-composer");
    await h.render({ key: "workspace-return" });
    await h.type("textarea", "Second turn");
    await h.submit(".agent-chat-composer");
    await act(async () => firstAck.resolve({ accepted: true }));
    await act(async () => secondAck.reject(Error("Receipt lost after admission")));
    assert.equal(document.querySelector("textarea").value, "Second turn");
    await h.submit(".agent-chat-composer");
    assert.notEqual(attempts[0].requestId, attempts[1].requestId);
    assert.equal(attempts[1].requestId, attempts[2].requestId, "retry must identify the same admitted second turn");
  } finally { await h.cleanup(); }
});

test("Claude Code sessions dock their latest to-dos, render tools natively, preview approvals and offer a resume command", async () => {
  const state = {
    ...fixture("claude"), cwd: "/work/app", providerSessionId: "0f8b2c1e-1111-4222-8333-444455556666", status: "waiting",
    messages: [
      { id: "u1", role: "user", text: "Fix the build" },
      { id: "a1", role: "assistant", text: "", tools: [
        { id: "t1", name: "TodoWrite", status: "done", input: { todos: [{ content: "Reproduce", status: "completed" }, { content: "Patch", status: "in_progress" }, { content: "Verify", status: "pending" }] } },
        { id: "t2", name: "Bash", status: "error", isError: true, input: { command: "npm test", description: "Run tests" }, result: JSON.stringify([{ type: "text", text: "Exit code 1\nfailing suite" }]) },
        { id: "t3", name: "Edit", status: "done", input: { file_path: "/work/app/src/a.js", old_string: "one", new_string: "two" } },
      ] },
    ],
    pendingApprovals: [{ id: "p1", kind: "tool", title: "Allow Bash?", description: "Claude requests permission to use Bash", details: { toolName: "Bash", input: { command: "rm -rf build" } } }],
  };
  const h = await mount(async (method) => {
    if (method === "chatList") return { sessions: [state], providers };
    if (method === "chatGet") return structuredClone(state);
    throw Error(method);
  });
  try {
    await h.select("claude");
    const dock = document.querySelector('section[aria-label="To-dos"]');
    assert.match(dock.textContent, /1 completed · 1 in progress · 1 pending/);
    assert.equal(dock.querySelectorAll("li").length, 0, "the dock starts collapsed");
    await act(async () => dock.querySelector("button").click());
    assert.deepEqual([...dock.querySelectorAll("li")].map((item) => item.dataset.status), ["completed", "in_progress", "pending"]);
    const rows = [...document.querySelectorAll("[data-disclosure-row]")].map((row) => row.textContent);
    assert.ok(rows.some((text) => text.includes("Bash") && text.includes("Run tests") && text.includes("Failed")));
    assert.ok(rows.some((text) => text.includes("Edit") && text.includes("src/a.js") && !text.includes("/work/app")), "paths are relative to the session");
    await h.expandTool("Bash");
    assert.match(document.querySelector("[data-terminal]").textContent, /\$ npm test\nExit code 1\nfailing suite/);
    await h.expandTool("Edit");
    assert.match(document.querySelector("[data-diff]").textContent, /src\/a\.js\n-one\n\+two/);
    const approval = document.querySelector('[aria-label="Pending approval"]');
    assert.match(approval.textContent, /Claude Code needs your approval/);
    assert.match(approval.querySelector(".agent-chat-approval-command").textContent, /rm -rf build/);
    assert.match(approval.textContent, /this tool call only/);
    assert.ok(h.button("Copy resume command"), "Claude sessions can be resumed in a terminal");
    assert.match(document.querySelector(".agent-chat-status").textContent, /Waiting for approval/);
    assert.ok(h.button("Stop generating"));
    assert.equal(h.button("Send message").disabled, true);
  } finally { await h.cleanup(); }
});

test("OMP sessions explain unsupported slash and shell input before sending and show their grant scope", async () => {
  const state = { ...fixture("omp"), provider: "omp", status: "waiting",
    pendingApprovals: [{ id: "p1", kind: "permission", title: "Allow tool: bash", description: "ls -la", details: { options: ["Approve", "Deny"], grant: "this call only" } }] };
  const sends = [];
  const h = await mount(async (method, payload) => {
    if (method === "chatList") return { sessions: [state], providers: [{ id: "omp", label: "OMP", available: true }] };
    if (method === "chatGet") return structuredClone(state);
    if (method === "chatApprove") { state.status = "idle"; state.pendingApprovals = []; return structuredClone(state); }
    if (method === "chatSend") { sends.push(payload); return { accepted: true }; }
    throw Error(method);
  });
  try {
    await h.select("omp");
    const approval = document.querySelector('[aria-label="Pending approval"]');
    assert.match(approval.textContent, /OMP needs your approval/);
    assert.match(approval.textContent, /OMP grants this call only/);
    assert.equal(h.button("Copy resume command"), undefined, "resume commands are Claude-only");
    await h.click("Allow once");
    await h.tick(700);
    for (const text of ["/model fast", "  !ls -la"]) {
      await h.type("textarea", text);
      assert.equal(h.button("Send message").disabled, true);
      assert.match(document.querySelector('.agent-chat-hint[role="alert"]').textContent, /plain prompts/);
      await h.submit(".agent-chat-composer");
    }
    assert.equal(sends.length, 0, "unsupported input is never sent");
    await h.type("textarea", "List the files");
    assert.equal(document.querySelector('.agent-chat-hint[role="alert"]'), null);
    assert.equal(document.querySelector("textarea").placeholder, "Ask OMP…");
    await h.submit(".agent-chat-composer");
    assert.equal(sends[0].text, "List the files");
  } finally { await h.cleanup(); }
});

test("Codex renders its plans, command output, patches and resume action in native chat", async () => {
  const state = { ...fixture("codex"), provider: "codex", providerSessionId: "owned-thread", cwd: "/work/app",
    messages: [{ id: "a", role: "assistant", text: "Ready to verify", tools: [
      { id: "plan", name: "update_plan", status: "done", input: { todos: [{ content: "Verify", status: "in_progress" }] } },
      { id: "cmd", name: "commandExecution", status: "done", input: { command: "npm test" }, result: { content: [{ text: "passed" }], details: { exitCode: 0 } } },
      { id: "patch", name: "fileChange", status: "done", input: { changes: [{ path: "/work/app/a.js", diff: "-old\n+new" }] } },
    ] }] };
  const h = await mount(async method => {
    if (method === "chatList") return { sessions: [state], providers: [{ id: "codex", available: true }] };
    if (method === "chatGet") return structuredClone(state);
    throw Error(method);
  });
  try {
    await h.select("codex");
    assert.equal(document.querySelector("textarea").placeholder, "Ask Codex…");
    assert.ok(h.button("Copy resume command"));
    assert.match(document.querySelector('section[aria-label="Plan"]').textContent, /1 in progress/);
    await h.expandTool("Run command");
    assert.match(document.querySelector('[data-terminal]').textContent, /npm test\npassed/);
    await h.expandTool("File changes");
    assert.equal(document.querySelector('.agent-chat-patch-path').textContent, "a.js");
    assert.match(document.querySelector('.agent-chat-patch [data-markdown]').textContent, /-old\n\+new/);
  } finally { await h.cleanup(); }
});

test("model/effort/YOLO controls save actual session settings, reset to CLI, and lock during turns", async () => {
  let state={...fixture('settings'),provider:'codex',settings:{model:null,effort:null,permissions:'cli'}};
  const calls=[];
  const h=await mount(async(method,payload)=>{
    if(method==='chatList')return{sessions:[state],providers:[{id:'codex',available:true,capabilities:{settings:true}}]};
    if(method==='chatGet')return structuredClone(state);
    if(method==='chatOptions')return{defaults:{model:'cli-model',effort:'medium'},models:[{id:'model-a',label:'Model A',efforts:['low','high']}],efforts:['low','high'],permissions:[{id:'cli',label:'Follow CLI'},{id:'yolo',label:'Full access · YOLO'}]};
    if(method==='chatConfigure'){calls.push(payload);state={...state,settings:{...state.settings,...payload.patch},settingsRevision:(state.settingsRevision||0)+1};return structuredClone(state);}
    throw Error(method);
  });
  try{
    await h.select('settings');await h.click('Model');
    const model=[...document.querySelectorAll('.agent-chat-settings-options button')].find(b=>b.textContent.includes('Model A'));
    await act(async()=>model.click());assert.equal(calls.at(-1).patch.model,'model-a');assert.equal(calls.at(-1).patch.effort,null);
    await h.click('Reasoning effort');await h.click('high');assert.equal(calls.at(-1).patch.effort,'high');
    await h.click('Permission mode');await h.click('Full access · YOLO');assert.equal(calls.at(-1).patch.permissions,'yolo');
    await h.click('Model');const inherit=document.querySelector('.agent-chat-settings-options button');await act(async()=>inherit.click());assert.equal(calls.at(-1).patch.model,null);assert.equal(calls.at(-1).patch.effort,null);
    state={...state,status:'running'};await h.tick(5000);assert.equal(h.button('Model').disabled,true);assert.equal(h.button('Permission mode').disabled,true);
  }finally{await h.cleanup();}
});

test('a stale detail response cannot overwrite saved settings and the UI reports persistence',async()=>{
  let state={...fixture('revision'),provider:'codex',settings:{model:null,effort:null,permissions:'cli'},settingsRevision:0};
  const stale=deferred();let reads=0;
  const h=await mount(async(method,payload)=>{
    if(method==='chatList')return{sessions:[state],providers:[{id:'codex',available:true,capabilities:{settings:true}}]};
    if(method==='chatGet'){reads++;return reads===2?stale.promise:structuredClone(state);}
    if(method==='chatOptions')return{models:[],efforts:['low'],permissions:[{id:'cli',label:'Follow CLI'},{id:'read-only',label:'Read only'}]};
    if(method==='chatConfigure'){assert.equal(payload.expectedRevision,0);assert.equal(payload.settings,undefined);state={...state,settings:{...state.settings,...payload.patch},settingsRevision:1};return structuredClone(state);}
    throw Error(method);
  });
  try{
    await h.select('revision');const old=structuredClone(state);
    // Start an old server snapshot, then commit settings before that read resolves.
    const timer=[...h.timers].find(([,v])=>v.delay===5000);h.timers.delete(timer[0]);let pending;
    await act(async()=>{pending=timer[1].fn();});
    await h.click('Permission mode');await h.click('Read only');assert.match(document.body.textContent,/Settings saved/);
    await act(async()=>{stale.resolve(old);await pending;});
    await h.click('Permission mode');assert.equal([...document.querySelectorAll('.agent-chat-settings-options button')].find(b=>b.textContent==='Read only').getAttribute('aria-pressed'),'true');
  }finally{await h.cleanup();}
});

test('OMP phased todo events keep messages, composer and stop control mounted while running', async () => {
  const state = { ...fixture('omp-todo'), provider:'omp', status:'running', messages:[{id:'reply',role:'assistant',text:'Working on the project',tools:[{id:'todo-call',name:'todo',status:'done',input:{op:'init',list:[{phase:'Implementation',items:['Inspect API','Build UI']}]},result:{details:{op:'init',phases:[{name:'Implementation',tasks:[{content:'Inspect API',status:'in_progress'},{content:'Build UI',status:'pending'}]}]}}}]}] };
  const h = await mount(async method => {
    if(method==='chatList')return{sessions:[state],providers:[{id:'omp',available:true}]};
    if(method==='chatGet')return structuredClone(state);
    throw Error(method);
  });
  try {
    await h.select('omp-todo');
    assert.match(document.body.textContent,/Working on the project/);
    assert.match(document.body.textContent,/1 in progress · 1 pending/);
    assert.ok(h.button('Stop generating'));
    assert.ok(document.querySelector('textarea'));
    await h.expandTool('todo');assert.match(document.body.textContent,/Inspect API/);
    state.messages[0].tools.push({id:'unknown',name:'todo',status:'running',input:{op:'future-format'}});
    await h.tick(700);assert.ok(h.button('Stop generating'));assert.ok(document.querySelector('textarea'));
  } finally { await h.cleanup(); }
});

test('a tool component rendering failure is contained with a raw-data fallback', async () => {
  const h = await mount(async method => method === 'chatList' ? { sessions:[], providers:[] } : {machines:[],workspaces:[]});
  try {
    await h.renderBoundary({name:'unknown-tool',input:{path:'/fixture'},result:'retained output'},function BrokenTool(){throw Error('fixture render failure');});
    assert.match(document.body.textContent,/Tool display unavailable/);
    assert.match(document.body.textContent,/retained output/);
  } finally { await h.cleanup(); }
});

test('OMP truncation identifies the retained tool limit and loads original pages only on request',async()=>{
  const calls=[];
  const state={...fixture('history'),provider:'omp',providerSessionId:'owned',messages:[{id:'reply',role:'assistant',text:'Reply intact',tools:[{id:'preview',name:'read',input:{path:'first'},status:'done',truncated:true}],toolsTruncated:true}]};
  const h=await mount(async(method,payload)=>{
    if(method==='chatList')return{sessions:[state],providers:[{id:'omp',available:true}]};
    if(method==='chatGet')return structuredClone(state);
    if(method==='chatOmpHistory'){
      calls.push(payload);
      if(payload.toolId)return{tool:{id:'original',name:'read',input:{path:'original'},result:'Complete tool result',status:'done',previewTruncated:false},detailLimit:262144};
      return{totalTools:2,offset:payload.offset,nextOffset:payload.offset+1,hasMore:payload.offset===0,text:'Original reply',textLength:14,tools:[{id:payload.offset?'later':'original',name:'read',input:{path:payload.offset?'later':'original'},result:'preview',previewTruncated:!payload.offset,status:'done'}]};
    }
    throw Error(method);
  });
  try{
    await h.select('history');assert.match(document.body.textContent,/older plugin preview contains only 1 tool calls/);assert.equal(calls.length,0);assert.ok(!document.body.textContent.includes('Some content in this message was truncated'));
    await h.click('View original OMP turn');assert.match(document.body.textContent,/Showing 1 of 2/);
    await h.click('Load more original tool calls');assert.match(document.body.textContent,/Showing 2 of 2/);assert.equal(calls.at(-1).offset,1);
    await h.click('Read larger record for read');assert.match(document.body.textContent,/Complete tool result/);
    assert.ok(document.querySelector('textarea'));
  }finally{await h.cleanup();}
});

for(const provider of ['claude','codex','omp'])test(`${provider} native view tabs preserve drafts and suggestions never send`,async()=>{
 const state={...fixture('views'),provider},sends=[];
 const h=await mount(async(method,payload)=>{if(method==='chatList')return{sessions:[state],providers:[{id:provider,available:true}]};if(method==='chatGet')return structuredClone(state);if(method==='chatSend'){sends.push(payload);return{accepted:true};}throw Error(method);});
 try{
  await h.select('views');const expected={claude:['Chat','Tools','To-dos'],codex:['Chat','Plan','Changes'],omp:['Chat','Tasks','Tools']}[provider];
  assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(t=>t.getAttribute('aria-label')),expected);
  const suggestion=document.querySelector('.agent-welcome-suggestions button');await act(async()=>suggestion.click());assert.equal(sends.length,0);const textarea=document.querySelector('textarea'),draft=textarea.value;assert.ok(draft.length>20);
  await act(async()=>document.querySelectorAll('[role="tab"]')[1].click());assert.equal(document.querySelector('textarea').value,draft);assert.ok(document.querySelector('textarea')===textarea);
  await act(async()=>document.querySelector('[role="tab"][aria-selected="true"]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true})));
  assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'),expected[2]);assert.equal(sends.length,0);
  await h.tick(5000);assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'),expected[2]);
  await h.select('');await h.select('views');assert.equal(document.querySelector('[role="tab"][aria-selected="true"]').getAttribute('aria-label'),'Chat');assert.equal(document.querySelector('textarea').value,draft);
 }finally{await h.cleanup();}
});

test('archived tool pages replace rows and preserve the composer while full data is paged',async()=>{
  const tools=Array.from({length:40},(_,i)=>({id:`t-${i}`,name:'read',input:{path:`file-${i}`},status:'done',archived:true,truncated:true}));
  const state={...fixture('archive'),provider:'omp',messages:[{id:'m',role:'assistant',text:'Done',tools:tools.slice(0,16),toolsArchived:true,toolCount:40}]};
  const calls=[];
  const h=await mount(async(method,payload)=>{
    if(method==='chatList')return{sessions:[state],providers:[{id:'omp',available:true}]};
    if(method==='chatGet')return structuredClone(state);
    if(method==='chatToolHistory'){
      calls.push(payload);
      if(payload.toolId)return{toolId:payload.toolId,field:payload.field,offset:payload.offset||0,nextOffset:payload.offset?12:6,size:12,hasMore:!payload.offset,text:payload.offset?'TAIL_OK':'FIRST_'};
      const offset=payload.offset||0;return{tools:tools.slice(offset,offset+16),offset,totalTools:40,matchedTools:40,nextOffset:Math.min(40,offset+16),hasMore:offset+16<40};
    }
    throw Error(method);
  });
  try{
    await h.select('archive');assert.match(document.body.textContent,/Showing 16 of 40 tool calls/);assert.ok(!document.body.textContent.includes('Only the first'));const composer=document.querySelector('textarea');
    await h.click('Browse saved tools');await h.click('Next tools');assert.equal(calls.at(-1).offset,16);assert.match(document.body.textContent,/file-31/);assert.ok(!document.body.textContent.includes('file-0'));
    assert.equal(document.querySelectorAll('[data-disclosure-row]').length,16);assert.equal(document.querySelector('textarea'),composer);
    await h.click('Read full result for read');assert.match(document.querySelector('.agent-history-detail').textContent,/FIRST_/);await h.click('Next data');assert.match(document.querySelector('.agent-history-detail').textContent,/TAIL_OK/);assert.ok(!document.querySelector('.agent-history-detail').textContent.includes('FIRST_'));
  }finally{await h.cleanup();}
});

test('Codex changes/plan views and OMP phased tasks render retained data while keeping approvals visible',async()=>{
 let state={...fixture('specialized'),provider:'codex',status:'waiting',pendingApprovals:[{id:'approve',title:'Allow command?',details:{toolName:'commandExecution',input:{command:'npm test'}}}],messages:[{id:'a',role:'assistant',text:'Implementation ready',tools:[{id:'plan',name:'update_plan',status:'done',input:{todos:[{content:'Verify behavior',status:'pending'}]}},{id:'patch',name:'fileChange',status:'done',input:{changes:[{path:'/fixture/a.js',diff:'-old\n+new'}]}}]}]};
 const h=await mount(async method=>{if(method==='chatList')return{sessions:[state],providers:[{id:'codex',available:true},{id:'omp',available:true}]};if(method==='chatGet')return structuredClone(state);throw Error(method);});
 try{
  await h.select('specialized');await h.click('Changes');assert.match(document.querySelector('.agent-detail-view').textContent,/a.js/);assert.match(document.querySelector('.agent-chat-patch').textContent,/-old\n\+new/);assert.ok(document.querySelector('[aria-label="Pending approval"]'));assert.ok(h.button('Stop generating'));
  await h.click('Plan');assert.match(document.querySelector('.agent-detail-view').textContent,/Verify behavior/);
  state={...state,id:'omp-special',provider:'omp',status:'idle',pendingApprovals:[],messages:[{id:'m',role:'assistant',text:'Ready',tools:[{id:'todo',name:'todo',status:'done',input:{op:'read'},result:{details:{phases:[{name:'Implement',tasks:[{content:'Write integration',status:'completed'}]},{name:'Verify',tasks:[{content:'Run checks',status:'pending'}]}]}}}]}]};
  await h.select('omp-special');await h.click('Tasks');assert.deepEqual([...document.querySelectorAll('.agent-detail-view .agent-chat-todo-phase')].map(n=>n.textContent),['Implement','Verify']);assert.match(document.querySelector('.agent-detail-view').textContent,/Run checks/);
 }finally{await h.cleanup();}
});
