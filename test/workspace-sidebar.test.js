import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React, { act } from 'react';

const compiled = await build({ entryPoints: ['src/client/WorkspaceSidebar.jsx'], bundle: true, write: false, format: 'cjs', external: ['react'] });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const native = (id, extra = {}) => ({ id, displayTitle: `Native ${id}`, cwd: '/project', blank: false, running: false, updatedAt: 1, ...extra });
const external = (id, extra = {}) => ({ id, name: `External ${id}`, provider: 'omp', cwd: '/project', status: 'idle', updatedAt: 2, ...extra });

async function mount(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, localStorage: dom.window.localStorage });
  const Component = module.exports.default;
  const listeners = new Set();
  const state = { sessions: options.sessions || [external('e1')], providers: options.providers || [{ id: 'omp', available: true }, { id: 'claude', available: false, reason: 'Claude is not installed' }], selectedId: options.selectedId || null, loading: false, error: null };
  const nativeRows = options.nativeRows || [native('n1')];
  const nativeState = { ids: nativeRows.map((row) => row.id), byId: Object.fromEntries(nativeRows.map((row) => [row.id, row])), phase: 'ready' };
  let nativeStatuses = options.nativeStatuses || new Map();
  const workspace = { workspaceId: 'w1', path: '/project', title: 'Project', sessionIds: nativeRows.filter((row) => row.cwd === '/project').map((row) => row.id) };
  const workspaces = { items: options.workspaces || [workspace], archivedSessionIds: options.archivedSessionIds || [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null };
  const calls = { create: [], open: [], add: [], action: [] };
  let snapshot = state;
  const store = { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const props = {
    useSessions: (selector) => selector(nativeState), useWorkspaces: (selector) => selector(workspaces), store,
    useSessionStatus: (selector) => selector(React.useSyncExternalStore(store.subscribe, () => nativeStatuses)),
    onCreate: async (request) => { calls.create.push(request); return options.create?.(request); },
    onOpen: async (request) => { calls.open.push(request); },
    onAddWorkspace: async (path) => { calls.add.push(path); },
    onNativeAction: async (...args) => { calls.action.push(args); return options.action?.(...args); },
    nativeSelectedId: options.nativeSelectedId,
    ...options.props,
  };
  const root = createRoot(document.getElementById('root'));
  const render = async (more = {}) => { Object.assign(props, more); await act(async () => root.render(React.createElement(Component, props))); };
  await render();
  return {
    dom, calls, workspace, render,
    row: (name) => [...document.querySelectorAll('.agent-workspace-open')].find((node) => node.textContent.includes(name)),
    async click(node) { assert.ok(node); await act(async () => node.click()); },
    async change(selector, value) { const node = document.querySelector(selector); assert.ok(node); await act(async () => { node.value = value; node.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); },
    async submit(selector) { const form = typeof selector === 'string' ? document.querySelector(selector) : selector; assert.ok(form); await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); },
    async update(values) { await act(async () => { snapshot = { ...snapshot, ...values }; for (const listener of listeners) listener(); }); },
    async status(value) { await act(async () => { nativeStatuses = value; for (const listener of listeners) listener(); }); },
    async cleanup() { await act(async () => root.unmount()); assert.equal(listeners.size, 0); dom.window.close(); Object.assign(globalThis, previous); },
  };
}

test('one workspace mixes backends and creates directly with its exact directory, never on mount', async () => {
  const gate = deferred();
  const h = await mount({ create: () => gate.promise });
  try {
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.open.length, 0);
    const group = document.querySelector('.agent-workspace-group');
    assert.equal(group.querySelectorAll('.agent-workspace-open').length, 2);
    assert.equal(group.querySelector('select').value, 'omp');
    const form = group.querySelector('form');
    const submit = form.querySelector('button');
    await h.submit(form);
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].provider, 'omp');
    assert.equal(h.calls.create[0].workspace, h.workspace);
    assert.equal(h.calls.create[0].workspace.path, '/project');
    assert.equal(submit.disabled, true);
    await h.submit(form);
    assert.equal(h.calls.create.length, 1, 'duplicate submissions share the create lock');
    await act(async () => gate.reject(new Error('Project is unavailable')));
    assert.equal(submit.disabled, false);
    assert.match(document.querySelector('[role="alert"]').textContent, /Project is unavailable/);
  } finally { await h.cleanup(); }
});

