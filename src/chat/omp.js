import { legacySettings } from './settings.js';
import { spawn } from 'node:child_process';
import { mkdir, lstat, chmod, realpath } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { OmpFrameDecoder, MAX_FRAME_BYTES } from './omp-frames.js';

// Protocol pinned to https://github.com/can1357/oh-my-pi/tree/v18.17.0 .
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; };
const textOf = message => (Array.isArray(message?.content) ? message.content : []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
const error = message => new Error(`OMP: ${message}`);
const within = (root, path) => { const rel = relative(root, path); return rel && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };

/** Lazy per-app-session subprocess; no shell, terminal, auth inspection or global settings writes. */
export function createOmpProvider({ spawnFn = spawn, executable = 'omp', execution, sessionRoot = join(homedir(), '.dsh', 'remote-agents', 'omp'), startupTimeout = 15000, requestTimeout = 30000, closeGrace = 250 } = {}) {
  return async ({ session, emit = () => {}, requestApproval = async () => false, signal } = {}) => {
    if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session.id) || !isAbsolute(session.cwd || '')) throw error('invalid session identity/cwd');
    const settings = session.settings || legacySettings('omp');
    if (execution?.remote) spawnFn = execution.spawn;
    let directory = join(resolve(sessionRoot), session.id);
    let child, starting, closed = false, failure, exited = false, closing;
    let turn, sequence = 0, writeQueue = Promise.resolve(), diagnosticBytes = 0;
    const ready = deferred(), exit = deferred(), pending = new Map(), approvals = new Map();
    const decoder = new OmpFrameDecoder();
    const onAbort = () => { void adapter.abort(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    function clearApprovals() {
      const entries = [...approvals.values()];
      approvals.clear();
      for (const entry of entries) { clearTimeout(entry.timer); entry.controller.abort(); }
    }
    function rejectAll(reason) {
      ready.reject(reason);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
      pending.clear();
      if (turn) { turn.reject(reason); turn = null; }
      clearApprovals();
    }
    function fail(reason) {
      if (failure || closed) return;
      failure = reason instanceof Error ? reason : error('protocol failed');
      rejectAll(failure);
      void adapter.close();
    }
    function write(frame) {
      const operation = async () => {
        if (!child || exited || closed || failure) throw failure || error('process unavailable');
        const line = `${JSON.stringify(frame)}\n`;
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw error('outbound frame exceeds limit');
        await new Promise((resolveWrite, rejectWrite) => {
          let done = false, timer;
          const finish = reason => { if (done) return; done = true; clearTimeout(timer); child.stdin.off('error', onError); child.stdin.off('drain', onDrain); child.off('exit', onExit); reason ? rejectWrite(reason) : resolveWrite(); };
          const onError = () => finish(error('stdin failed'));
          const onExit = () => finish(error('process exited during write'));
          const onDrain = () => finish();
          child.stdin.on('error', onError); child.once('exit', onExit);
          timer = setTimeout(() => finish(error('stdin write timeout')), requestTimeout);
          try { if (child.stdin.write(line)) finish(); else child.stdin.once('drain', onDrain); } catch { onError(); }
        });
      };
      const result = writeQueue.then(operation);
      writeQueue = result.catch(() => {});
      return result;
    }
    function command(type, values = {}, id = `omp-${++sequence}`) {
      const entry = deferred();
      entry.type = type;
      entry.timer = setTimeout(() => { pending.delete(id); entry.reject(error(`${type} response timeout`)); fail(error(`${type} response timeout`)); }, requestTimeout);
      pending.set(id, entry);
      write({ id, type, ...values }).catch(reason => { clearTimeout(entry.timer); pending.delete(id); entry.reject(reason); fail(reason); });
      return entry.promise;
    }
    function complete() {
      if (!turn) return;
      const current = turn;
      emit('text.done', { text: [...current.messages.values()].join('') });
      turn = null;
      clearApprovals();
      current.resolve();
    }
    function message(frame) {
      if (!turn || frame.message?.role !== 'assistant') return;
      if (typeof frame.messageId !== 'string' || !frame.messageId) throw error('missing messageId');
      const old = [...turn.messages.values()].join('');
      const previous = turn.messages.get(frame.messageId) || '';
      const next = Array.isArray(frame.message.content) ? textOf(frame.message) : frame.assistantMessageEvent?.type === 'text_delta' ? previous + frame.assistantMessageEvent.delta : previous;
      turn.messages.set(frame.messageId, next);
      const total = [...turn.messages.values()].join('');
      if (Buffer.byteLength(total) > 64 * 1024 * 1024 || turn.messages.size > 4096) throw error('turn text exceeds limit');
      if (total.startsWith(old)) { if (total.length > old.length) emit('text.delta', { text: total.slice(old.length) }); }
      else emit('text.done', { text: total });
    }
    async function ui(frame) {
      if (frame.method === 'cancel') { const entry = approvals.get(frame.targetId); approvals.delete(frame.targetId); clearTimeout(entry?.timer); entry?.controller.abort(); return; }
      if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(frame.method)) return;
      if (typeof frame.id !== 'string' || !frame.id || approvals.has(frame.id)) throw error('invalid or repeated UI request');
      // Official approval.ts: no grants => Approve; remembered grants => Approve Once.
      const options = frame.options;
      const once = Array.isArray(options) && options.includes('Approve Once') ? 'Approve Once' : 'Approve';
      const select = frame.method === 'select' && typeof frame.title === 'string' && frame.title.startsWith('Allow tool: ') &&
        Array.isArray(options) && options.length >= 2 && options.every(value => typeof value === 'string') &&
        options.filter(value => value === once).length === 1 && options.filter(value => value === 'Deny').length === 1 &&
        new Set(options).size === options.length && options.at(-1) === 'Deny' &&
        options.every(value => value === once || value === 'Deny' || /^Approve [^\r\n]+ for this session$/.test(value) ||
          (once === 'Approve Once' && (['Approve', 'Approve File', 'Always Approve', 'Always Approve File'].includes(value) || /^(?:Always )?Approve Directory: [^\r\n]+$/.test(value))));
      if (!turn || (frame.method !== 'confirm' && !select)) {
        await write({ type: 'extension_ui_response', id: frame.id, cancelled: true });
        if (turn) { const id = `unsupported-${frame.id}`; emit('tool.start', { id, name: 'Unsupported OMP dialog', input: { method: frame.method } }); emit('tool.end', { id, isError: true, result: 'Dialog cancelled: this chat supports boolean approvals only.' }); }
        return;
      }
      const entry = { controller: new AbortController() };
      approvals.set(frame.id, entry);
      const respond = async allow => {
        if (approvals.get(frame.id) !== entry || closed || failure) return;
        approvals.delete(frame.id); clearTimeout(entry.timer); entry.controller.abort();
        await write({ type: 'extension_ui_response', id: frame.id, ...(select ? { value: allow === true ? once : 'Deny' } : { confirmed: allow === true }) });
      };
      if (Number.isFinite(frame.timeout) && frame.timeout > 0) entry.timer = setTimeout(() => { void respond(false).catch(fail); }, Math.min(frame.timeout, 2147483647));
      try { await respond(await requestApproval({ kind: 'permission', title: frame.title, description: frame.message || frame.title, details: select ? { options, grant: 'this call only' } : undefined, signal: entry.controller.signal })); }
      catch { await respond(false); }
    }
    function receive(frame) {
      if (closed || failure) return;
      if (frame.type === 'ready') { ready.resolve(frame); return; }
      if (frame.type === 'rpc_frame_error') throw error('provider transport overflow');
      if (frame.type === 'response') {
        if (turn?.id === frame.id && frame.command === 'prompt' && frame.success === false) throw error('prompt rejected');
        const entry = pending.get(frame.id);
        if (!entry) return;
        if (entry.type !== frame.command || typeof frame.success !== 'boolean') throw error('response correlation mismatch');
        pending.delete(frame.id); clearTimeout(entry.timer);
        if (!frame.success) entry.reject(error(`${frame.command} rejected`)); else entry.resolve(frame.data);
        if (turn?.id === frame.id && frame.data?.agentInvoked === false) complete();
        return;
      }
      if (frame.type === 'extension_ui_request') { void ui(frame).catch(fail); return; }
      if (!turn) return;
      if (['message_start', 'message_update', 'message_end'].includes(frame.type)) message(frame);
      else if (frame.type === 'tool_execution_start') emit('tool.start', { id: frame.toolCallId, name: frame.toolName, input: frame.args });
      else if (frame.type === 'tool_execution_update') {
        const previous = turn.tools.get(frame.toolCallId) || '';
        const next = textOf(frame.partialResult);
        emit('tool.update', { id: frame.toolCallId, text: next.startsWith(previous) ? next.slice(previous.length) : next });
        turn.tools.set(frame.toolCallId, next);
      } else if (frame.type === 'tool_execution_end') emit('tool.end', { id: frame.toolCallId, result: frame.result, isError: frame.isError });
      else if (frame.type === 'prompt_result' && frame.id === turn.id) {
        if (frame.status !== 'completed') throw error(frame.status === 'aborted' ? 'turn aborted' : 'turn failed');
        turn.result = true;
        if (frame.sessionSettled === true || turn.settled) complete();
      } else if (frame.type === 'session_settled') { turn.settled = true; if (turn.result) complete(); }
      else if (frame.type === 'agent_start') turn.settled = false;
    }
    async function start() {
      if (closed || signal?.aborted) throw error('session closed');
      let cwd;
      if (execution?.remote) {
        directory = await execution.sessionDirectory(session.id);
        cwd = await execution.canonicalize(session.cwd);
      } else {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw error('unsafe session directory');
        await chmod(directory, 0o700);
        directory = await realpath(directory);
        cwd = await realpath(session.cwd);
      }
      if (closed || signal?.aborted) throw error('session closed');
      const argv = ['--mode', 'rpc-ui', '--no-title', '--no-pty', '--cwd', cwd, '--session-dir', directory, ...(settings.permissions !== 'cli' ? ['--approval-mode', settings.permissions] : []), ...(settings.model ? ['--model', settings.model] : []), ...(settings.effort ? ['--thinking', settings.effort] : [])];
      if (session.providerSessionId) argv.push('--continue');
      child = spawnFn(executable, argv, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_NO_TITLE: '1', PI_NO_PTY: '1' } });
      child.on('error', () => fail(error('could not start subprocess')));
      child.stdin.on('error', () => fail(error('stdin failed')));
      child.stdout.on('data', bytes => { try { for (const frame of decoder.push(bytes)) receive(frame); } catch (reason) { fail(reason); } });
      child.stdout.on('end', () => { try { decoder.end(); } catch (reason) { fail(reason); } });
      // stderr is not protocol and can contain credentials. Retain only a bounded byte count, never raw content.
      child.stderr.on('data', bytes => { diagnosticBytes = Math.min(8192, diagnosticBytes + Buffer.byteLength(bytes)); });
      child.on('exit', (code, sig) => { exited = true; exit.resolve(); if (!closed) fail(error(`subprocess exited (${code ?? sig ?? 'unknown'}; diagnostic bytes ${diagnosticBytes})`)); });
      let timer;
      try {
        const frame = await Promise.race([ready.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error('startup timeout')), startupTimeout); })]);
        if (frame.protocolVersion !== 1 || !frame.supportedProtocolVersions?.includes(2)) throw error('requires protocol v2');
        const negotiated = await command('negotiate_protocol', { protocolVersion: 2 });
        if (negotiated?.protocolVersion !== 2) throw error('protocol v2 negotiation failed');
        const state = await command('get_state');
        if (typeof state?.sessionId !== 'string' || !state.sessionId || state.sessionId.length > 512) throw error('missing native session id');
        if (session.providerSessionId && state.sessionId !== session.providerSessionId) throw error('resumed native session mismatch');
        if (state.cwd !== undefined && resolve(state.cwd) !== cwd) throw error('native cwd mismatch');
        if (state.sessionFile && !within(directory, resolve(state.sessionFile))) throw error('native session escaped private directory');
        emit('provider.session', { id: state.sessionId });
        emit('provider.settings', { model: state.model?.id ? `${state.model.provider}/${state.model.id}` : undefined, effort: state.thinkingLevel, permissions: state.approvalMode });
      } catch (reason) { fail(reason); throw reason; } finally { clearTimeout(timer); }
    }
    const adapter = {
      async send(text) {
        if (closed || failure || signal?.aborted) throw failure || error('session closed');
        if (turn) throw error('turn already active');
        if (typeof text !== 'string' || !text.trim()) throw error('empty prompt');
        if (/^[\/!]/.test(text.trimStart())) throw error('slash/shell commands are not supported in chat; use a plain text prompt to preserve session identity and approval policy');
        // Reserve before async startup so concurrent callers cannot submit two turns.
        const current = { ...deferred(), id: randomUUID(), messages: new Map(), tools: new Map(), result: false, settled: false };
        turn = current;
        try { starting ||= start(); await starting; if (turn !== current) throw failure || error('turn cancelled'); await command('prompt', { message: text }, current.id); await current.promise; }
        catch (reason) { if (turn === current) { turn = null; current.reject(reason); } throw reason; }
      },
      async abort() {
        if (closed) return;
        if (child && !exited && !failure) {
          // Send only to our owned process. Closing below bounds a stuck abort/approval.
          let timer;
          try { await Promise.race([write({ id: `abort-${++sequence}`, type: 'abort' }), new Promise(resolveWait => { timer = setTimeout(resolveWait, closeGrace); })]); } catch {}
          finally { clearTimeout(timer); }
        }
        rejectAll(error('turn aborted'));
        await adapter.close();
      },
      close() {
        if (closing) return closing;
        closed = true; signal?.removeEventListener('abort', onAbort); rejectAll(error('session closed'));
        closing = (async () => {
          if (!child || exited) return;
          child.stdin.end();
          const wait = async () => { let timer; try { await Promise.race([exit.promise, new Promise(resolveWait => { timer = setTimeout(resolveWait, closeGrace); })]); } finally { clearTimeout(timer); } };
          await wait();
          if (!exited) { child.kill('SIGTERM'); await wait(); }
          if (!exited) child.kill('SIGKILL');
        })();
        return closing;
      },
    };
    return adapter;
  };
}
export default createOmpProvider;
