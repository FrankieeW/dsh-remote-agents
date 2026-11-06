import { randomUUID, createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';

const PROVIDERS = new Set(['claude', 'omp']);
const STATUSES = new Set(['idle', 'running', 'waiting', 'error', 'interrupted', 'closed']);
const TEXT_LIMIT = 65536;
const VALUE_LIMIT = 4096;
const MAX_TOOLS = 16;
const MAX_MESSAGES = 200;
const MAX_REQUESTS = 2048;
const MAX_SESSIONS = 32;
const MAX_FILE = 16 * 1024 * 1024;
const copy = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function fault(code, message) { return Object.assign(new Error(message), { name: 'ChatError', code }); }
function validText(value, max, empty = false) {
  return typeof value === 'string' && (empty || value.length > 0) && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}
function clip(value, max = TEXT_LIMIT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return { text: text.slice(0, max), truncated: text.length > max };
}
function boundedValue(value) {
  try {
    const json = JSON.stringify(value ?? null);
    if (json.length > VALUE_LIMIT) return { value: `${json.slice(0, VALUE_LIMIT)}…`, truncated: true };
    return { value: JSON.parse(json), truncated: false };
  } catch { return { value: '[Unsupported value]', truncated: true }; }
}
function safeError(error) {
  return String(error?.message || 'Provider operation failed').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2048);
}
const hash = text => createHash('sha256').update(text).digest('hex');