test('unavailable runtimes are disabled with reasons and fallback creates native without a chooser', async () => {
  const h = await mount({ providers: [{ id: 'omp', available: false, reason: 'OMP missing' }, { id: 'claude', available: true }] });
  try {
    const select = document.querySelector('.agent-workspace-create select');
    assert.equal(select.value, 'native');
    assert.equal(select.querySelector('[value="omp"]').disabled, true);
    assert.match(select.querySelector('[value="omp"]').textContent, /OMP missing/);
    await h.submit('.agent-workspace-create');
    assert.equal(h.calls.create[0].provider, 'native');
    assert.equal(h.calls.create[0].workspace.path, '/project');
    await h.change('.agent-workspace-create select', 'claude');
    await h.submit('.agent-workspace-create');
    assert.equal(h.calls.create[1].provider, 'claude');
  } finally { await h.cleanup(); }
});

test('native and external rows navigate explicitly, respect native selection, and filter native blanks and subagents', async () => {
  const h = await mount({ selectedId: 'e1', nativeSelectedId: 'blank-selected', nativeRows: [native('n1'), native('blank-selected', { blank: true }), native('blank-hidden', { blank: true }), native('child', { origin: 'subagent' })] });
  try {
    assert.ok(h.row('blank-selected'));
    assert.equal(h.row('blank-hidden'), undefined);
    assert.equal(h.row('child'), undefined);
    assert.equal(h.row('blank-selected').getAttribute('aria-current'), 'page');
    assert.equal(h.row('External e1').getAttribute('aria-current'), null);
    await h.click(h.row('Native n1'));
    assert.equal(h.calls.open[0].provider, 'native');
    assert.equal(h.calls.open[0].id, 'n1');
    await h.click(h.row('External e1'));
    assert.equal(h.calls.open[1].provider, 'omp');
    assert.equal(h.calls.open[1].id, 'e1');
    await h.render({ nativeSelectedId: null });
    assert.equal(h.row('External e1').getAttribute('aria-current'), 'page');
    assert.equal(h.row('blank-selected'), undefined);
    await h.render({ externalActive: false });
    assert.equal(h.row('External e1').getAttribute('aria-current'), null, 'last external session is not selected in another panel');
    await h.render({ externalActive: true });
    assert.equal(h.row('External e1').getAttribute('aria-current'), 'page');
  } finally { await h.cleanup(); }
});

test('archived and unregistered history stays discoverable and can create directly at its original cwd', async () => {
  const h = await mount({ archivedSessionIds: ['n1'], sessions: [external('e1'), external('old', { cwd: '/unregistered/project', status: 'closed', provider: 'claude' })] });
  try {
    assert.ok(h.row('Native n1'));
    assert.ok(h.row('External old'));
    assert.equal(document.querySelectorAll('.agent-workspace-group').length, 2);
    await h.change('[aria-label="Session history filter"]', 'archived');
    assert.ok(h.row('Native n1'));
    assert.ok(h.row('External old'));
    assert.equal(h.row('External e1'), undefined);
    const history = [...document.querySelectorAll('.agent-workspace-group')].find((group) => group.getAttribute('aria-label') === '/unregistered/project');
    await h.submit(history.querySelector('form'));
    assert.equal(h.calls.create[0].workspace.path, '/unregistered/project');
    assert.equal(h.calls.create[0].provider, 'omp');
    await h.click(h.row('External old'));
    assert.equal(h.calls.open[0].provider, 'claude');
    assert.equal(h.calls.open[0].id, 'old');
    const collapse = history.querySelector('.agent-workspace-collapse');
    await h.click(collapse);
    assert.equal(collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById(collapse.getAttribute('aria-controls')).hidden, true);
  } finally { await h.cleanup(); }
});

test('native row actions use owner callbacks and compact sidebar only expands', async () => {
  let expanded = 0;
  const h = await mount({ props: { expandSidebar: () => { expanded += 1; } } });
  try {
    const actions = document.querySelector('.agent-workspace-actions');
    await h.click([...actions.querySelectorAll('button')].find((button) => button.textContent === 'Pin'));
    await h.click([...actions.querySelectorAll('button')].find((button) => button.textContent === 'Fork'));
    await h.click([...actions.querySelectorAll('button')].find((button) => button.textContent === 'Archive'));
    assert.deepEqual(h.calls.action.map((args) => Array.from(args).slice(0, 2)), [['pin', 'n1'], ['fork', 'n1'], ['archive', 'n1']]);
    await h.render({ wide: false });
    assert.equal(document.querySelector('.agent-workspace-create'), null);
    await h.click(document.querySelector('[aria-label="Expand workspaces"]'));
    assert.equal(expanded, 1);
    assert.equal(h.calls.open.length, 0);
  } finally { await h.cleanup(); }
});

