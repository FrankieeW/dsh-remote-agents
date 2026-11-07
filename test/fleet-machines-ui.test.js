import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import React, { act } from "react";

const compiled = await build({
  entryPoints: ["src/client/FleetPage.jsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
});
const NOW = new Date().toISOString();
const HOST_KEY = "The host key of new-box is not trusted yet. Run `ssh new-box` once in a terminal to verify it, then test again.";

function fixture() {
  return {
    version: 1,
    machines: [
      { id: "local", name: "Local", type: "local" },
      {
        id: "dev", name: "Dev", type: "ssh", host: "dev", user: "alice", port: 2222,
        lastCheck: { checkedAt: NOW, ok: true, message: "Connected", tmux: { ok: true, version: "tmux 3.4" }, clis: [{ id: "codex", label: "Codex", available: true, version: "0.167.0" }, { id: "claude", label: "Claude Code", available: false }] },
      },
      { id: "build", name: "Build", type: "ssh", host: "build", lastCheck: { checkedAt: NOW, ok: false, code: "HOST_KEY", message: "The host key of build is not trusted yet. Run `ssh build` once in a terminal to verify it, then test again." } },
      { id: "spare", name: "Spare", type: "ssh", host: "spare" },
      { id: "old", name: "Old box", type: "ssh", host: "old", removedAt: NOW },
    ],
    projects: [{ id: "p1", name: "api", machineId: "dev", cwd: "/srv/api", source: "workspace" }],
    agents: [
      { id: "a1", name: "worker", machineId: "build", cwd: "/srv/w", kind: "shell", status: "unknown", diagnostic: "build refused the SSH connection.", createdAt: NOW },
      { id: "a2", name: "done", machineId: "dev", cwd: "/srv/api", kind: "shell", status: "exited", stoppedAt: NOW, createdAt: NOW },
    ],
  };
}

async function mount(handlers = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const mod = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module: mod, exports: mod.exports, require: createRequire(import.meta.url), console, setTimeout, clearTimeout });
  const fleet = fixture();
  const calls = [];
  const api = async (endpoint, payload = {}) => {
    calls.push([endpoint, payload]);
    if (handlers[endpoint]) return handlers[endpoint](payload, fleet);
    if (endpoint === "snapshot") return structuredClone(fleet);
    if (endpoint === "sshConfigHosts") return { hosts: [], warnings: [] };
    if (endpoint === "read") return { agentId: payload.agentId, status: "unknown", output: "", truncated: false };
    throw new Error(`unexpected ${endpoint}`);
  };
  const root = createRoot(dom.window.document.getElementById("root"));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => root.render(React.createElement(mod.exports.default, { api })));
  await settle();
  const doc = dom.window.document;
  const $$ = (selector, scope = doc) => [...scope.querySelectorAll(selector)];
  return {
    calls,
    $: (selector) => doc.querySelector(selector),
    byId: (id) => doc.getElementById(id),
    $$,
    dialog: () => doc.querySelector('[role="alertdialog"]'),
    button: (text, scope = doc) => $$("button", scope).find((b) => b.textContent.trim() === text),
    row: (name) => $$(".fleet-machine-wrap").find((node) => node.querySelector(".fleet-machine strong")?.textContent === name),
    // Payloads come from the vm realm; compare them as plain data.
    sent: (endpoint) => calls.filter(([e]) => e === endpoint).map(([, payload]) => JSON.parse(JSON.stringify(payload))),
    async click(node) {
      assert.ok(node, "element exists");
      await act(async () => node.click());
      await settle();
    },
    async type(node, value) {
      assert.ok(node, "input exists");
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(node, value);
        node.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    },
    async submit(form) {
      assert.ok(form, "form exists");
      await act(async () => form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
      await settle();
    },
    async cleanup() {
      await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, previous);
    },
  };
}

test("machines show their last check and removal explains what blocks it", async () => {
  const h = await mount({
    probe: (p, fleet) => {
      const machine = fleet.machines.find((m) => m.id === p.machineId);
      machine.lastCheck = { checkedAt: NOW, ok: false, code: "AUTH", message: "SSH authentication failed. Load your key into ssh-agent." };
      return { machineId: p.machineId, ok: false, ssh: { ok: false, code: "AUTH", message: machine.lastCheck.message } };
    },
  });
  try {
    assert.match(h.row("Dev").textContent, /alice@dev:2222/);
    assert.match(h.row("Dev").textContent, /Connected · tmux 3\.4 · Codex 0\.167\.0/);
    assert.match(h.row("Build").textContent, /ssh build/);
    assert.match(h.row("Spare").textContent, /Not tested yet/);
    assert.equal(h.row("Old box"), undefined, "removed machines are not listed as active");
    await h.click(h.button("Test connection", h.row("Spare")));
    assert.deepEqual(h.sent("probe"), [{ machineId: "spare" }]);
    assert.match(h.row("Spare").textContent, /SSH authentication failed/);
    await h.click(h.button("Remove", h.row("Dev")));
    assert.match(h.dialog().textContent, /“api”/);
    assert.equal(h.button("Confirm removal", h.dialog()), undefined);
    await h.click(h.button("Close", h.dialog()));
    await h.click(h.button("Remove", h.row("Build")));
    assert.match(h.dialog().textContent, /“worker”/);
    assert.deepEqual(h.sent("removeMachine"), []);
  } finally {
    await h.cleanup();
  }
});

