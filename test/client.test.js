import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { PRIMITIVES_ALIAS } from "./helpers/primitives-alias.js";

// Exercise the same CJS factory, shared React, slots and RPC used by the host.
test("client registers DSH slots and handles terminal diagnostics and stopped states", async () => {
  const result = await build({
    entryPoints: ["src/client-entry.jsx"],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    jsx: "automatic",
    loader: { ".css": "text" },
    external: ["react", "react/jsx-runtime"],
    alias: PRIMITIVES_ALIAS,
  });
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"></div></body></html>',
  );
  const old = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const mod = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    require: createRequire(import.meta.url),
    document,
    setTimeout,
    clearTimeout,
    console,
    crypto: globalThis.crypto, AbortController,
  });
  const registrations = [];
  const cleanup = [];
  const calls = [];
  const agent = {
    id: "agent",
    machineId: "local",
    name: "测试 Agent",
    kind: "shell",
    cwd: "/project",
    status: "exited",
  };
  const ctx = {
    slots: {
      inject: (_slot, fn) => { const result = fn(); if (result?.[Symbol.iterator]) for (const effect of result) void effect; },
      register: (meta, Component) => {
        registrations.push({ meta, Component });
      },
    },
    effect: (fn) => cleanup.push(fn()),
    layout: { beginNavigation: () => new AbortController().signal, selectPanel: (id) => calls.push(["selectPanel", id]) },
    uiWorkspace: { startSession: (...args) => calls.push(["nativeStart", args]) },
    workspaces: { create: async ({ path }) => ({ workspaceId: "workspace-test", path }) },
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          assert.equal(channel, "/api");
          assert.ok(endpoint.startsWith("remote-agents/"));
          endpoint = endpoint.slice("remote-agents/".length);
          calls.push([endpoint, payload]);
          if (endpoint === "chatList") return { ok: true, value: { sessions: [], providers: [] } };
          if (endpoint === "snapshot")
            return {
              ok: true,
              value: {
                machines: [{ id: "local", name: "本机", type: "local" }],
                agents: [{ ...agent }],
              },
            };
          if (endpoint === "read")
            return {
              ok: true,
              value: {
                agentId: "agent",
                status: "exited",
                output: "",
                diagnostic: "SSH connection unavailable",
              },
            };
          if (endpoint === "stop") {
            agent.stoppedAt = new Date().toISOString();
            return { ok: true, value: agent };
          }
          return { ok: false, error: { message: "unexpected method" } };
        },
      },
    },
  };
  const root = createRoot(document.getElementById("root"));
  try {
    mod.exports.apply(ctx);
    const main = registrations.find((r) => r.meta.name === "main" && r.meta.key === "remote-agents");
    await act(async () =>
      root.render(React.createElement(main.Component, main.meta.inject())),
    );
    const button = (text) =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes(text),
      );
    assert.match(document.body.textContent, /测试 Agent/, "user-provided agent names remain unchanged");
    assert.match(document.body.textContent, /Agent Workbench/);
    assert.ok(document.querySelector('[aria-label="Projects and agents"]'));
    assert.ok(document.querySelector('[aria-label="Agent terminal output"]'));
    await act(async () => button("View output").click());
    assert.match(document.body.textContent, /SSH connection unavailable/);
    assert.equal(
      button("Stop session").disabled,
      false,
      "dead pane must still be stoppable",
    );
    await act(async () => button("Stop session").click());
    assert.ok(document.querySelector('[role="alertdialog"]'));
    assert.equal(
      calls.filter(([method]) => method === "stop").length,
      0,
      "confirmation required",
    );
    await act(async () => button("Confirm stop").click());
    assert.equal(calls.filter(([method]) => method === "stop").length, 1);
    assert.ok(
      [...document.querySelectorAll(".fleet-danger-actions button")].at(-1)
        ?.disabled,
      document.body.textContent,
    );
  } finally {
    await act(async () => root.unmount());
    cleanup.forEach((fn) => fn?.());
    dom.window.close();
    Object.assign(globalThis, old);
  }
});

test("the sidebar opens machine management and the host routes machine endpoints", async () => {
  const { ENDPOINTS } = await import("../src/rpc.js");
  for (const endpoint of ["addMachine", "updateMachine", "removeMachine", "restoreMachine", "probe", "forgetAgent"])
    assert.ok(ENDPOINTS.includes(endpoint), endpoint);
  const result = await build({ entryPoints: ["src/client-entry.jsx"], bundle: true, write: false, platform: "browser", format: "cjs", jsx: "automatic", loader: { ".css": "text" }, external: ["react", "react/jsx-runtime"], alias: PRIMITIVES_ALIAS });
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  const mod = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module: mod, exports: mod.exports, require: createRequire(import.meta.url), document: dom.window.document, setTimeout, clearTimeout, console, crypto: globalThis.crypto, AbortController });
  const registrations = [], calls = [], cleanup = [];
  const ctx = {
    slots: { inject: (_slot, fn) => { const value = fn(); if (value?.[Symbol.iterator]) for (const effect of value) void effect; }, register: (meta, Component) => registrations.push({ meta, Component }) },
    effect: (fn) => cleanup.push(fn()),
    layout: { beginNavigation: () => new AbortController().signal, selectPanel: (id) => calls.push(id) },
    connection: { rpc: { call: async () => ({ ok: true, value: { machines: [], workspaces: [], sessions: [], providers: [], pluginVersion: "unused" } }) } },
  };
  try {
    mod.exports.apply(ctx);
    registrations.find((r) => r.meta.name === "sidebar.workspaces").meta.inject().onManageMachines();
    assert.deepEqual(calls, ["remote-agents"]);
  } finally {
    cleanup.forEach((fn) => fn?.());
    dom.window.close();
  }
});
