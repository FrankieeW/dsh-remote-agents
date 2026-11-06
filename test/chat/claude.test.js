import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeProvider } from '../reference/src/chat/claude.js';

const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: 'owned', ...extra });
const assistant = (id, text, extra = {}) => ({ type: 'assistant', uuid: `${id}-${text}`, message: { id, content: [{ type: 'text', text }] }, ...extra });
const stream = (event, extra = {}) => ({ type: 'stream_event', event, ...extra });
async function fixture(queryFn, options = {}) {
  const events = [];
  const adapter = await createClaudeProvider({ queryFn, executable: '/fake/claude' })({
    session: { cwd: '/project', ...options.session },
    emit: (type, payload) => events.push({ type, ...payload }),
    requestApproval: options.requestApproval,
    signal: options.signal,
  });
  return { adapter, events };
}

test('official query options, owned session resume, multi-message snapshots and tool dedup', async () => {
  const calls = [];
  let closures = 0;
  const { adapter, events } = await fixture((args) => {
    calls.push(args);
    const q = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'owned' };
      yield { type: 'system', subtype: 'init', session_id: 'child', parent_tool_use_id: 'sub' };
      yield assistant('child', 'hidden', { parent_tool_use_id: 'sub' });
      yield stream({ type: 'message_start', message: { id: 'a' } });
      yield stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } });
      yield assistant('a', 'Hello');
      yield assistant('a', 'Hello');
      yield stream({ type: 'message_start', message: { id: 'b' } });
      yield stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'Read', input: {} } });
      yield stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":' } });
      yield { type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'x' } }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'x'.repeat(40_000), is_error: true }] } };
      yield assistant('c', ' world');
      yield result({ result: ' world' });
      yield { type: 'system', subtype: 'status', session_id: 'not-owned' };
    })();
    q.close = () => { closures++; };
    return q;
  });
  await adapter.send('first');
  assert.equal(calls[0].prompt, 'first');
  assert.equal(calls[0].options.cwd, '/project');
  assert.equal(calls[0].options.permissionMode, 'default');
  assert.deepEqual(calls[0].options.settingSources, ['user', 'project', 'local']);
  assert.equal(calls[0].options.includePartialMessages, true);
  assert.equal(calls[0].options.pathToClaudeCodeExecutable, '/fake/claude');
  assert.equal(calls[0].options.resume, undefined);
  assert.equal(events.filter(e => e.type === 'tool.start').length, 1);
  assert.deepEqual(events.filter(e => e.type === 'tool.input'), [{ type: 'tool.input', id: 'tool', input: { file_path: 'x' } }]);
  assert.equal(events.find(e => e.type === 'tool.end').isError, true);
  assert.ok(events.find(e => e.type === 'tool.end').result.length < 33_000);
  assert.equal(events.filter(e => e.type === 'text.done').at(-1).text, 'Hello world');
  assert.deepEqual(events.filter(e => e.type === 'provider.session'), [{ type: 'provider.session', id: 'owned' }]);
  assert.ok(!JSON.stringify(events).includes('hidden'));
  await adapter.send('second');
  assert.equal(calls[1].options.resume, 'owned');
  assert.equal(closures, 2);
  adapter.close();
});

for (const partial of [false, true]) {
  test(`same-message per-block envelopes preserve text/thinking/tools (partial=${partial})`, async () => {
    const content = [
      { type: 'text', text: 'First' },
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: ' second' },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/file' } },
      { type: 'text', text: ' third' },
    ];
    const { adapter, events } = await fixture(() => (async function* () {
      if (partial) yield stream({ type: 'message_start', message: { id: 'shared' } });
      for (const [index, block] of content.entries()) {
        if (partial) {
          yield stream({ type: 'content_block_start', index, content_block: { ...block, text: '', input: {} } });
          if (block.type === 'text') yield stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
          yield stream({ type: 'content_block_stop', index });
        }
        const frame = { type: 'assistant', uuid: `frame-${index}`, message: { id: 'shared', content: [block], stop_reason: null } };
        yield frame;
        yield frame; // Transport replay of the same envelope is not new content.
      }
      yield result();
    })());
    await adapter.send('go');
    let rendered = '';
    for (const event of events) {
      if (event.type === 'text.delta') rendered += event.text;
      if (event.type === 'text.done') rendered = event.text;
    }
    assert.equal(rendered, 'First second third');
    assert.equal(events.filter(e => e.type === 'tool.start').length, 1);
    const input = events.find(e => e.type === (partial ? 'tool.input' : 'tool.start')).input;
    assert.deepEqual(input, { file_path: '/file' });
    assert.ok(!JSON.stringify(events).includes('private'));
    adapter.close();
  });
}

