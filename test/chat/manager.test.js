import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatManager } from '../../src/chat/manager.js';

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function fixture(providers) {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-manager-test-'));
  const statePath = join(cwd, 'chat.json');
  const manager = new ChatManager({ statePath, providers, saveDebounceMs: 5, shutdownTimeoutMs: 20 });
  return { cwd, statePath, manager };
}
async function until(fn, check = value => value) {
  for (let index = 0; index < 200; index++) { const result = await fn(); if (check(result)) return result; await delay(5); }
  throw new Error('Test condition did not settle');
}
function trackedAbort() {
  const controller = new AbortController();
  const listeners = new Set();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(type, listener, options) { listeners.add(listener); controller.signal.addEventListener(type, listener, options); },
    removeEventListener(type, listener) { listeners.delete(listener); controller.signal.removeEventListener(type, listener); },
  };
  return { controller, signal, listeners };
}
function fake(body) {
  return async context => ({ send: text => body(context, text), abort: async () => {}, close: async () => {} });
}

test('create/list are inert; send acknowledges before fake turn ends and uses one assistant', async () => {
  const turn = deferred();
  let factories = 0;
  const f = await fixture({ claude: async context => { factories++; return { send: async text => { context.emit('text.delta', { text: `echo ${text}` }); await turn.promise; context.emit('text.done', { text: 'complete response' }); }, abort: async () => {}, close: async () => {} }; } });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  assert.equal(factories, 0);
  assert.equal(session.status, 'idle');
  assert.equal((await f.manager.list())[0].messageCount, 0);
  assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
  const accepted = await f.manager.send({ id: session.id, text: 'hello', requestId: 'req-1' });
  assert.equal(accepted.accepted, true);
  assert.equal(factories, 1);
  const running = await f.manager.get(session.id);
  assert.equal(running.status, 'running');
  assert.equal(running.messages.length, 2);
  assert.equal(running.messages[1].role, 'assistant');
  assert.equal(running.messages[1].id, accepted.assistantMessageId);
  turn.resolve();
  const done = await until(() => f.manager.get(session.id), value => value.status === 'idle');
  assert.equal(done.messages[1].text, 'complete response');
  assert.equal((await f.manager.list())[0].messageCount, 2);
  assert.equal(Object.hasOwn((await f.manager.list())[0], 'messages'), false);
  await f.manager.dispose();
});

test('idempotent request IDs survive restart; busy/conflicting text/provider rejected', async () => {
  const turn = deferred(); let sends = 0;
  const providers = { omp: fake(async () => { sends++; await turn.promise; }), claude: fake(async () => {}) };
  const f = await fixture(providers);
  const session = await f.manager.create({ provider: 'omp', cwd: f.cwd });
  const input = { id: session.id, text: 'hello', requestId: 'same' };
  await f.manager.send(input);
  assert.equal((await f.manager.send(input)).duplicate, true);
  await assert.rejects(f.manager.send({ ...input, text: 'different' }), { code: 'CONFLICT' });
  await assert.rejects(f.manager.send({ ...input, requestId: 'other' }), { code: 'BUSY' });
  await assert.rejects(f.manager.send({ ...input, provider: 'claude' }), { code: 'UNSUPPORTED' });
  assert.equal(sends, 1);
  turn.resolve();
  await until(() => f.manager.get(session.id), value => value.status === 'idle');
  await f.manager.dispose();
  const restarted = new ChatManager({ statePath: f.statePath, providers });
  assert.equal((await restarted.send(input)).duplicate, true);
  assert.equal(sends, 1);
  await restarted.dispose();
});

test('approvals are session-bound, explicit, one-shot and never persisted', async () => {
  const decisions = [];
  const f = await fixture({ claude: fake(async context => {
    decisions.push(await context.requestApproval({ id: 'provider-id', kind: 'tool', title: 'Write file?', description: 'Requested change', details: { path: '/tmp/example' } }));
    context.emit('text.done', { text: 'finished' });
  }) });
  const a = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  const b = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: a.id, text: 'write', requestId: '1' });
  const waiting = await until(() => f.manager.get(a.id), value => value.status === 'waiting');
  const approvalId = waiting.pendingApprovals[0].id;
  assert.notEqual(approvalId, 'provider-id');
  assert.equal(decisions.length, 0);
  await assert.rejects(f.manager.approve({ id: b.id, approvalId, allow: true }), { code: 'APPROVAL_NOT_FOUND' });
  await assert.rejects(f.manager.approve({ id: a.id, approvalId, allow: 'yes' }), { code: 'INVALID_INPUT' });
  await delay(20);
  assert.ok(!(await readFile(f.statePath, 'utf8')).includes(approvalId));
  assert.ok(!(await readFile(f.statePath, 'utf8')).includes('pendingApprovals'));
  await f.manager.approve({ id: a.id, approvalId, allow: false });
  await assert.rejects(f.manager.approve({ id: a.id, approvalId, allow: true }), { code: 'APPROVAL_NOT_FOUND' });
  await until(() => f.manager.get(a.id), value => value.status === 'idle');
  assert.deepEqual(decisions, [false]);
  await f.manager.dispose();
});

