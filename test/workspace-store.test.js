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
