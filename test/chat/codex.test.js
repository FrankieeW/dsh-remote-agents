import test from 'node:test';
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createCodexProvider } from '../reference/src/chat/codex.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const frames = [], events = [], launches = [], approvals = [];
  let child, turnNumber = 0;
  const threadId = options.resume || 'thread-1';
  const send = frame => child.stdout.write(`${JSON.stringify(frame)}\n`);
  const notify = (method, params = {}) => send({ method, params: { threadId, turnId: `turn-${turnNumber}`, ...params } });
  const reply = (id, result) => send({ id, result });
  const factory = createCodexProvider({ requestTimeout: 1000, closeGrace: 1, ...options,
    spawnFn(file, args, config) {
      launches.push({ file, args, config });
      child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = [];
      child.kill = sig => { child.kills.push(sig); child.emit('exit', null, sig); };
      child.stdin = new Writable({ write(bytes, encoding, cb) {
        const frame = JSON.parse(bytes.toString()); frames.push(frame); cb();
        if (options.respond === false) return;
        queueMicrotask(() => {
          if (frame.method === 'config/read') reply(frame.id, { config: { model: 'cli-model', model_reasoning_effort: 'medium', approval_policy: 'on-request', sandbox_mode: 'read-only' } });
          if (frame.method === 'initialize') reply(frame.id, { userAgent: 'codex/0.167.0' });
          if (['thread/start', 'thread/resume'].includes(frame.method)) reply(frame.id, { thread: { id: options.wrongThread || threadId, cwd: '/tmp' } });
          if (frame.method === 'turn/start') {
            turnNumber++;
            options.beforeAck?.({ notify, send });
            reply(frame.id, { turn: { id: `turn-${turnNumber}`, status: 'inProgress' } });
          }
        });
      }});
      return child;
    },
  });
  return { frames, events, launches, approvals, send, notify, get child() { return child; },
    async adapter(extra = {}) { return factory({ session: { id: 'app-1', cwd: '/tmp', providerSessionId: options.resume },
      emit: (type, payload) => events.push({ type, ...payload }), requestApproval: async request => { approvals.push(request); return options.allow === true; }, ...extra }); },
    complete(status = 'completed', params = {}) { notify('turn/completed', { turn: { id: `turn-${turnNumber}`, status, ...params } }); },
    async started(adapter, prompt = 'hello') { const result = adapter.send(prompt); result.catch(() => {}); for (let i = 0; i < 100 && !frames.some(f => f.method === 'turn/start'); i++) await new Promise(r => setTimeout(r, 1)); await tick(); return { result }; },
  };
}

