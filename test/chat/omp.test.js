import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOmpProvider } from '../../src/chat/omp.js';

// All subprocesses here are in-memory fakes: never execute omp or load user credentials/sessions.
class FakeChild extends EventEmitter {
  constructor(onCommand, { ready = true, stuck = false, backpressure = false } = {}) {
    super(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.commands = []; this.kills = []; this.stuck = stuck;
    this.stdin = new Writable({ highWaterMark: backpressure ? 1 : 16384, write: (bytes, encoding, callback) => {
      const command = JSON.parse(bytes.toString()); this.commands.push(command);
      queueMicrotask(() => { onCommand(command, this); if (!backpressure) callback(); else this.releaseWrite = callback; });
    } });
    this.stdin.on('finish', () => { if (!stuck) this.finish(); });
    if (ready) queueMicrotask(() => this.frame({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
  }
  frame(value) { this.stdout.write(JSON.stringify(value) + '\n'); }
  ack(command, data) { this.frame({ type: 'response', id: command.id, command: command.type, success: true, data }); }
  finish() { if (this.finished) return; this.finished = true; this.stdout.end(); this.emit('exit', 0, null); }
  kill(signal) { this.kills.push(signal); if (signal === 'SIGKILL' || !this.stuck) this.finish(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'omp-fake-')));
  // root is the exact mkdtemp result created above; cleanup never touches user data.
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], events = [], approvals = [], commands = [];
  const commandEvents = new EventEmitter();
  // Subscribe before send; filesystem startup may take arbitrarily many event-loop turns.
  const waitForCommand = (predicate, after = 0) => {
    const existing = commands.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveCommand, rejectCommand) => {
      const cleanup = () => { clearTimeout(timer); commandEvents.off('command', onCommand); };
      const onCommand = command => { if (predicate(command)) { cleanup(); resolveCommand(command); } };
      const timer = setTimeout(() => { cleanup(); rejectCommand(new Error('Fake subprocess command wait timed out')); }, 5000);
      commandEvents.on('command', onCommand);
    });
  };
  let child;
  const factory = createOmpProvider({ sessionRoot: root, startupTimeout: 5000, requestTimeout: 5000, closeGrace: 5, ...options.provider,
    spawnFn: (exe, argv, settings) => {
      calls.push({ exe, argv, settings });
      child = new FakeChild((command, process) => {
        commands.push(command); commandEvents.emit('command', command);
        if (command.type === 'negotiate_protocol') process.ack(command, { protocolVersion: 2 });
        else if (command.type === 'get_state') process.ack(command, { sessionId: options.nativeId || 'native-1', sessionFile: join(root, 'app-1', 'native.jsonl'), ...options.state });
        else options.onCommand?.(command, process);
      }, options.fake);
      return child;
    },
  });
  const adapter = await factory({ session: { id: 'app-1', cwd: root, ...options.session }, signal: options.signal,
    emit: (type, value) => events.push({ type, ...value }), requestApproval: request => { approvals.push(request); return options.approve?.(request) ?? false; } });
  t.after(() => adapter.close());
  const prompt = async text => {
    const commandReady = waitForCommand(command => command.type === 'prompt', commands.length);
    const promise = adapter.send(text); promise.catch(() => {});
    const command = await commandReady;
    assert.ok(child, 'prompt command implies the fake subprocess has spawned');
    return { promise, command };
  };
  return { adapter, prompt, waitForCommand, calls, events, approvals, root, get child() { return child; } };
}
function finish(h, command, extra = {}) { h.child.frame({ type: 'prompt_result', id: command.id, status: 'completed', sessionSettled: true, agentInvoked: true, ...extra }); }
function message(h, id, type, text) { h.child.frame({ type, messageId: id, message: { role: 'assistant', content: [{ type: 'text', text }] } }); }