test('interrupt denies approvals and ignores late output; new send gets a fresh runtime', async () => {
  let firstContext; let calls = 0; const decisions = [];
  const f = await fixture({ omp: fake(async context => {
    calls++;
    if (calls === 1) { firstContext = context; decisions.push(await context.requestApproval({ title: 'Continue?' })); context.emit('text.done', { text: 'late forbidden' }); }
    else context.emit('text.done', { text: 'new turn' });
  }) });
  const session = await f.manager.create({ provider: 'omp', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'first', requestId: '1' });
  await until(() => f.manager.get(session.id), value => value.status === 'waiting');
  const interrupted = await f.manager.interrupt(session.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.pendingApprovals.length, 0);
  assert.equal(firstContext.signal.aborted, true);
  assert.deepEqual(decisions, [false]);
  await f.manager.send({ id: session.id, text: 'second', requestId: '2' });
  firstContext.emit('text.delta', { text: 'stale' });
  const done = await until(() => f.manager.get(session.id), value => value.status === 'idle');
  assert.equal(done.messages[1].text, '');
  assert.equal(done.messages[3].text, 'new turn');
  assert.equal(calls, 2);
  await f.manager.dispose();
});

test('restored running/waiting sessions become interrupted and resume only on explicit send', async () => {
  let factoryContext; const blocked = deferred();
  const f = await fixture({ claude: fake(async context => { context.emit('provider.session', { id: 'native-session-123' }); await blocked.promise; }) });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'before crash', requestId: '1' });
  const saved = await until(async () => JSON.parse(await readFile(f.statePath, 'utf8')), state => state.sessions[0].providerSessionId === 'native-session-123');
  saved.sessions[0].status = 'waiting';
  saved.sessions[0].pendingApprovals = [{ id: 'must-not-survive' }];
  const crashPath = join(f.cwd, 'crashed.json');
  await writeFile(crashPath, JSON.stringify(saved));
  let factories = 0;
  const restarted = new ChatManager({ statePath: crashPath, providers: { claude: fake(async () => {}) } });
  restarted.providers.claude = async context => { factories++; factoryContext = context; return { send: async () => {}, abort: async () => {}, close: async () => {} }; };
  const restored = await restarted.get(session.id);
  assert.equal(restored.status, 'interrupted');
  assert.deepEqual(restored.pendingApprovals, []);
  assert.equal(factories, 0);
  await assert.rejects(restarted.approve({ id: session.id, approvalId: 'must-not-survive', allow: true }), { code: 'APPROVAL_NOT_FOUND' });
  await restarted.send({ id: session.id, text: 'resume', requestId: '2' });
  assert.equal(factoryContext.session.providerSessionId, 'native-session-123');
  await restarted.dispose();
  await f.manager.dispose();
  blocked.resolve();
});

test('provider errors are caught, visible and not silently retried', async () => {
  let calls = 0;
  const f = await fixture({ claude: fake(async () => { calls++; throw new Error('\u001b[31mAuthentication failed\nplease configure provider'); }) });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  const input = { id: session.id, text: 'hello', requestId: '1' };
  assert.equal((await f.manager.send(input)).accepted, true);
  const failed = await until(() => f.manager.get(session.id), value => value.status === 'error');
  assert.equal(failed.error, 'Authentication failed please configure provider');
  assert.equal((await f.manager.send(input)).duplicate, true);
  assert.equal(calls, 1);
  await f.manager.dispose();
});

