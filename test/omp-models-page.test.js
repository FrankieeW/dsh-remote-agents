import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { createRequire } from "node:module";
import React, { act } from "react";
import { PRIMITIVES_ALIAS } from "./helpers/primitives-alias.js";
import spec from "../native/omp-config-spec.json" with { type: "json" };
const compiled = await build({
  entryPoints: ["src/client/OmpModelsPage.jsx"],
  bundle: true,
  write: false,
  format: "cjs",
  external: ["react"],
  alias: PRIMITIVES_ALIAS,
});
function fixture() {
  return {
    machineId: "local",
    cwd: "/workspace",
    spec,
    files: {
      global: { path: "/agent/config.yml", revision: "global-1" },
      project: { path: "/workspace/.omp/config.yml", revision: "project-1" },
      providers: { path: "/agent/models.yml", revision: "models-1" },
    },
    global: {
      modelRoles: { default: "demo/swift", designer: "@default" },
      cycleOrder: ["smol", "default", "slow"],
    },
    project: { modelRoles: { default: "demo/think" } },
    effective: {
      modelRoles: { default: "demo/think", designer: "@default" },
      cycleOrder: ["smol", "default", "slow"],
      modelPresets: {},
    },
    catalog: [
      {
        id: "swift",
        provider: "demo",
        selector: "demo/swift",
        name: "Swift",
        kind: "chat",
        thinking: ["low", "medium", "high"],
      },
    ],
    providers: [
      {
        id: "demo",
        api: "openai-responses",
        baseUrl: "https://example.com/v1",
        auth: "apiKey",
        credential: { configured: true, kind: "stored", reference: "" },
        models: [],
        overrides: [],
      },
    ],
  };
}
async function mount({ failSave = false } = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" }),
    previous = {
      window: globalThis.window,
      document: globalThis.document,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const calls = [],
    state = fixture(),
    session = {
      id: "s",
      provider: "omp",
      machineId: "local",
      cwd: "/workspace",
      name: "Test",
    };
  const api = async (method, payload) => {
    calls.push({ method, payload });
    if (method === "ompConfigRead") return structuredClone(state);
    if (failSave)
      throw Object.assign(
        Error("Configuration changed. Reload before saving"),
        { code: "CONFLICT" },
      );
    return {
      saved: true,
      path: "/agent/config.yml",
      backupPath: "/agent/backup",
    };
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    console,
  });
  const Page = module.exports.default;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  await act(async () =>
    root.render(
      React.createElement(Page, {
        api,
        store: { configurationChanged() {} },
        session,
        onConversation: () => {},
      }),
    ),
  );
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label,
    );
  const input = (label) => document.querySelector(`[aria-label="${label}"]`);
  return {
    calls,
    button,
    input,
    async click(label) {
      assert.ok(button(label), label);
      await act(async () => button(label).click());
    },
    async set(label, value) {
      const el = input(label);
      assert.ok(el, label);
      await act(async () => {
        const proto =
          el.tagName === "SELECT"
            ? dom.window.HTMLSelectElement.prototype
            : dom.window.HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
        el.dispatchEvent(
          new dom.window.Event(el.tagName === "SELECT" ? "change" : "input", {
            bubbles: true,
          }),
        );
      });
    },
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}
test("OMP configuration stages project role edits with the matching revision and keeps custom roles", async () => {
  const h = await mount();
  try {
    assert.ok(h.input("Model for designer"));
    await h.set("Edit scope", "project");
    await h.set("Model for default", "demo/alternate");
    assert.equal(h.calls.filter((c) => c.method === "ompConfigSave").length, 0);
    assert.equal(h.button("Providers & custom models").disabled, true);
    await h.click("Save role configuration");
    const p = h.calls.find((c) => c.method === "ompConfigSave").payload;
    assert.equal(p.scope, "project");
    assert.equal(p.revision, "project-1");
    assert.deepEqual(JSON.parse(JSON.stringify(p.patch)), {
      modelRoles: { default: "demo/alternate" },
    });
  } finally {
    await h.close();
  }
});
test("provider edits preserve configured credentials unless explicitly replaced", async () => {
  const h = await mount();
  try {
    await h.click("Providers & custom models");
    await h.click("demo0 custom · 0 overrides");
    await h.set("Base URL", "https://replacement.example/v1");
    await h.click("Save provider");
    const p = h.calls.find((c) => c.method === "ompConfigSave").payload;
    assert.equal(p.revision, "models-1");
    assert.equal(p.patch.baseUrl, "https://replacement.example/v1");
    assert.equal(p.patch.credential, undefined);
    assert.equal(p.patch.models, undefined);
  } finally {
    await h.close();
  }
});
test("role cycle text retains delimiters and conflicts keep unsaved edits without retry", async () => {
  const h = await mount({ failSave: true });
  try {
    await h.set("Role cycle order", "smol, ");
    assert.equal(h.input("Role cycle order").value, "smol, ");
    await h.set("Role cycle order", "smol, default");
    await h.click("Save role configuration");
    assert.equal(h.calls.filter((c) => c.method === "ompConfigSave").length, 1);
    assert.match(document.body.textContent, /Not saved/);
    assert.equal(h.input("Role cycle order").value, "smol, default");
    assert.match(document.body.textContent, /Unsaved changes/);
  } finally {
    await h.close();
  }
});

test("catalog effort arrays become explicit configuration objects, without numeric fields", async () => {
  const h = await mount();
  try {
    await h.click("Model catalog");
    await h.click("Override model");
    await h.set("Thinking control mode", "effort");
    await h.set("Model default thinking", "high");
    await h.click("Save model definition");
    const patch = h.calls.find((c) => c.method === "ompConfigSave").payload
      .patch;
    assert.deepEqual(JSON.parse(JSON.stringify(patch.thinking)), {
      mode: "effort",
      efforts: ["low", "medium", "high"],
      defaultLevel: "high",
    });
    assert.equal(patch.thinking[0], undefined);
  } finally {
    await h.close();
  }
});
