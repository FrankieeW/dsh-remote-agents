import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import React, { act } from 'react';
import { PRIMITIVES_ALIAS } from './helpers/primitives-alias.js';

const compiled = await build({ entryPoints: ['src/client/WorkspaceSidebar.jsx'], bundle: true, write: false, format: 'cjs', external: ['react'], alias: PRIMITIVES_ALIAS });
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const native = (id, extra = {}) => ({ id, displayTitle: `Native ${id}`, cwd: '/project', blank: false, running: false, updatedAt: 1, ...extra });
const external = (id, extra = {}) => ({ id, name: `External ${id}`, provider: 'omp', cwd: '/project', status: 'idle', updatedAt: 2, ...extra });

async function mount(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  const previous = { window: globalThis.window, document: globalThis.document, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  for (const [key, value] of Object.entries(options.storage || {})) dom.window.localStorage.setItem(key, value);
  const { createRoot } = await import('react-dom/client');
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), console, setTimeout, clearTimeout, localStorage: dom.window.localStorage });
  const Component = module.exports.default;
  const listeners = new Set();
  const state = { machines: options.machines, machinesLoaded: options.machinesLoaded, remoteWorkspaces: options.remoteWorkspaces, sessions: options.sessions || [external('e1')], providers: options.providers || [{ id: 'omp', available: true }, { id: 'claude', available: false, reason: 'Claude is not installed' }], selectedId: options.selectedId || null, loading: false, error: null };
  const nativeRows = options.nativeRows || [native('n1')];
  const nativeState = { ids: nativeRows.map((row) => row.id), byId: Object.fromEntries(nativeRows.map((row) => [row.id, row])), phase: 'ready' };
  let nativeStatuses = options.nativeStatuses || new Map();
  const workspace = { workspaceId: 'w1', path: '/project', title: 'Project', sessionIds: nativeRows.filter((row) => row.cwd === '/project').map((row) => row.id) };
  const workspaces = { items: options.workspaces || [workspace], archivedSessionIds: options.archivedSessionIds || [], pinnedSessionIds: options.pinnedSessionIds || [], phase: 'ready', state: 'idle', error: null };
  const calls = { create: [], open: [], add: [], action: [] };
  let snapshot = state;
  const store = { ...options.store, getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const props = {
    useSessions: (selector) => selector(nativeState), useWorkspaces: (selector) => selector(workspaces), store,
    useSessionStatus: (selector) => selector(React.useSyncExternalStore(store.subscribe, () => nativeStatuses)),
    onCreate: async (request) => { calls.create.push(request); return options.create?.(request); },
    onOpen: async (request) => { calls.open.push(request); },
    onAddWorkspace: async (path) => { calls.add.push(path); return options.add?.(path); },
    onNativeAction: async (...args) => { calls.action.push(args); return options.action?.(...args); },
    nativeSelectedId: options.nativeSelectedId,
    ...options.props,
  };
  const root = createRoot(document.getElementById('root'));
  const render = async (more = {}) => { Object.assign(props, more); await act(async () => root.render(React.createElement(Component, props))); };
  await render();
  const click = async (node) => { assert.ok(node, 'element exists'); await act(async () => node.click()); };
  const menuItem = (scope, id) => scope.querySelector(`[role="menuitem"][data-id="${id}"]`);
  return {
    dom, calls, workspace, render, click, menuItem,
    row: (name) => [...document.querySelectorAll('.agent-workspace-open')].find((node) => node.textContent.includes(name)),
    group: (path) => document.querySelector(`section[aria-label="${path}"]`),
    /** Open a group's new-session menu and pick an agent. */
    async create(section, provider) {
      const trigger = section.querySelector('[aria-label^="New session in"]');
      await click(trigger);
      await click(menuItem(section, provider));
      return trigger;
    },
    /** Pick an entry from the header's View options menu. */
    async view(id) {
      const header = document.querySelector('.agent-workspace-header');
      await click(header.querySelector('[aria-label="View options"]'));
      await click(menuItem(header, id));
    },
    async rowAction(name, id) {
      const row = [...document.querySelectorAll('.agent-workspace-session-row')].find((node) => node.textContent.includes(name));
      await click(row.querySelector('[aria-label^="Session actions for"]'));
      await click(menuItem(row, id));
    },
    async type(selector, value) {
      const node = document.querySelector(selector);
      assert.ok(node);
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(node, value);
        node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    },
    async submit(form) { assert.ok(form); await act(async () => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); },
    async update(values) { await act(async () => { snapshot = { ...snapshot, ...values }; for (const listener of listeners) listener(); }); },
    async status(value) { await act(async () => { nativeStatuses = value; for (const listener of listeners) listener(); }); },
    async cleanup() { await act(async () => root.unmount()); assert.equal(listeners.size, 0); dom.window.close(); Object.assign(globalThis, previous); },
  };
}