/** One live manager owns a statePath. Provider runtimes and approvals never enter disk state. */
export class ChatManager {
  constructor({ statePath, providers = {}, saveDebounceMs = 50, shutdownTimeoutMs = 1000 } = {}) {
    if (!validText(statePath, 4096)) throw fault('INVALID_INPUT', 'statePath is required');
    if (!providers || typeof providers !== 'object') throw fault('INVALID_INPUT', 'Invalid providers');
    if (!Number.isInteger(saveDebounceMs) || saveDebounceMs < 0 || saveDebounceMs > 5000) throw fault('INVALID_INPUT', 'Invalid saveDebounceMs');
    if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 10000) throw fault('INVALID_INPUT', 'Invalid shutdownTimeoutMs');
    this.statePath = resolve(statePath);
    this.providers = providers;
    this.saveDebounceMs = saveDebounceMs;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.state = { version: 1, sessions: [] };
    this.runtimes = new Map();
    this.queue = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.timer = null;
    this.disposed = false;
    this.disposePromise = null;
    this.storageError = null;
    this.ready = this._load();
    this.ready.catch(() => {});
  }

  async _load() {
    let stored;
    try {
      const info = await stat(this.statePath);
      if (info.size > MAX_FILE) throw fault('INVALID_STATE', 'Chat state exceeds size limit');
      stored = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw fault('INVALID_STATE', `Cannot read chat state: ${safeError(error)}`);
    }
    if (stored?.version !== 1 || !Array.isArray(stored.sessions) || stored.sessions.length > MAX_SESSIONS) throw fault('INVALID_STATE', 'Unsupported chat state');
    const ids = new Set();
    let changed = false;
    for (const session of stored.sessions) {
      if (!session || !validText(session.id, 128) || ids.has(session.id) || !PROVIDERS.has(session.provider) || !STATUSES.has(session.status) || !isAbsolute(session.cwd || '') || !Array.isArray(session.messages) || session.messages.length > MAX_MESSAGES || !Array.isArray(session.requests) || session.requests.length > MAX_REQUESTS) throw fault('INVALID_STATE', 'Invalid chat session record');
      ids.add(session.id);
      if (!validText(session.name, 100) || (session.providerSessionId !== undefined && !validText(session.providerSessionId, 512))) throw fault('INVALID_STATE', 'Invalid chat session metadata');
      const requests = new Set();
      for (const request of session.requests) {
        if (!request || !validText(request.requestId, 128) || requests.has(request.requestId) || !/^[a-f0-9]{64}$/.test(request.textHash || '') || !validText(request.assistantMessageId, 128)) throw fault('INVALID_STATE', 'Invalid request history');
        requests.add(request.requestId);
      }
      for (const message of session.messages) {
        if (!message || !validText(message.id, 128) || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.text.length > TEXT_LIMIT || !Array.isArray(message.tools) || message.tools.length > MAX_TOOLS) throw fault('INVALID_STATE', 'Invalid chat message record');
      }
      // Deliberately discard legacy/live approval data rather than restoring authority.
      if (Object.hasOwn(session, 'pendingApprovals')) { delete session.pendingApprovals; changed = true; }
      if (['running', 'waiting'].includes(session.status)) {
        session.status = 'interrupted';
        session.error = 'The previous process ended during a turn. Send a new message to resume explicitly.';
        session.updatedAt = now();
        changed = true;
      }
    }
    this.state = stored;
    if (changed) await this._persist();
  }

  _run(fn, { allowDisposed = false } = {}) {
    const operation = async () => {
      await this.ready;
      if (this.disposed && !allowDisposed) throw fault('DISPOSED', 'Chat manager is disposed');
      return fn();
    };
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
  _session(id) {
    const session = this.state.sessions.find(value => value.id === id);
    if (!session) throw fault('NOT_FOUND', 'Chat session not found');
    return session;
  }
  _snapshot(session) {
    const { requests, ...record } = session;
    const runtime = this.runtimes.get(session.id);
    return copy({ ...record, pendingApprovals: runtime ? [...runtime.pending.values()].map(value => value.record) : [], ...(this.storageError ? { persistenceError: this.storageError } : {}) });
  }
  _scheduleSave() {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._persist().catch(error => { this.storageError = safeError(error); });
    }, this.saveDebounceMs);
    this.timer.unref?.();
  }
  _persist() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const save = async () => {
      let data = JSON.stringify(this.state);
      while (Buffer.byteLength(data) > MAX_FILE) {
        const candidate = this.state.sessions.filter(session => session.messages.length > 2).sort((a, b) => (a.messages[0].createdAt || '').localeCompare(b.messages[0].createdAt || ''))[0];
        if (!candidate) throw fault('STATE_LIMIT', 'Chat storage is full');
        candidate.messages.splice(0, 2);
        candidate.historyTruncated = true;
        data = JSON.stringify(this.state);
      }
      await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.statePath}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(`${data}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, this.statePath);
        this.storageError = null;
      } catch (error) {
        await handle?.close().catch(() => {});
        await unlink(temporary).catch(() => {});
        this.storageError = safeError(error);
        throw error;
      }
    };
    const result = this.saveQueue.then(save, save);
    this.saveQueue = result.catch(() => {});
    return result;
  }

  list() {
    return this._run(() => this.state.sessions.map(session => ({ id: session.id, provider: session.provider, name: session.name, cwd: session.cwd, status: session.status, createdAt: session.createdAt, updatedAt: session.updatedAt, messageCount: session.messages.length, ...(session.error ? { error: session.error } : {}) })));
  }
  create({ provider, cwd, name, machineId = 'local', remote } = {}) {
    return this._run(async () => {
      if (machineId !== 'local' || remote) throw fault('UNSUPPORTED', 'Structured chat currently supports local sessions only');
      if (!PROVIDERS.has(provider) || typeof this.providers[provider] !== 'function') throw fault('UNSUPPORTED', 'Chat provider is unavailable');
      if (!validText(cwd, 4096) || !isAbsolute(cwd) || /[\r\n\t]/.test(cwd)) throw fault('INVALID_INPUT', 'cwd must be an absolute local directory');
      let directory;
      try { directory = await stat(cwd); } catch { throw fault('INVALID_INPUT', 'cwd must exist locally'); }
      if (!directory.isDirectory()) throw fault('INVALID_INPUT', 'cwd must be a local directory');
      if (name !== undefined && (!validText(name, 100) || /[\r\n\t]/.test(name))) throw fault('INVALID_INPUT', 'Invalid session name');
      if (this.state.sessions.length >= MAX_SESSIONS) throw fault('STATE_LIMIT', 'Maximum chat session count reached');
      const timestamp = now();
      const session = { id: randomUUID(), provider, name: name || `${provider} chat`, cwd, status: 'idle', messages: [], requests: [], createdAt: timestamp, updatedAt: timestamp };
      this.state.sessions.push(session);
      try { await this._persist(); } catch (error) { this.state.sessions = this.state.sessions.filter(value => value !== session); throw error; }
      return this._snapshot(session);
    });
  }
  get(id) { return this._run(() => this._snapshot(this._session(id))); }

  send({ id, text, requestId, provider, machineId, remote } = {}) {
    return this._run(async () => {
      const session = this._session(id);
      if ((provider !== undefined && provider !== session.provider) || (machineId !== undefined && machineId !== 'local') || remote) throw fault('UNSUPPORTED', 'Provider and local machine are fixed for a session');
      if (!validText(text, TEXT_LIMIT) || !text.trim()) throw fault('INVALID_INPUT', 'Message must contain 1–65536 characters');
      if (!validText(requestId, 128) || /[\r\n\t]/.test(requestId)) throw fault('INVALID_INPUT', 'A stable requestId is required');
      const existing = session.requests.find(request => request.requestId === requestId);
      if (existing) {
        if (existing.textHash !== hash(text)) throw fault('CONFLICT', 'requestId already identifies different message text');
        return { accepted: true, id, requestId, assistantMessageId: existing.assistantMessageId, duplicate: true };
      }
      if (session.status === 'closed') throw fault('CLOSED', 'Chat session is closed');
      if (['running', 'waiting'].includes(session.status)) throw fault('BUSY', 'A turn is already running');
      if (session.requests.length >= MAX_REQUESTS) throw fault('STATE_LIMIT', 'Session request history is full; create a new session');
      if (typeof this.providers[session.provider] !== 'function') throw fault('UNSUPPORTED', 'Chat provider is unavailable');
      const timestamp = now();
      const assistant = { id: randomUUID(), role: 'assistant', text: '', tools: [], createdAt: timestamp };
      const before = copy(session);
      session.messages.push({ id: randomUUID(), role: 'user', text, tools: [], createdAt: timestamp }, assistant);
      if (session.messages.length > MAX_MESSAGES) { session.messages.splice(0, session.messages.length - MAX_MESSAGES); session.historyTruncated = true; }
      session.requests.push({ requestId, textHash: hash(text), assistantMessageId: assistant.id });
      session.status = 'running';
      session.updatedAt = timestamp;
      delete session.error;
      try { await this._persist(); } catch (error) { Object.keys(session).forEach(key => delete session[key]); Object.assign(session, before); throw error; }
      let runtime = this.runtimes.get(id);
      if (!runtime) {
        runtime = { controller: new AbortController(), pending: new Map(), adapter: null, active: true, turn: null, task: null };
        this.runtimes.set(id, runtime);
      }
      runtime.turn = { assistant, requestId };
      runtime.task = this._drive(session, runtime, text).catch(error => { this.storageError = safeError(error); });
      return { accepted: true, id, requestId, assistantMessageId: assistant.id };
    });
  }

  _current(session, runtime) {
    return runtime.active && !this.disposed && this.runtimes.get(session.id) === runtime && !!runtime.turn;
  }
  _emit(session, runtime, event, payload) {
    if (!this._current(session, runtime)) return;
    const type = typeof event === 'string' ? event : event?.type;
    const value = typeof event === 'string' ? payload || {} : event || {};
    const message = runtime.turn.assistant;
    if (type === 'text.delta' || type === 'text.done') {
      if (typeof value.text !== 'string') return;
      const content = clip(type === 'text.delta' ? message.text + value.text : value.text);
      message.text = content.text;
      if (content.truncated) message.textTruncated = true;
    } else if (type === 'provider.session') {
      if (validText(value.id, 512) && !/[\r\n\t]/.test(value.id)) session.providerSessionId = value.id;
    } else if (['tool.start', 'tool.input', 'tool.update', 'tool.end'].includes(type)) {
      if (!validText(value.id, 128)) return;
      let tool = message.tools.find(item => item.id === value.id);
      if (type === 'tool.start') {
        if (tool) return;
        if (message.tools.length >= MAX_TOOLS) { message.toolsTruncated = true; this._scheduleSave(); return; }
        const input = boundedValue(value.input);
        tool = { id: value.id, name: clip(value.name || 'tool', 128).text, input: input.value, text: '', status: 'running', truncated: input.truncated };
        message.tools.push(tool);
      } else if (tool && type === 'tool.input') {
        const input = boundedValue(value.input);
        tool.input = input.value;
        tool.truncated ||= input.truncated;
      } else if (tool && type === 'tool.update') {
        const content = clip(tool.text + String(value.text ?? ''), VALUE_LIMIT);
        tool.text = content.text;
        tool.truncated ||= content.truncated;
      } else if (tool) {
        const result = boundedValue(value.result);
        tool.result = result.value;
        tool.isError = !!value.isError;
        tool.status = tool.isError ? 'error' : 'done';
        tool.truncated ||= result.truncated;
      }
    } else return;
    session.updatedAt = now();
    this._scheduleSave();
  }

  _requestApproval(session, runtime, input = {}) {
    if (!input || typeof input !== 'object' || !this._current(session, runtime) || runtime.pending.size >= 16) return Promise.resolve(false);
    const signal = input.signal;
    if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || signal.aborted)) return Promise.resolve(false);
    const details = boundedValue(input.details);
    const record = { id: randomUUID(), kind: clip(input.kind || 'permission', 100).text, title: clip(input.title || 'Approval required', 256).text, description: clip(input.description || '', 2048).text, details: details.value, truncated: details.truncated, createdAt: now() };
    session.status = 'waiting';
    session.updatedAt = now();
    const promise = new Promise(resolveApproval => {
      let settled = false;
      const onAbort = () => settle(false);
      const settle = allow => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        runtime.pending.delete(record.id);
        if (this._current(session, runtime)) {
          session.status = runtime.pending.size ? 'waiting' : 'running';
          session.updatedAt = now();
          this._scheduleSave();
        }
        resolveApproval(allow === true);
      };
      runtime.pending.set(record.id, { record, resolve: settle });
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        // Recheck after subscribing so cancellation cannot leave an orphan dialog.
        if (signal.aborted) settle(false);
      }
    });
    this._scheduleSave();
    return promise;
  }
  _deny(runtime) {
    for (const approval of runtime.pending.values()) approval.resolve(false);
    runtime.pending.clear();
  }
  async _drive(session, runtime, text) {
    const turn = runtime.turn;
    const current = () => this._current(session, runtime) && runtime.turn === turn;
    try {
      if (!runtime.adapter) {
        const adapter = await this.providers[session.provider]({ session: this._snapshot(session), emit: (event, payload) => this._emit(session, runtime, event, payload), requestApproval: input => this._requestApproval(session, runtime, input), signal: runtime.controller.signal });
        if (!adapter || typeof adapter.send !== 'function' || typeof adapter.abort !== 'function' || typeof adapter.close !== 'function') throw fault('INVALID_PROVIDER', 'Provider returned an invalid adapter');
        runtime.adapter = adapter;
        if (!current()) { await this._shutdown(runtime); return; }
      }
      await runtime.adapter.send(text);
      if (!current()) return;
      this._deny(runtime);
      session.status = 'idle';
      session.updatedAt = now();
      runtime.turn = null;
      await this._persist();
    } catch (error) {
      if (!current()) return;
      this._deny(runtime);
      session.status = 'error';
      session.error = safeError(error);
      session.updatedAt = now();
      runtime.active = false;
      runtime.turn = null;
      runtime.controller.abort();
      this.runtimes.delete(session.id);
      await this._persist().catch(saveError => { this.storageError = safeError(saveError); });
      await this._shutdown(runtime);
    }
  }
  approve({ id, approvalId, allow } = {}) {
    return this._run(async () => {
      const session = this._session(id);
      if (typeof allow !== 'boolean') throw fault('INVALID_INPUT', 'Approval requires an explicit boolean allow');
      const runtime = this.runtimes.get(id);
      const approval = runtime?.pending.get(approvalId);
      if (!approval || !this._current(session, runtime)) throw fault('APPROVAL_NOT_FOUND', 'Approval is missing, expired or belongs to another session');
      runtime.pending.delete(approvalId);
      session.status = runtime.pending.size ? 'waiting' : 'running';
      session.updatedAt = now();
      // Remove before resolving: retries can never authorize the same request twice.
      approval.resolve(allow);
      await this._persist();
      return this._snapshot(session);
    });
  }
  async _shutdown(runtime) {
    runtime.controller.abort();
    const work = Promise.allSettled(['abort', 'close'].map(method => Promise.resolve().then(() => runtime.adapter?.[method]())));
    let timer;
    try { await Promise.race([work, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, this.shutdownTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  _stop(id, status) {
    return this._run(async () => {
      const session = this._session(id);
      if (session.status === 'closed') return this._snapshot(session);
      const runtime = this.runtimes.get(id);
      if (runtime) {
        runtime.active = false;
        runtime.turn = null;
        this._deny(runtime);
        runtime.controller.abort();
        this.runtimes.delete(id);
      }
      session.status = status;
      session.updatedAt = now();
      delete session.error;
      await this._persist();
      if (runtime) this._shutdown(runtime).catch(() => {});
      return this._snapshot(session);
    });
  }
  interrupt(id) { return this._stop(id, 'interrupted'); }
  close(id) { return this._stop(id, 'closed'); }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this._run(async () => {
      this.disposed = true;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      const runtimes = [...this.runtimes.values()];
      for (const runtime of runtimes) {
        runtime.active = false;
        runtime.turn = null;
        this._deny(runtime);
        runtime.controller.abort();
      }
      this.runtimes.clear();
      for (const session of this.state.sessions) if (['running', 'waiting'].includes(session.status)) { session.status = 'interrupted'; session.updatedAt = now(); }
      await Promise.all(runtimes.map(runtime => this._shutdown(runtime)));
      await this._persist();
    }, { allowDisposed: true });
    return this.disposePromise;
  }
}
export default ChatManager;
