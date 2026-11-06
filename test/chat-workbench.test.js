import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import React, { act } from "react";

const compiled = await build({ stdin: { contents: 'export {default} from "./src/client/ChatWorkbench.jsx"; export {createWorkspaceStore} from "./src/client/workspace-store.js";', resolveDir: process.cwd() }, bundle: true, write: false, format: "cjs", external: ["react"] });
const providers = [{ id: "claude", label: "Claude Code", available: true }, { id: "omp", label: "OMP", available: false, reason: "未安装 OMP" }];
const fixture = (id = "s1") => ({ id, name: `会话 ${id}`, provider: "claude", cwd: "/fixture", status: "idle", messages: [], pendingApprovals: [] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function mount(api, props = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
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
  const root = createRoot(document.getElementById("root"));
  const render = async (more = {}) => act(async () => root.render(React.createElement(Component, { api, store, ...props, ...more })));
  await act(async () => store.start());
  await render();
  const buttons = () => [...document.querySelectorAll("button")];
  const button = (text) => buttons().find((node) => node.textContent.trim() === text);
  return { dom, timers, render, button,
    async click(text) { const node = button(text); assert.ok(node, `button ${text} exists`); await act(async () => node.click()); },
    async select(id) { await act(async () => store.select(id)); },
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
    assert.ok(document.body.textContent.includes("tool-result"));
    assert.equal(document.querySelector("img"), null, "message HTML is escaped");
    assert.equal(h.button("Send").disabled, true);
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
    assert.equal(h.button("Send").disabled, false);
    let textarea = document.querySelector("textarea");
    await act(async () => textarea.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(sends, 0, "IME enter does not submit");
    await act(async () => textarea.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    assert.equal(sends, 0, "Shift+Enter does not submit");
    await h.submit(".fleet-chat-composer");
    assert.equal(textarea.value, "保留这条消息");
    await h.tick(700);
    await h.tick(3000);
    assert.equal(sends, 1, "polling never resends prompt");
    await h.render({ key: "return-from-native-session" });
    textarea = document.querySelector("textarea");
    assert.equal(textarea.value, "保留这条消息", "workspace navigation preserves drafts across content mounts");
    await h.submit(".fleet-chat-composer");
    assert.equal(attempts[0].requestId, attempts[1].requestId);
    assert.equal(attempts[0].text, attempts[1].text);
    assert.equal(textarea.value, "");
    assert.equal(h.button("Send").disabled, true);
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
    await h.submit(".fleet-chat-composer");
    await h.submit(".fleet-chat-composer");
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
    assert.equal([...h.timers.values()].filter((timer) => timer.delay === 700).length, 0, "no next get until current settles");
    await h.select("s2");
    await act(async () => late.resolve({ ...sessions[0], messages: [{ id: "m1", role: "assistant", text: "过期响应内容" }] }));
    assert.ok(document.body.textContent.includes("第二个会话内容"));
    assert.ok(!document.body.textContent.includes("过期响应内容"));
    assert.equal(firstReads, 1);
    assert.equal([...h.timers.values()].filter((timer) => timer.delay === 700).length, 1);
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
    await h.submit(".fleet-chat-composer");
    await h.render({ key: "workspace-return" });
    await h.type("textarea", "Second turn");
    await h.submit(".fleet-chat-composer");
    await act(async () => firstAck.resolve({ accepted: true }));
    await act(async () => secondAck.reject(Error("Receipt lost after admission")));
    assert.equal(document.querySelector("textarea").value, "Second turn");
    await h.submit(".fleet-chat-composer");
    assert.notEqual(attempts[0].requestId, attempts[1].requestId);
    assert.equal(attempts[1].requestId, attempts[2].requestId, "retry must identify the same admitted second turn");
  } finally { await h.cleanup(); }
});