test('permissions are strict boolean, structured questions denied, stale callbacks denied', async () => {
  const requests = [];
  let callback;
  const { adapter } = await fixture(({ options }) => (async function* () {
    callback = options.canUseTool;
    assert.deepEqual(await callback('Write', { content: 'yes' }), { behavior: 'allow', updatedInput: { content: 'yes' } });
    assert.equal((await callback('Bash', { command: 'no' })).behavior, 'deny');
    assert.equal((await callback('AskUserQuestion', { questions: [] })).behavior, 'deny');
    assert.equal((await callback('Other', {}, { requiresUserInteraction: true })).behavior, 'deny');
    yield result();
  })(), { requestApproval: async (request) => { requests.push(request); return request.details.toolName === 'Write' ? true : { approved: true }; } });
  await adapter.send('go');
  assert.equal(requests.length, 2);
  assert.equal((await callback('Write', {})).behavior, 'deny');
  assert.equal(requests.length, 2);
  adapter.close();
});

for (const outcome of [result({ subtype: 'error_max_turns', errors: ['limit'], is_error: false }), result({ is_error: true, result: 'API failed' })]) {
  test(`reject result subtype/is_error: ${outcome.subtype}/${outcome.is_error}`, async () => {
    const { adapter } = await fixture(() => (async function* () { yield outcome; })());
    await assert.rejects(adapter.send('go'), /limit|API failed/);
    adapter.close();
  });
}

test('requires result and successful iterator closure', async () => {
  for (const afterResult of [false, true]) {
    const { adapter } = await fixture(() => (async function* () {
      yield assistant('a', 'text');
      if (afterResult) { yield result(); throw new Error('transport failed'); }
    })());
    await assert.rejects(adapter.send('go'), afterResult ? /transport failed/ : /without a result/);
    adapter.close();
  }
});

test('abort unblocks iterator and denies pending permission; next turn can resume', async () => {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let decision;
  let count = 0;
  let closes = 0;
  const { adapter } = await fixture(({ options }) => {
    if (++count > 1) return (async function* () { yield result(); })();
    const q = (async function* () {
      const permission = options.canUseTool('Bash', { command: 'x' });
      entered();
      decision = await permission;
      yield result();
    })();
    q.close = () => { closes++; };
    return q;
  }, { requestApproval: () => new Promise(() => {}) });
  const sending = adapter.send('go');
  await ready;
  await assert.rejects(adapter.send('overlap'), /active turn/);
  adapter.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  await Promise.resolve();
  assert.equal(decision.behavior, 'deny');
  assert.ok(closes >= 1);
  await adapter.send('again');
  adapter.close();
  await assert.rejects(adapter.send('closed'), { name: 'AbortError' });
});

test('external abort closes an unresponsive query without waiting for return', async () => {
  const controller = new AbortController();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let closed = false;
  const { adapter } = await fixture(() => ({
    [Symbol.asyncIterator]() { return this; },
    next() { entered(); return new Promise(() => {}); },
    return() { return new Promise(() => {}); },
    close() { closed = true; },
  }), { signal: controller.signal });
  const sending = adapter.send('go');
  await ready;
  controller.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  assert.equal(closed, true);
  adapter.close();
});

test('SDK permission cancellation expires the manager approval without aborting the turn', async () => {
  const permissionController = new AbortController();
  let pending = false;
  let forwardedSignal;
  const { adapter } = await fixture(({ options }) => (async function* () {
    const decision = await options.canUseTool('Bash', { command: 'x' }, { signal: permissionController.signal });
    assert.equal(decision.behavior, 'deny');
    assert.equal(pending, false);
    assert.equal(forwardedSignal.aborted, true);
    assert.equal(options.abortController.signal.aborted, false);
    yield result();
  })(), {
    requestApproval: ({ signal }) => {
      forwardedSignal = signal;
      pending = true;
      return new Promise(resolve => {
        signal.addEventListener('abort', () => { pending = false; resolve(false); }, { once: true });
        permissionController.abort();
      });
    },
  });
  await adapter.send('go');
  adapter.close();
});

test('resume never switches to unrelated main session ID', async () => {
  const { adapter } = await fixture(() => (async function* () { yield result({ session_id: 'foreign' }); })(), { session: { providerSessionId: 'owned' } });
  await assert.rejects(adapter.send('go'), /different session ID/);
  adapter.close();
});

test('Claude CLI inheritance, explicit model/effort and YOLO map to SDK options', async () => {
  for (const permissions of ['cli', 'bypassPermissions', 'plan']) {
    let options;
    const { adapter } = await fixture(args => { options=args.options;return (async function*(){yield result();})(); }, {session:{settings:{model:'opus',effort:'high',permissions}}});
    await adapter.send('hello');assert.equal(options.model,'opus');assert.equal(options.effort,'high');
    assert.equal(options.permissionMode,permissions==='cli'?undefined:permissions);
    assert.equal(options.allowDangerouslySkipPermissions,permissions==='bypassPermissions'?true:undefined);
    assert.deepEqual(options.settingSources,['user','project','local']);adapter.close();
  }
});
