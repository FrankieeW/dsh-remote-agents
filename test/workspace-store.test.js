import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStore } from '../src/client/workspace-store.js';

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

test('a late catalog cannot hide a created session or reopen a closed session, while other rows still refresh', async () => {
  const read = deferred();
  const store = createWorkspaceStore(() => read.promise);
  try {
    store.start();
    store.update({ id: 'new', provider: 'omp', cwd: '/project', status: 'idle' });
    store.update({ id: 'closed', provider: 'claude', cwd: '/project', status: 'closed' });
    read.resolve({ providers: [], sessions: [{ id: 'closed', status: 'idle' }, { id: 'other', status: 'running' }] });
    await read.promise;
    assert.deepEqual(store.getSnapshot().sessions.map(({ id, status }) => ({ id, status })), [
      { id: 'closed', status: 'closed' }, { id: 'new', status: 'idle' }, { id: 'other', status: 'running' },
    ]);
  } finally { store.dispose(); }
});

test('adding an SSH host sends the destination and verification choice, then reloads machines', async () => {
  const calls = [];
  const store = createWorkspaceStore(async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    return endpoint === 'workspaceCatalog' ? { machines: [], workspaces: [] } : { id: 'm1' };
  });
  assert.deepEqual(await store.addSSHHost('u@box', { verify: true }), { id: 'm1' });
  await store.addSSHHost('u@box', { verify: false });
  assert.deepEqual(calls, [
    ['addMachine', { target: 'u@box', verify: true }], ['workspaceCatalog', undefined],
    ['addMachine', { target: 'u@box', verify: false }], ['workspaceCatalog', undefined],
  ]);
});

test('machine labels wait for a successful catalog load', async () => {
  let offline = true;
  const store = createWorkspaceStore(async (endpoint) => {
    if (endpoint !== 'workspaceCatalog') return { sessions: [], providers: [] };
    if (offline) throw new Error('offline');
    return { machines: [{ id: 'local', name: 'Local', type: 'local' }], workspaces: [] };
  });
  assert.equal(store.getSnapshot().machinesLoaded, false);
  await store.loadWorkspaces();
  assert.equal(store.getSnapshot().machinesLoaded, false);
  offline = false;
  await store.loadWorkspaces();
  assert.equal(store.getSnapshot().machinesLoaded, true);
});

test('SSH config suggestions come from the host', async () => {
  const calls = [];
  const store = createWorkspaceStore(async (endpoint, payload) => { calls.push([endpoint, payload]); return { hosts: [], warnings: [] }; });
  assert.deepEqual(await store.sshConfigHosts(), { hosts: [], warnings: [] });
  assert.deepEqual(calls, [['sshConfigHosts', undefined]]);
});
