import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

test("Herdr import UI requires preview and confirmation, invalidates edits and retains exact input", async () => {
  const built = await build({
    entryPoints: ["src/client/HerdrImport.jsx"],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
  });
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>');
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const mod = { exports: {} };
  vm.runInNewContext(built.outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    require: createRequire(import.meta.url),
    TextDecoder,
    console,
  });
  const root = createRoot(document.getElementById("root"));
  let pending = Promise.resolve(),
    imported = 0;
  const calls = [];
  const api = async (endpoint, payload) => {
    calls.push([endpoint, JSON.parse(JSON.stringify(payload))]);
    if (endpoint === "previewHerdr")
      return {
        digest: "a".repeat(64),
        machines: [{ name: "Build", host: "build", action: "add" }],
        projects: [],
        warnings: ["Do not resume Herdr sessions"],
        summary: { machines: 1, projects: 0, duplicates: 0 },
      };
    return { imported: { machines: 1, projects: 0 } };
  };
  const button = (text) =>
    [...document.querySelectorAll("button")].find((b) =>
      b.textContent.includes(text),
    );
  const upload = async (index, text) => {
    const input = document.querySelectorAll("input[type=file]")[index];
    const bytes = new TextEncoder().encode(text);
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [
        {
          name: "fixture.json",
          size: bytes.byteLength,
          arrayBuffer: async () => bytes.buffer,
        },
      ],
    });
    await act(async () => {
      input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(mod.exports.default, {
          api,
          machines: [{ id: "local", name: "本机", type: "local" }],
          busy: "",
          run: (_label, fn) => {
            pending = fn();
          },
          onClose() {},
          onImported() {
            imported++;
          },
        }),
      ),
    );
    assert.ok(document.querySelector('[aria-label="Herdr static configuration import"]'));
    assert.ok(document.querySelector('[aria-label="Close Herdr import"]'));
    assert.match(document.body.textContent, /Import machines and projects from Herdr/);
    assert.match(document.body.textContent, /本机/, "machine names remain unchanged");
    const text = JSON.stringify({
      version: 1,
      ssh: [],
      secret: "DO_NOT_RENDER_RAW",
    });
    await upload(0, text);
    assert.equal(
      document.body.textContent.includes("DO_NOT_RENDER_RAW"),
      false,
    );
    await act(async () => {
      button("Preview import").click();
      await pending;
    });
    assert.match(document.body.textContent, /Do not resume Herdr sessions/);
    assert.equal(button("Confirm import").disabled, true);
    await act(async () =>
      document.querySelector("input[type=checkbox]").click(),
    );
    assert.equal(button("Confirm import").disabled, false);
    // Replacing even semantically identical content invalidates the old preview.
    await upload(0, text + " ");
    assert.equal(button("Confirm import"), undefined);
    await act(async () => {
      button("Preview import").click();
      await pending;
    });
    await act(async () =>
      document.querySelector("input[type=checkbox]").click(),
    );
    await act(async () => {
      button("Confirm import").click();
      await pending;
    });
    const commits = calls.filter(([method]) => method === "importHerdr");
    assert.equal(commits.length, 1);
    assert.deepEqual(commits[0][1], {
      machinesText: text + " ",
      confirmation: "a".repeat(64),
    });
    assert.equal(imported, 1);
    assert.equal(button("Confirm import"), undefined);
    await upload(1, JSON.stringify({ version: 3, workspaces: [] }));
    assert.equal(
      button("Preview import").disabled,
      true,
      "session import cannot default to Local",
    );
    await act(async () => {
      const select = document.querySelector("select");
      select.value = "local";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    assert.equal(button("Preview import").disabled, false);
    await upload(1, "not JSON: DO_NOT_RENDER_RAW");
    assert.match(document.body.textContent, /The file is not valid JSON/);
    assert.equal(document.body.textContent.includes("DO_NOT_RENDER_RAW"), false);
    assert.equal(button("Preview import").disabled, true);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Object.assign(globalThis, saved);
  }
});