test('text and tool values are bounded with explicit truncation indicators', async () => {
  const f = await fixture({ omp: fake(async ({ emit }) => {
    emit({ type: 'text.delta', text: 'x'.repeat(100000) });
    for (let index = 0; index < 20; index++) {
      emit('tool.start', { id: `tool-${index}`, name: 'read', input: { data: 'a'.repeat(10000) } });
      emit('tool.update', { id: `tool-${index}`, text: 'b'.repeat(10000) });
      emit('tool.end', { id: `tool-${index}`, result: { data: 'c'.repeat(10000) }, isError: index === 0 });
    }
  }) });
  const session = await f.manager.create({ provider: 'omp', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'test', requestId: '1' });
  const done = await until(() => f.manager.get(session.id), value => value.status === 'idle');
  const message = done.messages[1];
  assert.equal(message.text.length, 65536);
  assert.equal(message.textTruncated, true);
  assert.equal(message.tools.length, 16);
  assert.equal(message.toolsTruncated, true);
  assert.equal(message.tools[0].status, 'error');
  assert.equal(message.tools[0].truncated, true);
  assert.ok(message.tools[0].text.length <= 4096);
  assert.ok(message.tools[0].input.length <= 4097);
  assert.ok(message.tools[0].result.length <= 4097);
  await f.manager.dispose();
});

test('tool.input updates existing arguments without duplicating or changing tool identity', async () => {
  const f = await fixture({ claude: fake(async ({ emit }) => {
    emit('tool.input', { id: 'missing', input: { ignored: true } });
    emit('tool.start', { id: 'read-1', name: 'Read', input: {} });
    emit('tool.input', { id: 'read-1', input: { path: '/project/file', offset: 10 }, name: 'must-not-change', status: 'error' });
    emit('tool.start', { id: 'read-1', name: 'duplicate', input: { wrong: true } });
    emit('tool.end', { id: 'read-1', result: 'content', isError: false });
    emit('tool.start', { id: 'large', name: 'Write', input: {} });
    emit({ type: 'tool.input', id: 'large', input: { content: 'x'.repeat(10000) } });
    emit('tool.input', { id: 'new-id', input: { ignored: true } });
  }) });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'read', requestId: '1' });
  const done = await until(() => f.manager.get(session.id), value => value.status === 'idle');
  const tools = done.messages[1].tools;
  assert.equal(tools.length, 2);
  assert.equal(tools[0].id, 'read-1');
  assert.equal(tools[0].name, 'Read');
  assert.deepEqual(tools[0].input, { path: '/project/file', offset: 10 });
  assert.equal(tools[0].status, 'done');
  assert.equal(tools[0].result, 'content');
  assert.equal(tools[0].truncated, false);
  assert.equal(tools[1].id, 'large');
  assert.equal(tools[1].status, 'running');
  assert.equal(tools[1].truncated, true);
  assert.ok(tools[1].input.length <= 4097);
  await f.manager.dispose();
  const saved = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.deepEqual(saved.sessions[0].messages[1].tools[0].input, { path: '/project/file', offset: 10 });
});

test('dispose is bounded even for hanging adapters and rejects future use', async () => {
  const never = new Promise(() => {});
  const f = await fixture({ omp: async () => ({ send: () => never, abort: () => never, close: () => never }) });
  const session = await f.manager.create({ provider: 'omp', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'hang', requestId: '1' });
  const start = Date.now();
  await f.manager.dispose();
  assert.ok(Date.now() - start < 500);
  assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).sessions[0].status, 'interrupted');
  await assert.rejects(f.manager.get(session.id), { code: 'DISPOSED' });
  await f.manager.dispose();
});

test('late factory completion after close never sends and closes its adapter', async () => {
  const creation = deferred(); let sent = 0; let closed = 0;
  const f = await fixture({ claude: async () => creation.promise });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'hello', requestId: '1' });
  assert.equal((await f.manager.close(session.id)).status, 'closed');
  creation.resolve({ send: async () => { sent++; }, abort: async () => {}, close: async () => { closed++; } });
  await until(() => closed);
  assert.equal(sent, 0);
  await assert.rejects(f.manager.send({ id: session.id, text: 'later', requestId: '2' }), { code: 'CLOSED' });
  await f.manager.dispose();
});

test('explicit allow resolves true, adapters reuse normally, and close denies a later approval', async () => {
  let factories = 0; const decisions = [];
  const f = await fixture({ claude: async context => {
    factories++;
    return { send: async () => { decisions.push(await context.requestApproval({ title: 'Approve?' })); }, abort: async () => {}, close: async () => {} };
  } });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'first', requestId: '1' });
  const first = await until(() => f.manager.get(session.id), value => value.pendingApprovals.length);
  await f.manager.approve({ id: session.id, approvalId: first.pendingApprovals[0].id, allow: true });
  await until(() => f.manager.get(session.id), value => value.status === 'idle');
  await f.manager.send({ id: session.id, text: 'second', requestId: '2' });
  await until(() => f.manager.get(session.id), value => value.pendingApprovals.length);
  const separate = await f.manager.create({ provider: 'claude', cwd: f.cwd, name: 'Concurrent management' });
  assert.equal(separate.status, 'idle');
  await f.manager.close(session.id);
  assert.deepEqual(decisions, [true, false]);
  assert.equal(factories, 1);
  await f.manager.dispose();
});