test('lazy isolated safe argv, negotiate v2, ACK and agent_end do not settle', async t => {
  const h = await setup(t); assert.equal(h.calls.length, 0);
  const { promise, command } = await h.prompt('hello'); assert.ok(command);
  const call = h.calls[0]; assert.equal(call.settings.shell, false); assert.equal(call.settings.cwd, h.root);
  assert.deepEqual(call.argv.slice(0, 10), ['--mode', 'rpc-ui', '--approval-mode', 'always-ask', '--no-extensions', '--no-title', '--no-pty', '--cwd', h.root, '--session-dir']);
  assert.ok(!call.argv.includes('--continue')); assert.equal((await stat(join(h.root, 'app-1'))).mode & 0o777, 0o700);
  let settled = false; promise.then(() => { settled = true; });
  h.child.ack(command); h.child.frame({ type: 'agent_end' }); finish(h, { id: 'unrelated' }); await tick(); assert.equal(settled, false);
  finish(h, command, { sessionSettled: false }); await tick(); assert.equal(settled, false);
  h.child.frame({ type: 'session_settled' }); await promise;
  assert.deepEqual(h.events[0], { type: 'provider.session', id: 'native-1' });
});
test('full snapshots and final dedupe; multiple messages make whole-turn text; stable tools', async t => {
  const h = await setup(t); const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  message(h, 'a', 'message_update', 'Hel'); message(h, 'a', 'message_update', 'Hello'); message(h, 'a', 'message_end', 'Hello');
  message(h, 'b', 'message_update', ' world'); message(h, 'b', 'message_end', ' world');
  h.child.frame({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'x' } });
  for (const text of ['a', 'abc']) h.child.frame({ type: 'tool_execution_update', toolCallId: 't1', partialResult: { content: [{ type: 'text', text }] } });
  h.child.frame({ type: 'tool_execution_end', toolCallId: 't1', result: 'ok', isError: false });
  finish(h, command); await promise;
  assert.equal(h.events.filter(e => e.type === 'text.delta').map(e => e.text).join(''), 'Hello world');
  assert.deepEqual(h.events.at(-1), { type: 'text.done', text: 'Hello world' });
  assert.deepEqual(h.events.filter(e => e.type === 'tool.update').map(e => e.text), ['a', 'bc']);
});
test('local command completion and next-turn runtime reuse', async t => {
  const h = await setup(t, { onCommand: (command, process) => { if (command.type === 'prompt') process.ack(command, { agentInvoked: false }); } });
  await h.adapter.send('locally handled input'); await h.adapter.send('second input'); assert.equal(h.calls.length, 1);
});
test('explicit approval maps only single-call labels, never remembered grants', async t => {
  const h = await setup(t, { approve: () => true }); const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  for (const [id, options] of [['a', ['Approve', 'Approve bash for this session', 'Deny']], ['b', ['Approve File', 'Always Approve File', 'Approve Once', 'Deny']]]) h.child.frame({ type: 'extension_ui_request', id, method: 'select', title: 'Allow tool: bash', options });
  h.child.frame({ type: 'extension_ui_request', id: 'c', method: 'confirm', title: 'Proceed?', message: 'Change file' });
  await Promise.all(['a', 'b', 'c'].map(id => h.waitForCommand(command => command.type === 'extension_ui_response' && command.id === id)));
  assert.deepEqual(h.child.commands.filter(c => c.type === 'extension_ui_response').map(c => c.value ?? c.confirmed), ['Approve', 'Approve Once', true]);
  assert.equal(h.approvals.length, 3); finish(h, command); await promise;
});
test('deny, unsupported dialogs, secret and open_url never guess or open anything', async t => {
  const h = await setup(t); const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  h.child.frame({ type: 'extension_ui_request', id: 'deny', method: 'select', title: 'Allow tool: bash', options: ['Approve', 'Deny'] });
  for (const method of ['select', 'input', 'editor', 'ask', 'open_url']) h.child.frame({ type: 'extension_ui_request', id: method, method, title: 'unknown', secret: true, options: ['Yes', 'No'], url: 'https://example.invalid' });
  await Promise.all(['deny', 'select', 'input', 'editor', 'ask', 'open_url'].map(id => h.waitForCommand(command => command.type === 'extension_ui_response' && command.id === id)));
  const responses = h.child.commands.filter(c => c.type === 'extension_ui_response');
  assert.equal(responses.find(c => c.id === 'deny').value, 'Deny'); assert.ok(responses.filter(c => c.id !== 'deny').every(c => c.cancelled === true));
  assert.equal(h.approvals.length, 1); finish(h, command); await promise;
});
test('cancelled approval cannot authorize late; abort closes only owned subprocess', async t => {
  let allow; const h = await setup(t, { approve: () => new Promise(resolve => { allow = resolve; }), fake: { stuck: true } });
  const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  h.child.frame({ type: 'extension_ui_request', id: 'a', method: 'confirm', title: 'danger' }); await tick();
  assert.equal(h.approvals[0].signal.aborted, false);
  h.child.frame({ type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'a' });
  assert.equal(h.approvals[0].signal.aborted, true);
  allow(true); await tick(); assert.equal(h.child.commands.filter(c => c.type === 'extension_ui_response').length, 0);
  await h.adapter.abort(); await assert.rejects(promise, /aborted/); assert.deepEqual(h.child.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(h.adapter.send('again'), /closed/);
});
test('resume only inside app directory, verify native identity and cwd when provided', async t => {
  const h = await setup(t, { session: { providerSessionId: 'native-1' }, onCommand: (c, p) => p.ack(c, { agentInvoked: false }) });
  await h.adapter.send('resume'); assert.ok(h.calls[0].argv.includes('--continue'));
  for (const options of [{ nativeId: 'other', session: { providerSessionId: 'native-1' } }, { state: { cwd: '/wrong' } }, { state: { sessionFile: '/outside.jsonl' } }]) {
    const bad = await setup(t, options); await assert.rejects(bad.adapter.send('resume'), /mismatch|escaped/); assert.ok(!bad.child.commands.some(c => c.type === 'prompt'));
  }
});
test('startup timeout, subprocess exit, protocol errors reject outstanding send', async t => {
  const noReady = await setup(t, { fake: { ready: false }, provider: { startupTimeout: 5 } }); await assert.rejects(noReady.adapter.send('hi'), /startup timeout/);
  for (const action of [child => child.finish(), child => child.stdout.write('invalid\n'), child => child.frame({ type: 'rpc_frame_error' })]) {
    const h = await setup(t); const { promise } = await h.prompt('hi'); action(h.child); await assert.rejects(promise);
  }
});
test('response command mismatch is fatal and stderr never enters assistant output', async t => {
  const h = await setup(t); const { promise, command } = await h.prompt('hi');
  h.child.stderr.write('Bearer secret-token '.repeat(1000));
  h.child.frame({ type: 'response', id: command.id, command: 'abort', success: true });
  await assert.rejects(promise, /correlation/); assert.ok(!JSON.stringify(h.events).includes('secret-token'));
});
test('stdin backpressure timeout is bounded and close escalates a stuck child', async t => {
  const h = await setup(t, { fake: { backpressure: true, stuck: true }, provider: { requestTimeout: 10 } });
  await assert.rejects(h.adapter.send('hi'), /timeout/); await h.adapter.close(); assert.deepEqual(h.child.kills, ['SIGTERM', 'SIGKILL']);
});
test('chunked assistant output above 1MiB remains lossless through adapter', async t => {
  const h = await setup(t); const { promise, command } = await h.prompt('large'); h.child.ack(command);
  const text = 'x'.repeat(1100000);
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', messageId: 'big', message: { role: 'assistant', content: [{ type: 'text', text }] } }));
  const count = Math.ceil(bytes.length / 262144);
  for (let index = 0; index < count; index++) h.child.frame({ type: 'rpc_chunk', chunkId: 'big', index, count, byteLength: bytes.length, data: bytes.subarray(index * 262144, (index + 1) * 262144).toString('base64') });
  finish(h, command); await promise; assert.equal(h.events.at(-1).text, text);
});
test('provider prompt errors reject and never mark successful completion', async t => {
  for (const status of ['aborted', 'error']) {
    const h = await setup(t); const { promise, command } = await h.prompt('hi'); h.child.ack(command);
    finish(h, command, { status }); await assert.rejects(promise, /aborted|failed/); assert.ok(!h.events.some(e => e.type === 'text.done'));
  }
});
test('approval pending at close cannot send a late permission grant', async t => {
  let allow; const h = await setup(t, { approve: () => new Promise(resolve => { allow = resolve; }) });
  const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  h.child.frame({ type: 'extension_ui_request', id: 'pending', method: 'confirm', title: 'danger' }); await tick();
  await h.adapter.close(); assert.equal(h.approvals[0].signal.aborted, true); allow(true); await tick(); await assert.rejects(promise, /closed/);
  assert.ok(!h.child.commands.some(c => c.type === 'extension_ui_response'));
});
test('dialog timeout aborts host signal and denies; turn completion aborts remaining dialogs', async t => {
  const h = await setup(t, { approve: () => new Promise(() => {}) });
  const { promise, command } = await h.prompt('hi'); h.child.ack(command);
  h.child.frame({ type: 'extension_ui_request', id: 'timeout', method: 'confirm', title: 'timeout', timeout: 5 });
  const denied = await h.waitForCommand(c => c.type === 'extension_ui_response' && c.id === 'timeout');
  assert.equal(denied.confirmed, false); assert.equal(h.approvals[0].signal.aborted, true);
  h.child.frame({ type: 'extension_ui_request', id: 'unfinished', method: 'confirm', title: 'unfinished' });
  assert.equal(h.approvals[1].signal.aborted, false);
  finish(h, command); await promise; assert.equal(h.approvals[1].signal.aborted, true);
  assert.ok(!h.child.commands.some(c => c.type === 'extension_ui_response' && c.id === 'unfinished'));
});
test('slash and shell shortcuts rejected before startup, never executed or reinterpreted', async t => {
  const h = await setup(t);
  for (const text of ['/help', '  /resume elsewhere', '\n/config tools.approvalMode=yolo', '!rm -rf something', '  !!pwd']) {
    await assert.rejects(h.adapter.send(text), /slash\/shell commands are not supported/);
  }
  assert.equal(h.calls.length, 0);
});
test('abort before first send never spawns; concurrent send is rejected', async t => {
  const controller = new AbortController(); const h = await setup(t, { signal: controller.signal }); controller.abort(); await assert.rejects(h.adapter.send('hi'), /closed/); assert.equal(h.calls.length, 0);
  const active = await setup(t); const { promise, command } = await active.prompt('one'); await assert.rejects(active.adapter.send('two'), /already active/); active.child.ack(command); finish(active, command); await promise;
});