test('native pending interactions outrank running and unread, then completion clears on acknowledgement', async () => {
  const live = (kind) => ({ running: true, completionUnread: true, pendingInteraction: { kind } });
  const h = await mount({
    sessions: [],
    nativeRows: [native('approval', { running: true }), native('question'), native('plan'), native('unread', { running: true }), native('fallback', { running: true }), native('archived')],
    nativeStatuses: new Map([['approval', live('approval')], ['question', live('question')], ['plan', live('plan-review')], ['unread', { running: false, completionUnread: true }], ['archived', live('approval')]]),
    archivedSessionIds: ['archived'],
  });
  const marker = (name) => h.row(`Native ${name}`).querySelector('.agent-workspace-status');
  try {
    for (const name of ['approval', 'question', 'plan']) {
      assert.ok(marker(name).classList.contains('is-waiting'), 'background requests must not look merely running');
      assert.ok(h.row(`Native ${name}`).querySelector('.agent-workspace-pending'), 'pending requests have a visible label as well as color');
    }
    assert.match(marker('approval').getAttribute('aria-label'), /approval/i);
    assert.match(marker('question').getAttribute('aria-label'), /answer/i);
    assert.match(marker('plan').getAttribute('aria-label'), /review/i);
    assert.match(marker('unread').getAttribute('aria-label'), /unread/i, 'live false overrides stale running summary');
    assert.ok(marker('fallback').classList.contains('is-running'), 'missing live data retains summary status');
    assert.equal(h.row('Native archived').querySelector('.agent-workspace-pending'), null);
    await h.status(new Map([['approval', { running: false, completionUnread: true }]]));
    assert.match(marker('approval').getAttribute('aria-label'), /unread/i);
    assert.equal(h.row('Native approval').querySelector('.agent-workspace-pending'), null);
    await h.status(new Map([['approval', { running: false, completionUnread: false }]]));
    assert.doesNotMatch(marker('approval').getAttribute('aria-label'), /unread|approval|running/i, 'acknowledgement removes the completion reminder');
  } finally { await h.cleanup(); }
});

test('workspace tree uses nearest path ancestors, preserves child creation and hides descendants on collapse', async () => {
  const ws = (workspaceId, path) => ({ workspaceId, path, title: workspaceId, sessionIds: [] });
  const h = await mount({ nativeRows: [], sessions: [external('child', { cwd: '/project/sub/deep' }), external('history', { cwd: '/' })],
    workspaces: [ws('deep', '/project/sub/deep'), ws('prefix-sibling', '/project-other'), ws('parent', '/project'), ws('sub', '/project/sub')] });
  const group = path => document.querySelector(`section[aria-label="${path}"]`);
  try {
    const parent = group('/project'), sub = group('/project/sub'), deep = group('/project/sub/deep');
    assert.equal(deep.parentElement.closest('section'), sub);
    assert.equal(sub.parentElement.closest('section'), parent);
    assert.equal(parent.parentElement.closest('section'), null, 'unregistered history directories cannot adopt registered workspaces');
    assert.equal(group('/project-other').parentElement.closest('section'), null, 'text prefixes are not ancestors');
    await h.submit(deep.querySelector('form'));
    assert.equal(h.calls.create[0].workspace.path, '/project/sub/deep');
    const collapse = parent.querySelector('.agent-workspace-collapse');
    await h.click(collapse);
    assert.ok(deep.closest('[hidden]'), 'parent collapse includes nested workspace sessions');
    await h.render({ key: 'reload-tree' });
    assert.ok(group('/project/sub/deep').closest('[hidden]'), 'collapse survives content remount');
    const input = document.querySelector('#agent-workspace-search');
    const typeSearch = async (value) => act(async () => {
      Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    });
    await typeSearch('External child');
    assert.equal(group('/project/sub/deep').closest('[hidden]'), null, 'search reveals a child under collapsed ancestors');
    await typeSearch('');
    assert.ok(group('/project/sub/deep').closest('[hidden]'), 'clearing search restores the saved collapse');
    await h.change('[aria-label="Workspace grouping"]', 'workspace');
    assert.equal(group('/project/sub').parentElement.closest('section'), null);
    await h.render({ key: 'reload-flat' });
    assert.equal(group('/project/sub/deep').parentElement.closest('section'), null, 'grouping preference persists');
  } finally { await h.cleanup(); }
});
