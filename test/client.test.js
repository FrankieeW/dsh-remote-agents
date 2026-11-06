import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

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
      inject: (_slot, fn) => fn(),
      register: (meta, Component) => {
        registrations.push({ meta, Component });
      },
    },
    effect: (fn) => cleanup.push(fn()),
    connection: {
      rpc: {
        call: async (channel, endpoint, payload) => {
          assert.equal(channel, "/remote-agents");
          calls.push([endpoint, payload]);
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
    const main = registrations.find((r) => r.meta.name === "main");
    assert.equal(main.meta.key, "remote-agents");
    assert.equal(
      registrations.find((r) => r.meta.name === "sidebar.panellist").meta.id,
      main.meta.key,
    );
    assert.match(document.head.textContent, /fleet-page/);
    await act(async () =>
      root.render(React.createElement(main.Component, main.meta.inject())),
    );
    const button = (text) =>
      [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes(text),
      );
    assert.match(document.body.textContent, /测试 Agent/);
    await act(async () => button("查看输出").click());
    assert.match(document.body.textContent, /SSH connection unavailable/);
    assert.equal(
      button("停止会话").disabled,
      false,
      "dead pane must still be stoppable",
    );
    await act(async () => button("停止会话").click());
    assert.ok(document.querySelector('[role="alertdialog"]'));
    assert.equal(
      calls.filter(([method]) => method === "stop").length,
      0,
      "confirmation required",
    );
    await act(async () => button("确认停止").click());
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
