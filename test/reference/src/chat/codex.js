import { legacySettings, codexPermissionOptions } from './settings.js';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';

// Codex 0.167.x app-server v2, verified with `codex app-server generate-ts`.
// https://developers.openai.com/codex/app-server/
const LIMIT = 8 * 1024 * 1024;
const error = message => new Error(`Codex: ${message}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};
const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);

/** Owned stdio process, started only by send; native CLI config/auth stay untouched. */
export function createCodexProvider({ executable = 'codex', execution, spawnFn = spawn, requestTimeout = 30000, closeGrace = 250 } = {}) {
  return async ({ session, emit = () => {}, requestApproval = async () => false, signal } = {}) => {
    if (!session || !validId(session.id) || !isAbsolute(session.cwd || '') ||
        (session.providerSessionId && !validId(session.providerSessionId))) throw error('invalid session identity/cwd');
    const settings = session.settings || legacySettings('codex');
    if (execution?.remote) spawnFn = execution.spawn;
    let child, starting, closing, failure, closed = false, exited = false, threadId, turn;
    let sequence = 0, buffer = Buffer.alloc(0), diagnosticBytes = 0;
    const pending = new Map(), approvals = new Map(), exit = deferred();
    const onAbort = () => { void adapter.abort(); };
    function expireApprovals() {
      for (const controller of approvals.values()) controller.abort();
      approvals.clear();
    }
    function rejectAll(reason) {
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
      pending.clear();
      if (turn) { turn.started.reject(reason); turn.reject(reason); turn = null; }
      expireApprovals();
    }
    function fail(reason) {
      if (closed || failure) return;
      failure = reason instanceof Error ? reason : error('protocol failure');
      rejectAll(failure);
      void adapter.close();
    }
    function write(frame) {
      if (closed || exited || failure || !child) throw failure || error('process unavailable');
      const line = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(line) > LIMIT || child.stdin.writableLength > LIMIT) throw error('outbound frame limit exceeded');
      child.stdin.write(line, cause => { if (cause) fail(error('stdin failed')); });
    }
    function request(method, params) {
      const id = `dsh-${++sequence}`, entry = deferred();
      entry.timer = setTimeout(() => fail(error(`${method} response timeout`)), requestTimeout);
      pending.set(id, entry);
      try { write({ id, method, params }); } catch (reason) { fail(reason); }
      return entry.promise;
    }
    function text(itemId, value, delta = false) {
      if (!validId(itemId) || typeof value !== 'string') throw error('invalid text item');
      const old = [...turn.messages.values()].join('\n\n');
      turn.messages.set(itemId, delta ? (turn.messages.get(itemId) || '') + value : value);
      const next = [...turn.messages.values()].join('\n\n');
      if (next.length > LIMIT || turn.messages.size > 4096) throw error('turn text limit exceeded');
      if (next.startsWith(old)) { if (next.length > old.length) emit('text.delta', { text: next.slice(old.length) }); }
      else emit('text.done', { text: next });
    }
    function tool(id, name, input, result, done = false, isError = false) {
      if (!validId(id)) throw error('invalid tool item');
      if (!turn.tools.has(id)) {
        if (turn.tools.size >= 4096) throw error('turn tool limit exceeded');
        turn.tools.add(id); emit('tool.start', { id, name, input });
      } else emit('tool.input', { id, input });
      if (done) emit('tool.end', { id, result, isError });
    }
    function item(value, done) {
      if (!value) return;
      const { id, type } = value;
      if (type === 'agentMessage') { text(id, value.text || ''); return; }
      if (type === 'commandExecution') tool(id, 'commandExecution', { command: value.command, cwd: value.cwd },
        { content: [{ type: 'text', text: value.aggregatedOutput || '' }], details: { exitCode: value.exitCode } }, done,
        ['failed', 'declined'].includes(value.status) || (Number.isInteger(value.exitCode) && value.exitCode !== 0));
      else if (type === 'fileChange') tool(id, 'fileChange', { changes: value.changes }, value.status, done, ['failed', 'declined'].includes(value.status));
      else if (type === 'mcpToolCall') tool(id, `mcp__${value.server}__${value.tool}`, value.arguments, value.error || value.result, done, value.status === 'failed' || !!value.error);
      else if (type === 'webSearch') tool(id, 'web_search', { query: value.query, action: value.action }, value.action, done);
      else if (type === 'collabAgentToolCall') tool(id, 'agent', { description: value.tool, prompt: value.prompt, agents: value.receiverThreadIds }, value.agentsStates, done, value.status === 'failed');
      else if (type === 'plan') tool(id, 'Plan', {}, value.text, done);
    }
    function notification(method, params) {
      if (!turn || params?.threadId !== threadId) return;
      if (method === 'serverRequest/resolved') {
        approvals.get(params.requestId)?.abort(); approvals.delete(params.requestId); return;
      }
      if (!turn.id) {
        turn.queuedBytes += Buffer.byteLength(JSON.stringify({ method, params }));
        if (turn.queuedBytes > LIMIT) throw error('early notification limit exceeded');
        turn.queued.push({ method, params }); return;
      }
      if ((params.turnId ?? params.turn?.id) !== turn.id) return;
      if (method === 'item/agentMessage/delta') text(params.itemId, params.delta, true);
      else if (method === 'item/started' || method === 'item/completed') item(params.item, method === 'item/completed');
      else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') emit('tool.update', { id: params.itemId, text: params.delta });
      else if (method === 'turn/plan/updated') {
        tool(`plan-${turn.id}`, 'update_plan', { todos: (params.plan || []).map(step => ({ content: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) }, params.explanation, true);
      } else if (method === 'turn/completed') {
        const current = turn;
        emit('text.done', { text: [...current.messages.values()].join('\n\n') });
        turn = null; expireApprovals();
        if (params.turn.status === 'completed') current.resolve();
        else current.reject(error(params.turn.error?.message || `turn ${params.turn.status || 'failed'}`));
      }
    }
    async function serverRequest(frame) {
      const { id, method, params = {} } = frame;
      if (approvals.has(id)) throw error('duplicate approval request');
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method);
      if (!supported) {
        // Never answer rich questions, grant additional permissions or execute dynamic tools implicitly.
        if (method === 'item/permissions/requestApproval') write({ id, result: { permissions: {}, scope: 'turn' } });
        else write({ id, error: { code: -32601, message: 'This client supports command and file approvals only.' } });
        if (turn) throw error(`Unsupported interaction: ${method}. Continue this thread in the Codex CLI.`);
        return;
      }
      // A request can arrive before the turn/start acknowledgement. Wait for its correlated ID.
      const current = turn;
      if (current && !current.id) await current.started.promise;
      if (!current || turn !== current || params.threadId !== threadId || params.turnId !== current.id) {
        write({ id, result: { decision: 'decline' } }); return;
      }
      const controller = new AbortController(); approvals.set(id, controller);
      let allow = false;
      try {
        allow = await requestApproval({ kind: 'permission',
          title: method.includes('commandExecution') ? 'Allow command?' : 'Allow file changes?',
          description: params.reason || params.command || 'Codex requests permission to change files.',
          details: { toolName: method.includes('commandExecution') ? 'commandExecution' : 'fileChange',
            input: { command: params.command, cwd: params.cwd, itemId: params.itemId }, grant: 'this call only' }, signal: controller.signal });
      } catch { /* A failed dialog denies this call. */ }
      if (approvals.get(id) !== controller || closed) return;
      approvals.delete(id); controller.abort();
      write({ id, result: { decision: allow === true ? 'accept' : 'decline' } });
    }
    function receive(frame) {
      if (closed) return;
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw error('invalid JSON-RPC frame');
      if (typeof frame.method === 'string') {
        if (Object.hasOwn(frame, 'id')) void serverRequest(frame).catch(fail);
        else notification(frame.method, frame.params);
      } else if (Object.hasOwn(frame, 'id')) {
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id); clearTimeout(entry.timer);
        if (frame.error) entry.reject(error(frame.error.message || 'request failed'));
        else if (Object.hasOwn(frame, 'result')) entry.resolve(frame.result);
        else entry.reject(error('invalid RPC response'));
      } else throw error('missing RPC method/id');
    }
    function data(bytes) {
      try {
        let start = 0;
        while (start < bytes.length) {
          const newline = bytes.indexOf(10, start), end = newline < 0 ? bytes.length : newline + 1;
          const part = bytes.subarray(start, end);
          if (buffer.length + part.length > LIMIT) throw error('frame limit exceeded');
          buffer = Buffer.concat([buffer, part]); start = end;
          if (newline < 0) break;
          const line = buffer.subarray(0, -1); buffer = Buffer.alloc(0);
          if (line.length) receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
        }
      } catch { fail(error('invalid or oversized app-server frame')); }
    }
    async function start() {
      if (closed || signal?.aborted) throw error('session closed');
      const cwd = (execution?.remote ? await execution.canonicalize(session.cwd) : await realpath(session.cwd));
      if (closed || signal?.aborted) throw error('session closed');
      child = spawnFn(executable, ['app-server', '--listen', 'stdio://'], {
        cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
      });
      child.on('error', () => fail(error('could not start app-server')));
      child.stdin.on('error', () => fail(error('stdin failed')));
      child.stdout.on('data', data);
      child.stdout.on('end', () => { if (!closed) fail(error(buffer.length ? 'incomplete frame at EOF' : 'app-server output ended')); });
      // Raw stderr may contain credentials; never retain or surface it.
      child.stderr.on('data', bytes => { diagnosticBytes = Math.min(8192, diagnosticBytes + bytes.length); });
      child.on('exit', (code, sig) => {
        exited = true; exit.resolve();
        if (!closed) fail(error(`app-server exited (${code ?? sig ?? 'unknown'}; diagnostic bytes ${diagnosticBytes})`));
      });
      await request('initialize', { clientInfo: { name: 'dsh_remote_agents', title: 'DSH Remote Agents', version: '0.4.1' }, capabilities: null });
      write({ method: 'initialized', params: {} });
      // Explicit policy overrides prevent a global full-access/never profile silently bypassing this UI.
      let inherited = {};
      if (session.settings) inherited = (await request('config/read', { cwd, includeLayers: false })).config || {};
      const permissions = settings.permissions === 'cli' ? {
        ...(inherited.approval_policy ? { approvalPolicy: inherited.approval_policy } : {}),
        ...(inherited.sandbox_mode ? { sandbox: inherited.sandbox_mode } : {}),
        ...(inherited.approvals_reviewer ? { approvalsReviewer: inherited.approvals_reviewer } : {}),
      } : codexPermissionOptions(settings.permissions);
      const options = { cwd, ...permissions,
        ...((settings.model || inherited.model) ? { model: settings.model || inherited.model } : {}),
        ...((settings.effort || inherited.model_reasoning_effort) ? { config: { model_reasoning_effort: settings.effort || inherited.model_reasoning_effort } } : {}),
      };
      const result = await request(session.providerSessionId ? 'thread/resume' : 'thread/start', {
        ...options, ...(session.providerSessionId ? { threadId: session.providerSessionId } : {}),
      });
      if (!validId(result?.thread?.id) || (session.providerSessionId && result.thread.id !== session.providerSessionId) ||
          !isAbsolute(result.thread.cwd || '') || (execution?.remote ? await execution.canonicalize(result.thread.cwd) : await realpath(result.thread.cwd)) !== cwd) throw error('thread identity/cwd mismatch');
      threadId = result.thread.id;
      emit('provider.session', { id: threadId });
      emit('provider.settings', { model: result.model, effort: result.reasoningEffort, permissions: result.approvalPolicy, sandbox: result.sandbox?.type });
    }
    const adapter = {
      async send(prompt) {
        if (closed || failure || signal?.aborted) throw failure || error('session closed');
        if (turn) throw error('turn already active');
        if (typeof prompt !== 'string' || !prompt.trim()) throw error('empty prompt');
        const current = { ...deferred(), started: deferred(), messages: new Map(), tools: new Set(), queued: [], queuedBytes: 0 };
        turn = current;
        try {
          starting ||= start(); await starting;
          if (turn !== current) throw failure || error('turn cancelled');
          const result = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }], ...(settings.effort ? { effort: settings.effort } : {}) });
          if (turn !== current || !validId(result?.turn?.id)) throw failure || error('invalid turn acknowledgement');
          current.id = result.turn.id; current.started.resolve();
          for (const frame of current.queued) notification(frame.method, frame.params);
          current.queued = [];
          await current.promise;
        } catch (reason) { current.started.reject(reason); fail(reason); throw reason; }
      },
      async abort() {
        if (closed) return;
        if (threadId && turn?.id && child && !exited && !failure) {
          try { write({ id: `interrupt-${++sequence}`, method: 'turn/interrupt', params: { threadId, turnId: turn.id } }); } catch { /* close below */ }
        }
        await adapter.close();
      },
      close() {
        if (closing) return closing;
        closed = true; signal?.removeEventListener('abort', onAbort);
        turn?.started.reject(error('session closed')); rejectAll(error('session closed'));
        closing = (async () => {
          if (!child || exited) return;
          child.stdin.end();
          const wait = async () => {
            let timer;
            try { await Promise.race([exit.promise, new Promise(done => { timer = setTimeout(done, closeGrace); })]); }
            finally { clearTimeout(timer); }
          };
          await wait();
          if (!exited) { child.kill('SIGTERM'); await wait(); }
          if (!exited) child.kill('SIGKILL');
        })();
        return closing;
      },
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    return adapter;
  };
}
export default createCodexProvider;