test('Codex is lazy, initializes, creates an owned thread and deduplicates complete text', async t => {
  const h = harness(), adapter = await h.adapter(); t.after(() => adapter.close());
  assert.equal(h.launches.length, 0);
  const { result } = await h.started(adapter);
  assert.deepEqual(h.launches[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(h.launches[0].config.shell, false);
  const start = h.frames.find(frame => frame.method === 'thread/start');
  assert.deepEqual(start.params, { cwd: await realpath('/tmp'), approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write' });
  h.notify('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello ' });
  h.notify('item/agentMessage/delta', { itemId: 'msg-1', delta: 'world' });
  h.notify('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text: 'Hello world' } });
  h.notify('item/completed', { item: { type: 'agentMessage', id: 'msg-2', text: 'Done.' } });
  h.complete(); await result;
  assert.equal(h.events.filter(e => e.type === 'text.delta').map(e => e.text).join(''), 'Hello world\n\nDone.');
  assert.equal(h.events.at(-1).text, 'Hello world\n\nDone.');
  assert.deepEqual(h.events[0], { type: 'provider.session', id: 'thread-1' });
  const next = await h.started(adapter, 'next');
  h.notify('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'stale', delta: 'WRONG' });
  h.notify('item/agentMessage/delta', { threadId: 'foreign', itemId: 'stale', delta: 'WRONG' });
  h.complete(); await next.result;
  assert.equal(h.launches.length, 1);
  assert.ok(!h.events.some(e => e.text?.includes('WRONG')));
});

test('notifications received before turn ACK, including completion, are correlated and replayed', async t => {
  const h = harness({ beforeAck: ({ notify }) => {
    notify('item/completed', { item: { type: 'agentMessage', id: 'm', text: 'fast' } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  }});
  const adapter = await h.adapter(); t.after(() => adapter.close()); await adapter.send('hello');
  assert.equal(h.events.at(-1).text, 'fast');
});

test('commands, file changes, plan updates and MCP calls retain structured results', async t => {
  const h = harness(), adapter = await h.adapter(); t.after(() => adapter.close());
  const { result } = await h.started(adapter);
  const command = { type: 'commandExecution', id: 'cmd', command: 'pwd', cwd: '/tmp' };
  h.notify('item/started', { item: command });
  h.notify('item/commandExecution/outputDelta', { itemId: 'cmd', delta: '/tmp' });
  h.notify('item/completed', { item: { ...command, status: 'completed', aggregatedOutput: '/tmp', exitCode: 0 } });
  h.notify('item/completed', { item: { type: 'fileChange', id: 'patch', changes: [{ path: '/tmp/a', diff: '-a\n+b' }], status: 'completed' } });
  h.notify('turn/plan/updated', { plan: [{ step: 'Verify', status: 'inProgress' }], explanation: 'Next step' });
  h.notify('item/completed', { item: { type: 'mcpToolCall', id: 'mcp', server: 'docs', tool: 'read', arguments: {}, result: { content: [{ text: 'docs' }] }, status: 'completed' } });
  h.complete(); await result;
  assert.equal(h.events.filter(e => e.type === 'tool.start' && e.id === 'cmd').length, 1);
  assert.equal(h.events.find(e => e.type === 'tool.end' && e.id === 'cmd').result.details.exitCode, 0);
  assert.equal(h.events.find(e => e.name === 'fileChange').input.changes[0].diff, '-a\n+b');
  assert.deepEqual(h.events.find(e => e.name === 'update_plan').input.todos, [{ content: 'Verify', status: 'in_progress' }]);
  assert.ok(h.events.some(e => e.name === 'mcp__docs__read'));
});

for (const allow of [true, false]) test(`command/file approvals answer once with ${allow ? 'accept' : 'decline'}`, async t => {
  const h = harness({ allow }), adapter = await h.adapter(); t.after(() => adapter.close());
  const { result } = await h.started(adapter);
  for (const [id, kind] of [[101, 'commandExecution'], [102, 'fileChange']]) {
    h.send({ id, method: `item/${kind}/requestApproval`, params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd', command: 'pwd' } });
  }
  await tick();
  assert.equal(h.approvals.length, 2);
  assert.deepEqual(h.frames.filter(f => [101, 102].includes(f.id)).map(f => f.result.decision), [allow ? 'accept' : 'decline', allow ? 'accept' : 'decline']);
  h.send({ id: 103, method: 'item/commandExecution/requestApproval', params: { threadId: 'other', turnId: 'turn-1' } });
  await tick(); assert.equal(h.frames.find(f => f.id === 103).result.decision, 'decline');
  h.complete(); await result;
});

test('resolved and interrupted approval callbacks cannot grant late authority', async t => {
  const h = harness(); let decide;
  const adapter = await h.adapter({ requestApproval: request => { h.approvals.push(request); return new Promise(resolve => { decide = resolve; }); } });
  t.after(() => adapter.close()); const { result } = await h.started(adapter);
  h.send({ id: 8, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  await tick(); h.notify('serverRequest/resolved', { requestId: 8 });
  assert.equal(h.approvals[0].signal.aborted, true); decide(true); await tick();
  assert.ok(!h.frames.some(f => f.id === 8));
  const rejected = assert.rejects(result, /closed/); await adapter.abort(); await rejected;
  assert.ok(h.frames.some(f => f.method === 'turn/interrupt' && f.params.turnId === 'turn-1'));
  assert.deepEqual(h.child.kills, ['SIGTERM']);
});

test('resume only the saved thread ID and reject mismatched identity', async t => {
  const h = harness({ resume: 'owned' }), adapter = await h.adapter(); t.after(() => adapter.close());
  const { result } = await h.started(adapter); h.complete(); await result;
  assert.equal(h.frames.find(f => f.method === 'thread/resume').params.threadId, 'owned');
  const bad = harness({ resume: 'owned', wrongThread: 'other' }), badAdapter = await bad.adapter(); t.after(() => badAdapter.close());
  await assert.rejects(badAdapter.send('hello'), /identity/);
  assert.ok(!bad.frames.some(f => f.method === 'turn/start'));
});

test('unsupported rich questions and extra permission requests fail visibly without granting', async t => {
  for (const method of ['item/tool/requestUserInput', 'item/permissions/requestApproval']) {
    const h = harness(), adapter = await h.adapter(); t.after(() => adapter.close());
    const { result } = await h.started(adapter);
    h.send({ id: 9, method, params: { threadId: 'thread-1', turnId: 'turn-1' } });
    await assert.rejects(result, /Unsupported interaction/);
    const response = h.frames.find(f => f.id === 9);
    if (method.includes('permissions')) assert.deepEqual(response.result.permissions, {});
    else assert.equal(response.error.code, -32601);
  }
});

test('failed turns, malformed/oversized frames, startup timeout and exit reject without stderr disclosure', async t => {
  for (const mode of ['failed', 'json', 'size', 'timeout', 'exit', 'eof']) {
    const h = harness(mode === 'timeout' ? { respond: false, requestTimeout: 10 } : {});
    const adapter = await h.adapter(); t.after(() => adapter.close());
    const { result } = await h.started(adapter);
    h.child.stderr.write('SECRET');
    if (mode === 'failed') h.complete('failed', { error: { message: 'model unavailable' } });
    if (mode === 'json') h.child.stdout.write('invalid\n');
    if (mode === 'size') h.child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    if (mode === 'exit') h.child.emit('exit', 1);
    if (mode === 'eof') { h.child.stdout.write('{'); h.child.stdout.end(); }
    await assert.rejects(result, e => !e.message.includes('SECRET'));
  }
});

test('Codex explicit settings override CLI defaults; Follow CLI uses native configuration',async t=>{
  for(const settings of [{model:'chosen',effort:'high',permissions:'yolo'},{model:null,effort:null,permissions:'cli'}]){
    const h=harness(),adapter=await h.adapter({session:{id:'app-1',cwd:'/tmp',settings}});t.after(()=>adapter.close());const{result}=await h.started(adapter);h.complete();await result;
    const params=h.frames.find(f=>f.method==='thread/start').params;
    assert.equal(params.model,settings.model||'cli-model');assert.equal(params.config.model_reasoning_effort,settings.effort||'medium');
    assert.equal(params.sandbox,settings.permissions==='yolo'?'danger-full-access':'read-only');assert.equal(params.approvalPolicy,settings.permissions==='yolo'?'never':'on-request');
  }
});