test("adding a machine tests SSH first and saves an unreachable one only on request", async () => {
  const h = await mount({
    addMachine: (p, fleet) => {
      if (p.verify) throw Object.assign(new Error(HOST_KEY), { code: "HOST_KEY" });
      const machine = { id: "new", name: p.name || p.target, type: "ssh", host: p.target };
      fleet.machines.push(machine);
      return machine;
    },
  });
  try {
    await h.click(h.button("＋ Add SSH machine"));
    await h.type(h.$('.fleet-machine-form input[aria-label="SSH destination"]'), "new-box");
    await h.submit(h.$(".fleet-machine-form"));
    assert.deepEqual(h.sent("addMachine"), [{ target: "new-box", verify: true }]);
    assert.match(h.$(".fleet-machine-form").textContent, /ssh new-box/);
    await h.click(h.button("Save without testing"));
    assert.deepEqual(h.sent("addMachine").at(-1), { target: "new-box", verify: false });
    assert.ok(h.row("new-box"));
    assert.equal(h.$(".fleet-machine-form"), null);
  } finally {
    await h.cleanup();
  }
});

test("machines can be edited, removed with their conversations retained, and restored", async () => {
  const h = await mount({
    updateMachine: (p, fleet) => {
      const machine = fleet.machines.find((m) => m.id === p.machineId);
      if (p.name) machine.name = p.name;
      if (p.target) machine.host = p.target;
      return machine;
    },
    removeMachine: (p, fleet) => {
      fleet.machines.find((m) => m.id === p.machineId).removedAt = NOW;
      return { machineId: p.machineId, removed: true, retained: true, sessions: 2 };
    },
    restoreMachine: (p, fleet) => {
      const machine = fleet.machines.find((m) => m.id === p.machineId);
      delete machine.removedAt;
      return machine;
    },
  });
  try {
    await h.click(h.button("Edit", h.row("Dev")));
    assert.equal(h.$('.fleet-machine-edit input[aria-label="SSH destination"]').value, "alice@dev:2222");
    await h.type(h.$('.fleet-machine-edit input[aria-label="Machine name"]'), "Dev box");
    await h.submit(h.$(".fleet-machine-edit"));
    await h.click(h.button("Edit", h.row("Dev box")));
    await h.type(h.$('.fleet-machine-edit input[aria-label="SSH destination"]'), "dev2");
    await h.submit(h.$(".fleet-machine-edit"));
    assert.deepEqual(h.sent("updateMachine"), [{ machineId: "dev", name: "Dev box" }, { machineId: "dev", target: "dev2" }]);
    await h.click(h.button("Remove", h.row("Spare")));
    assert.match(h.dialog().textContent, /history/);
    await h.click(h.button("Confirm removal", h.dialog()));
    assert.deepEqual(h.sent("removeMachine"), [{ machineId: "spare" }]);
    assert.match(h.$('.fleet-alert[role="status"]').textContent, /2 conversations/);
    assert.equal(h.row("Spare"), undefined);
    await h.click(h.button("Removed machines (2)"));
    const spare = h.$$(".fleet-removed li").find((item) => item.textContent.includes("Spare"));
    await h.click(h.button("Restore", spare));
    assert.deepEqual(h.sent("restoreMachine"), [{ machineId: "spare" }]);
    assert.ok(h.row("Spare"));
  } finally {
    await h.cleanup();
  }
});

test("terminal records can be forgotten without terminating anything", async () => {
  const h = await mount({
    forgetAgent: (p, fleet) => {
      fleet.agents = fleet.agents.filter((a) => a.id !== p.agentId);
      return { agentId: p.agentId, forgotten: true };
    },
  });
  try {
    await h.click(h.$$(".fleet-agent").find((node) => node.textContent.includes("worker")));
    await h.click(h.button("Forget record"));
    assert.match(h.dialog().textContent, /never terminates/);
    await h.click(h.button("Forget record", h.dialog()));
    assert.deepEqual(h.sent("forgetAgent"), [{ agentId: "a1", force: true }]);
    await h.click(h.$$(".fleet-agent").find((node) => node.textContent.includes("done")));
    await h.click(h.button("Remove from list"));
    await h.click(h.button("Remove from list", h.dialog()));
    assert.deepEqual(h.sent("forgetAgent").at(-1), { agentId: "a2" });
  } finally {
    await h.cleanup();
  }
});

test("workspace registrations can be removed from the Machines page", async () => {
  const h = await mount({
    workspaceRemove: (p, fleet) => {
      fleet.projects = fleet.projects.filter((project) => project.id !== p.workspaceId);
      return { removed: true };
    },
  });
  try {
    const project = h.$$(".fleet-project").find((node) => node.textContent.includes("api"));
    await h.click(h.button("Remove registration", project));
    assert.match(h.dialog().textContent, /files and conversations are kept/i);
    await h.click(h.button("Remove registration", h.dialog()));
    assert.deepEqual(h.sent("workspaceRemove"), [{ workspaceId: "p1" }]);
  } finally {
    await h.cleanup();
  }
});

test("the add form suggests SSH config hosts that are not machines yet", async () => {
  const h = await mount({
    sshConfigHosts: () => ({
      hosts: [
        { alias: "dev", user: "alice", hostName: "10.0.0.5", machineId: "dev" },
        { alias: "lab", hostName: "lab.example", port: 2200 },
        { alias: "old", machineId: "old", removed: true },
      ],
      warnings: [],
    }),
  });
  try {
    await h.click(h.button("＋ Add SSH machine"));
    const input = h.$('.fleet-machine-form input[aria-label="SSH destination"]');
    const options = h.$$("option", h.byId(input.getAttribute("list")));
    assert.deepEqual(options.map((option) => option.value), ["lab", "old"]);
    assert.match(options[0].textContent, /lab\.example:2200/);
    assert.match(options[1].textContent, /restores/);
    assert.deepEqual(h.sent("sshConfigHosts"), [{}]);
  } finally {
    await h.cleanup();
  }
});