test('already aborted dialog signals deny without registering or displaying approval', async () => {
  const dialog = trackedAbort(); dialog.controller.abort();
  let decision;
  const f = await fixture({ claude: fake(async context => { decision = await context.requestApproval({ title: 'Expired', signal: dialog.signal }); }) });
  const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'test', requestId: '1' });
  const done = await until(() => f.manager.get(session.id), value => value.status === 'idle');
  assert.equal(decision, false);
  assert.deepEqual(done.pendingApprovals, []);
  assert.equal(dialog.listeners.size, 0);
  await f.manager.dispose();
});

test('one dialog abort removes only itself and approval settles the remaining listener', async () => {
  const first = trackedAbort(); const second = trackedAbort(); const finish = deferred();
  const decisions = [];
  const f = await fixture({ omp: fake(async context => {
    const a = context.requestApproval({ title: 'First', signal: first.signal }).then(value => { decisions.push(['first', value]); });
    const b = context.requestApproval({ title: 'Second', signal: second.signal }).then(value => { decisions.push(['second', value]); });
    await Promise.all([a, b]); await finish.promise;
  }) });
  const session = await f.manager.create({ provider: 'omp', cwd: f.cwd });
  await f.manager.send({ id: session.id, text: 'test', requestId: '1' });
  const pending = await until(() => f.manager.get(session.id), value => value.pendingApprovals.length === 2);
  const firstId = pending.pendingApprovals.find(value => value.title === 'First').id;
  const secondId = pending.pendingApprovals.find(value => value.title === 'Second').id;
  first.controller.abort();
  const remaining = await f.manager.get(session.id);
  assert.equal(remaining.status, 'waiting');
  assert.equal(remaining.pendingApprovals.length, 1);
  assert.equal(remaining.pendingApprovals[0].id, secondId);
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 1);
  await assert.rejects(f.manager.approve({ id: session.id, approvalId: firstId, allow: true }), { code: 'APPROVAL_NOT_FOUND' });
  await f.manager.approve({ id: session.id, approvalId: secondId, allow: true });
  assert.equal(second.listeners.size, 0);
  assert.equal((await f.manager.get(session.id)).status, 'running');
  second.controller.abort();
  assert.deepEqual(decisions, [['first', false], ['second', true]]);
  finish.resolve();
  await until(() => f.manager.get(session.id), value => value.status === 'idle');
  await f.manager.dispose();
});

test('last dialog abort restores running and lifecycle denial removes listeners', async () => {
  for (const operation of ['abort-dialog', 'interrupt', 'close', 'dispose']) {
    const dialog = trackedAbort(); const finish = deferred(); let decision;
    const f = await fixture({ claude: fake(async context => { decision = await context.requestApproval({ title: 'Dialog', signal: dialog.signal }); await finish.promise; }) });
    const session = await f.manager.create({ provider: 'claude', cwd: f.cwd });
    await f.manager.send({ id: session.id, text: 'test', requestId: '1' });
    await until(() => f.manager.get(session.id), value => value.status === 'waiting');
    assert.equal(dialog.listeners.size, 1);
    if (operation === 'abort-dialog') dialog.controller.abort();
    else if (operation === 'dispose') await f.manager.dispose();
    else await f.manager[operation](session.id);
    await until(() => decision !== undefined);
    assert.equal(decision, false);
    assert.equal(dialog.listeners.size, 0);
    if (operation !== 'dispose') {
      const snapshot = await f.manager.get(session.id);
      assert.equal(snapshot.pendingApprovals.length, 0);
      assert.equal(snapshot.status, operation === 'abort-dialog' ? 'running' : operation === 'interrupt' ? 'interrupted' : 'closed');
    }
    finish.resolve();
    await f.manager.dispose();
  }
});

test('local real directory and supported provider validations never call factories', async () => {
  let calls = 0;
  const f = await fixture({ claude: async () => { calls++; } });
  for (const changes of [{ provider: 'codex' }, { cwd: 'relative' }, { cwd: join(f.cwd, 'missing') }, { machineId: 'remote' }, { remote: true }, { cwd: '/tmp\npath' }]) await assert.rejects(f.manager.create({ provider: 'claude', cwd: f.cwd, ...changes }));
  await writeFile(join(f.cwd, 'file'), 'not a directory');
  await assert.rejects(f.manager.create({ provider: 'claude', cwd: join(f.cwd, 'file') }), { code: 'INVALID_INPUT' });
  assert.equal(calls, 0);
  await f.manager.dispose();
});