test('one workspace mixes backends and creates from the compact new-session menu, never on mount', async () => {
  const gate = deferred();
  const h = await mount({ create: () => gate.promise });
  try {
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.open.length, 0);
    const group = document.querySelector('.agent-workspace-group');
    assert.equal(group.querySelectorAll('.agent-workspace-open').length, 2);
    assert.equal(group.querySelector('select, form'), null, 'no inline creation form in the sidebar');
    const trigger = await h.create(group, 'omp');
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].provider, 'omp');
    assert.equal(h.calls.create[0].workspace, h.workspace);
    assert.equal(h.calls.create[0].workspace.path, '/project');
    assert.equal(trigger.disabled, true);
    assert.equal(group.querySelector('[role="menu"]'), null, 'menu closes after choosing');
    await act(async () => trigger.click());
    assert.equal(group.querySelector('[role="menu"]'), null);
    assert.equal(h.calls.create.length, 1, 'a pending create cannot be submitted again');
    await act(async () => gate.reject(new Error('Project is unavailable')));
    assert.equal(trigger.disabled, false);
    assert.match(document.querySelector('[role="alert"]').textContent, /Project is unavailable/);
  } finally { await h.cleanup(); }
});

test('unavailable runtimes are disabled with reasons and every available agent creates directly', async () => {
  const h = await mount({ providers: [{ id: 'omp', available: false, reason: 'OMP missing' }, { id: 'claude', available: true }] });
  try {
    const group = h.group('/project');
    await h.click(group.querySelector('[aria-label="New session in Project"]'));
    assert.equal(h.menuItem(group, 'omp').disabled, true);
    assert.match(h.menuItem(group, 'omp').textContent, /OMP missing/);
    assert.equal(h.menuItem(group, 'native').disabled, false);
    await h.click(h.menuItem(group, 'native'));
    assert.equal(h.calls.create[0].provider, 'native');
    assert.equal(h.calls.create[0].workspace.path, '/project');
    await h.create(group, 'claude');
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
    assert.ok(h.group('/project').querySelector('.agent-workspace-folder.is-active'), 'the folder of the open session is highlighted');
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

test('archived rows follow the native view filter and unregistered history can create at its original cwd', async () => {
  const h = await mount({ archivedSessionIds: ['n1'], sessions: [external('e1'), external('old', { cwd: '/unregistered/project', status: 'closed', provider: 'claude' })] });
  try {
    assert.equal(h.row('Native n1'), undefined, 'archived sessions are hidden by default, like DSH');
    assert.equal(h.row('External old'), undefined);
    assert.equal(h.group('/unregistered/project'), null, 'an empty history group is not shown');
    await h.view('filter:archived');
    assert.ok(h.row('Native n1'));
    assert.ok(h.row('External old'));
    assert.equal(h.row('External e1'), undefined);
    assert.equal(document.querySelectorAll('.agent-workspace-group').length, 2);
    await h.render({ key: 'remount-with-saved-filter' });
    assert.ok(h.row('External old'), 'the filter choice persists');
    const history = h.group('/unregistered/project');
    assert.match(history.textContent, /History/);
    await h.create(history, 'omp');
    assert.equal(h.calls.create[0].workspace.path, '/unregistered/project');
    assert.equal(h.calls.create[0].provider, 'omp');
    await h.click(h.row('External old'));
    assert.equal(h.calls.open[0].provider, 'claude');
    assert.equal(h.calls.open[0].id, 'old');
    const collapse = history.querySelector('.agent-workspace-collapse');
    await h.click(collapse);
    assert.equal(collapse.getAttribute('aria-expanded'), 'false');
    assert.equal(document.getElementById(collapse.getAttribute('aria-controls')).hidden, true);
    await h.view('filter:all');
    assert.ok(h.row('External e1'));
    assert.ok(h.row('Native n1'));
  } finally { await h.cleanup(); }
});

test('native row actions use owner callbacks, rename inline, and the compact sidebar only expands', async () => {
  let expanded = 0;
  const h = await mount({ props: { expandSidebar: () => { expanded += 1; } } });
  try {
    assert.ok(document.querySelector('[aria-label="Session actions for External e1"]'), 'external rows expose their own metadata actions');
    await h.rowAction('Native n1', 'pin');
    await h.rowAction('Native n1', 'fork');
    await h.rowAction('Native n1', 'archive');
    assert.deepEqual(h.calls.action.map((args) => Array.from(args).slice(0, 2)), [['pin', 'n1'], ['fork', 'n1'], ['archive', 'n1']]);
    await h.rowAction('Native n1', 'rename');
    const input = document.querySelector('[aria-label="Rename Native n1"]');
    assert.equal(input.value, 'Native n1');
    await h.type('[aria-label="Rename Native n1"]', 'Renamed');
    await h.submit(input.closest('form'));
    assert.deepEqual(Array.from(h.calls.action.at(-1)), ['rename', 'n1', 'Renamed']);
    assert.equal(document.querySelector('[aria-label="Rename Native n1"]'), null, 'a successful rename closes the field');
    await h.render({ wide: false });
    assert.equal(document.querySelector('.agent-workspace-heading'), null);
    await h.click(document.querySelector('[aria-label="Expand workspaces"]'));
    assert.equal(expanded, 1);
    assert.equal(h.calls.open.length, 0);
  } finally { await h.cleanup(); }
});

test('native pending interactions outrank running and unread, then completion clears on acknowledgement', async () => {
  const live = (kind) => ({ running: true, completionUnread: true, pendingInteraction: { kind } });
  const h = await mount({
    sessions: [],
    storage: { 'dsh.remote-agents.workspace-filter': 'all' },
    nativeRows: [native('approval', { running: true }), native('question'), native('plan'), native('unread', { running: true }), native('fallback', { running: true }), native('archived')],
    nativeStatuses: new Map([['approval', live('approval')], ['question', live('question')], ['plan', live('plan-review')], ['unread', { running: false, completionUnread: true }], ['archived', live('approval')]]),
    archivedSessionIds: ['archived'],
  });
  const marker = (name) => h.row(`Native ${name}`).querySelector('.agent-workspace-status');
  try {
    for (const name of ['approval', 'question', 'plan']) {
      assert.ok(marker(name).classList.contains('is-waiting'), 'background requests must not look merely running');
      assert.ok(h.row(`Native ${name}`).querySelector('.agent-workspace-pending'), 'pending requests have a visible label as well as color');
      assert.ok(marker(name).querySelector('[data-state-dot="warning"]'));
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
    assert.ok(marker('approval').querySelector('svg.agent-logo'), 'idle rows show their agent mark instead of a status dot');
  } finally { await h.cleanup(); }
});

test('rows show agent marks, relative time, running dots and pins in the native slots', async () => {
  const now = Date.now();
  const h = await mount({
    nativeRows: [native('pinned', { updatedAt: now - 5 * 60_000 })],
    pinnedSessionIds: ['pinned'],
    sessions: [external('claude-run', { provider: 'claude', status: 'running', updatedAt: new Date(now - 3 * 3_600_000).toISOString() }), external('omp-idle', { updatedAt: new Date(now - 2 * 86_400_000).toISOString() })],
  });
  try {
    const pinned = h.row('Native pinned');
    assert.ok(pinned.querySelector('[aria-label="Pinned"]'));
    assert.equal(pinned.querySelector('.agent-workspace-time').textContent, '5min');
    assert.equal(pinned.querySelector('svg.agent-logo').dataset.agent, 'native');
    const running = h.row('External claude-run');
    assert.ok(running.querySelector('[data-state-dot="ongoing"]'));
    assert.match(running.querySelector('.agent-workspace-status').getAttribute('aria-label'), /Claude Code · Running/);
    assert.equal(running.querySelector('.agent-workspace-time').textContent, '3h');
    const idle = h.row('External omp-idle');
    assert.equal(idle.querySelector('svg.agent-logo').dataset.agent, 'omp');
    assert.equal(idle.querySelector('.agent-workspace-time').textContent, '2d');
    const names = [...document.querySelectorAll('.agent-workspace-session-name')].map((node) => node.textContent);
    assert.equal(names[0], 'Native pinned', 'pinned rows lead their group');
  } finally { await h.cleanup(); }
});

test('the header adds absolute workspaces only and search can be cleared', async () => {
  const h = await mount();
  try {
    await h.click(document.querySelector('[aria-label="Add workspace"]'));
    const form = document.querySelector('form[aria-label="Add workspace"]');
    await h.type('[aria-label="Workspace directory"]', 'relative/path');
    await h.submit(form);
    assert.equal(h.calls.add.length, 0);
    assert.match(form.querySelector('[role="alert"]').textContent, /absolute/);
    await h.type('[aria-label="Workspace directory"]', '/new/project');
    await h.submit(form);
    assert.deepEqual(h.calls.add, ['/new/project']);
    assert.equal(document.querySelector('form[aria-label="Add workspace"]'), null, 'the popover closes after adding');
    await h.type('#agent-workspace-search', 'nothing matches this');
    assert.match(document.querySelector('.agent-workspace-list').textContent, /No matching sessions/);
    assert.ok(document.querySelector('.agent-workspace-header').classList.contains('is-searching'));
    await h.click(document.querySelector('[aria-label="Clear search"]'));
    assert.equal(document.querySelector('#agent-workspace-search').value, '');
    assert.ok(h.row('Native n1'));
  } finally { await h.cleanup(); }
});

test('workspace tree uses nearest path ancestors, preserves child creation and hides descendants on collapse', async () => {
  const ws = (workspaceId, path) => ({ workspaceId, path, title: workspaceId, sessionIds: [] });
  const h = await mount({ nativeRows: [], sessions: [external('child', { cwd: '/project/sub/deep' }), external('history', { cwd: '/' })],
    workspaces: [ws('deep', '/project/sub/deep'), ws('prefix-sibling', '/project-other'), ws('parent', '/project'), ws('sub', '/project/sub')] });
  try {
    const parent = h.group('/project'), sub = h.group('/project/sub'), deep = h.group('/project/sub/deep');
    assert.equal(deep.parentElement.closest('section'), sub);
    assert.equal(sub.parentElement.closest('section'), parent);
    assert.equal(parent.parentElement.closest('section'), null, 'unregistered history directories cannot adopt registered workspaces');
    assert.equal(h.group('/project-other').parentElement.closest('section'), null, 'text prefixes are not ancestors');
    assert.equal(deep.style.getPropertyValue('--agent-ws-indent'), '24px', 'nested depth indents like the native tree');
    await h.create(deep, 'omp');
    assert.equal(h.calls.create[0].workspace.path, '/project/sub/deep');
    const collapse = parent.querySelector('.agent-workspace-collapse');
    await h.click(collapse);
    assert.ok(deep.closest('[hidden]'), 'parent collapse includes nested workspace sessions');
    await h.render({ key: 'reload-tree' });
    assert.ok(h.group('/project/sub/deep').closest('[hidden]'), 'collapse survives content remount');
    await h.type('#agent-workspace-search', 'External child');
    assert.equal(h.group('/project/sub/deep').closest('[hidden]'), null, 'search reveals a child under collapsed ancestors');
    await h.type('#agent-workspace-search', '');
    assert.ok(h.group('/project/sub/deep').closest('[hidden]'), 'clearing search restores the saved collapse');
    await h.view('workspace');
    assert.equal(h.group('/project/sub').parentElement.closest('section'), null);
    await h.render({ key: 'reload-flat' });
    assert.equal(h.group('/project/sub/deep').parentElement.closest('section'), null, 'grouping preference persists');
  } finally { await h.cleanup(); }
});

test('Codex creates in the chosen workspace and shares the native session list', async () => {
  const f = await mount({ providers: [{ id: 'codex', available: true }], sessions: [{ ...external('codex-1'), provider: 'codex', name: 'Codex review' }] });
  try {
    await f.create(f.group('/project'), 'codex');
    assert.equal(f.calls.create[0].provider, 'codex');
    assert.equal(f.calls.create[0].workspace.path, '/project');
    await f.click(f.row('Codex review'));
    assert.equal(f.calls.open[0].provider, 'codex');
    assert.ok(f.row('Codex review').querySelector('[data-agent="codex"]'));
  } finally { await f.cleanup(); }
});

test('remote workspaces never mix same-path local sessions or nest across hosts',async()=>{
  const remote={workspaceId:'remote-w',path:'/project',machineId:'ssh-1',machineName:'Dev',title:'Remote Project'};
  const h=await mount({remoteWorkspaces:[remote],sessions:[external('local'),external('remote',{machineId:'ssh-1'})],store:{loadProviders:async()=>[{id:'claude',available:true}]}});
  try{
    const groups=[...document.querySelectorAll('.agent-workspace-group')];assert.equal(groups.length,2);
    assert.match(groups[0].textContent,/External local/);assert.doesNotMatch(groups[0].textContent,/External remote/);assert.match(groups[1].textContent,/External remote/);
    await h.click(groups[1].querySelector('[aria-label^="New session in"]'));
    assert.equal(h.menuItem(groups[1],'native').disabled,true);await h.click(h.menuItem(groups[1],'claude'));assert.equal(h.calls.create[0].workspace.machineId,'ssh-1');
  }finally{await h.cleanup();}
});

test('remote directory autocomplete ignores stale replies, supports Tab and preserves the selected host',async()=>{
  const old=deferred(),added=[];
  const h=await mount({machines:[{id:'local',name:'Local'},{id:'ssh-1',name:'Dev',type:'ssh'}],store:{browseDirectories:async(id,path)=>path==='~/'?old.promise:{base:'/srv',entries:[{name:'code',path:'/srv/code/'}]}},props:{onAddWorkspace:async(...args)=>{added.push(args);}}});
  try{
    await h.click(document.querySelector('[aria-label="Add workspace"]'));
    await act(async()=>{const node=document.querySelector('select[aria-label="Workspace machine"]');node.value='ssh-1';node.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));});
    await act(async()=>new Promise(r=>setTimeout(r,330)));
    await h.type('[aria-label="Workspace directory"]','/srv/c');await act(async()=>new Promise(r=>setTimeout(r,330)));
    await act(async()=>old.resolve({base:'/old',entries:[{name:'old',path:'/old/'}]}));
    assert.match(document.querySelector('[role="listbox"]').textContent,/code/);assert.doesNotMatch(document.querySelector('[role="listbox"]').textContent,/old/);
    await act(async()=>document.querySelector('[aria-label="Workspace directory"]').dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
    assert.equal(document.querySelector('[aria-label="Workspace directory"]').value,'/srv/code/');
    await h.submit(document.querySelector('.agent-workspace-add-panel'));assert.deepEqual(added,[['/srv/code/','ssh-1']]);
  }finally{await h.cleanup();}
});

test('remote update button starts only an explicit update and shows its result',async()=>{
  const calls=[];
  const h=await mount({remoteWorkspaces:[{workspaceId:'remote-w',path:'/remote',machineId:'ssh-1',machineName:'Dev',title:'Remote'}],store:{loadProviders:async()=>[{id:'codex',label:'Codex',version:'0.166.0',available:false,reason:'Upgrade required'}],updatePlan:async()=>({canUpdate:true,targetVersion:'0.167.0',token:'plan',method:'npm'}),updateAgent:async(...args)=>{calls.push(args);return{id:'job',provider:'codex',status:'running'};},updateStatus:async()=>({id:'job',provider:'codex',status:'completed',version:'0.167.0',message:'Installed 0.167.0'})}});
  try{
    assert.equal(calls.length,0);await h.click(document.querySelector('[aria-label="Manage remote CLIs on Dev"]'));
    const button=[...document.querySelectorAll('button')].find(b=>b.textContent==='Install 0.167.0');await h.click(button);assert.deepEqual(calls,[['ssh-1','codex','plan']]);assert.equal(button.disabled,true);
    await act(async()=>new Promise(r=>setTimeout(r,1550)));assert.match(document.querySelector('[aria-label="Remote CLI updates"]').textContent,/Installed 0.167.0/);
  }finally{await h.cleanup();}
});

test('external sessions expose rename, archive/restore and pin without native fork',async()=>{
  const calls=[];const h=await mount({store:{sessionAction:async(...args)=>calls.push(args)}});
  try{
    await h.rowAction('External e1','pin');
    await h.rowAction('External e1','rename');await h.type('[aria-label="Rename External e1"]','Named external');await h.submit(document.querySelector('.agent-workspace-rename'));
    await h.rowAction('External e1','archive');
    assert.deepEqual(calls,[['pin','e1',undefined],['rename','e1','Named external'],['archive','e1',undefined]]);
    await h.update({sessions:[external('e1',{archived:true})]});await h.view('filter:archived');
    await h.rowAction('External e1','unarchive');assert.equal(calls.at(-1)[0],'unarchive');
  }finally{await h.cleanup();}
});

test('transcript search reveals matching history and ignores stale query results',async()=>{
  const stale=deferred();const h=await mount({sessions:[external('e1'),external('history',{cwd:'/history'})],store:{search:query=>query==='old'?stale.promise:Promise.resolve([{id:'history'}])}});
  try{
    await h.type('input[aria-label="Search sessions"]','old');await act(async()=>new Promise(r=>setTimeout(r,270)));
    await h.type('input[aria-label="Search sessions"]','unique body phrase');await act(async()=>new Promise(r=>setTimeout(r,270)));
    assert.ok(h.row('External history'));assert.equal(h.row('External e1'),undefined);
    await act(async()=>stale.resolve([{id:'e1'}]));assert.ok(h.row('External history'));assert.equal(h.row('External e1'),undefined);
  }finally{await h.cleanup();}
});

test('workspace removal requires a concrete registration confirmation and preserves sessions',async()=>{
  const removed=[];const h=await mount({props:{onRemoveWorkspace:async workspace=>removed.push(workspace.workspaceId)}});
  try{
    await h.click(document.querySelector('[aria-label="Remove workspace Project"]'));assert.equal(removed.length,0);
    assert.match(document.querySelector('[role="alertdialog"]').textContent,/Files and session history are kept/);
    await h.click([...document.querySelectorAll('button')].find(b=>b.textContent==='Remove registration'));
    assert.deepEqual(removed,['w1']);assert.ok(h.row('External e1'));
  }finally{await h.cleanup();}
});

test('the sidebar tests a new SSH destination before saving it and links to machine management',async()=>{
  const sent=[],managed=[];
  const h=await mount({machines:[{id:'local',name:'Local',type:'local'}],store:{browseDirectories:async()=>({base:'/home/me',entries:[]}),addSSHHost:async(target,options)=>{sent.push([target,JSON.parse(JSON.stringify(options))]);if(options.verify)throw new Error('The host key of box is not trusted yet. Run `ssh box` once in a terminal to verify it, then test again.');return{id:'ssh-9',name:target,type:'ssh',host:target};}},props:{onManageMachines:()=>managed.push(true)}});
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  try{
    await h.click(document.querySelector('[aria-label="Add workspace"]'));
    await act(async()=>{const node=document.querySelector('select[aria-label="Workspace machine"]');node.value='new-ssh';node.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));});
    await h.type('[aria-label="SSH destination"]','box');
    await h.click(button('Test & add'));
    assert.match(document.querySelector('.agent-workspace-add-error').textContent,/ssh box/);
    await h.click(button('Add without testing'));
    assert.deepEqual(sent,[['box',{verify:true}],['box',{verify:false}]]);
    await h.click(button('Manage machines…'));
    assert.equal(managed.length,1);
  }finally{await h.cleanup();}
});

test('history from removed or unknown machines is labelled and offers no remote actions',async()=>{
  const machines=[{id:'local',name:'Local',type:'local'},{id:'gone',name:'Old box',type:'ssh',host:'old',removedAt:'2026-01-01T00:00:00.000Z'},{id:'ssh-1',name:'Dev',type:'ssh',host:'dev',user:'me'}];
  const h=await mount({machines,sessions:[external('r1',{machineId:'gone',cwd:'/srv/app'}),external('r2',{machineId:'missing',cwd:'/srv/other'})],store:{loadProviders:async()=>[],updateAgent:async()=>({}),updateStatus:async()=>({}),updatePlan:async()=>({})}});
  try{
    const removed=h.group('/srv/app');
    assert.match(removed.textContent,/Old box · removed/);
    assert.equal(removed.querySelector('[aria-label^="New session in"]'),null);
    assert.equal(removed.querySelector('[aria-label^="Manage remote CLIs"]'),null);
    assert.ok(h.row('External r1'));
    const unknown=h.group('/srv/other');
    assert.match(unknown.textContent,/Unknown machine/);
    assert.equal(unknown.querySelector('[aria-label^="New session in"]'),null);
    await h.click(document.querySelector('[aria-label="Add workspace"]'));
    const options=[...document.querySelectorAll('select[aria-label="Workspace machine"] option')].map(o=>o.textContent);
    assert.ok(options.includes('Dev · me@dev'),options.join());
    assert.ok(!options.some(o=>o.includes('Old box')),options.join());
  }finally{await h.cleanup();}
});

test('remote history keeps its actions until the machine catalog has loaded',async()=>{
  const h=await mount({machines:[{id:'local',name:'Local',type:'local'}],machinesLoaded:false,sessions:[external('r1',{machineId:'ssh-1',cwd:'/srv/app'})],store:{loadProviders:async()=>[]}});
  try{
    const group=h.group('/srv/app');
    assert.doesNotMatch(group.textContent,/Unknown machine/);
    assert.ok(group.querySelector('[aria-label^="New session in"]'));
  }finally{await h.cleanup();}
});

test('a new SSH host can be picked from the SSH config',async()=>{
  const h=await mount({machines:[{id:'local',name:'Local',type:'local'}],store:{addSSHHost:async()=>({id:'m2'}),sshConfigHosts:async()=>({hosts:[{alias:'lab',hostName:'lab.example'},{alias:'dev',machineId:'m1'}],warnings:[]})}});
  try{
    await h.click(document.querySelector('[aria-label="Add workspace"]'));
    await act(async()=>{const node=document.querySelector('select[aria-label="Workspace machine"]');node.value='new-ssh';node.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));});
    await act(async()=>new Promise(r=>setTimeout(r,0)));
    const input=document.querySelector('[aria-label="SSH destination"]');
    const options=[...document.getElementById(input.getAttribute('list')).querySelectorAll('option')];
    assert.deepEqual(options.map(o=>o.value),['lab']);
    assert.match(options[0].textContent,/lab\.example/);
  }finally{await h.cleanup();}
});
