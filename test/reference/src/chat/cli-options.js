import { EFFORTS, PERMISSIONS } from './settings.js';
const MAX = 8 * 1024 * 1024;
const str = value => typeof value === 'string' ? value.slice(0, 256) : null;

/** A metadata-only protocol client. Never sends a user message or model turn. */
export async function withCliReader(host, executable, cwd, kind, body) {
  const args = kind === 'codex' ? ['app-server', '--listen', 'stdio://'] :
    ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'user,project,local'];
  const child = host.spawn(executable, args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = Buffer.alloc(0), sequence = 0, ended = false;
  const pending = new Map();
  const fail = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`${kind} CLI configuration lookup failed`)); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => { ended = true; fail(); });
  child.stdin.on('error', fail); child.stderr.resume();
  const send = frame => child.stdin.write(`${JSON.stringify(frame)}\n`);
  child.stdout.on('data', bytes => {
    try {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > MAX) throw new Error('limit');
      let at;
      while ((at = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, at); buffer = buffer.subarray(at + 1);
        if (!line.length) continue;
        const frame = JSON.parse(line.toString('utf8'));
        if (kind === 'claude' && frame.type === 'control_request') {
          send({ type: 'control_response', response: { subtype: 'error', request_id: frame.request_id, error: 'Metadata lookup cannot approve tools or answer dialogs' } }); continue;
        }
        const id = kind === 'codex' ? frame.id : frame.type === 'control_response' ? frame.response?.request_id : null;
        const entry = pending.get(id); if (!entry) continue;
        pending.delete(id); clearTimeout(entry.timer);
        const failed = kind === 'codex' ? frame.error : frame.response?.subtype === 'error';
        if (failed) entry.reject(new Error(`${kind} does not support this configuration lookup`));
        else entry.resolve(kind === 'codex' ? frame.result : frame.response?.response);
      }
    } catch { fail(); child.kill('SIGTERM'); }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (ended) return reject(new Error(`${kind} CLI exited`));
    const id = `options-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${kind} configuration lookup timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    send(kind === 'codex' ? { id, method, params } : { type: 'control_request', request_id: id, request: { subtype: method, ...params } });
  });
  try {
    const init = await request('initialize', kind === 'codex' ? { clientInfo: { name: 'dsh_remote_agents', version: '0.3.3' }, capabilities: null } : {});
    if (kind === 'codex') send({ method: 'initialized', params: {} });
    return await body(request, init);
  } finally {
    fail(); child.stdin.end();
    if (!ended) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => { if (!ended) child.kill('SIGKILL'); }, 500);
      timer.unref?.(); child.once('exit', () => clearTimeout(timer));
    }
  }
}

export async function readCliOptions(provider, host, executable, cwd) {
  let models = [], defaults = {}, restrictions;
  if (provider === 'codex') {
    await withCliReader(host, executable, cwd, provider, async request => {
      const { config } = await request('config/read', { cwd, includeLayers: false });
      defaults = { model: str(config.model), effort: str(config.model_reasoning_effort), permissions: str(config.approval_policy), sandbox: str(config.sandbox_mode) };
      const required = await request('configRequirements/read', {});
      restrictions = required?.requirements;
      let cursor = null;
      do {
        const page = await request('model/list', { limit: 100, cursor });
        models.push(...page.data.filter(m => !m.hidden).map(m => ({ id: str(m.model), label: str(m.displayName), efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort).filter(e => EFFORTS.codex.includes(e)) })));
        cursor = page.nextCursor;
      } while (cursor && models.length < 1000);
    });
  } else if (provider === 'claude') {
    await withCliReader(host, executable, cwd, provider, async (request, init) => {
      models = (init.models || []).map(m => ({ id: str(m.value), label: str(m.displayName), efforts: (m.supportedEffortLevels || []).filter(e => EFFORTS.claude.includes(e)) }));
      const settings = await request('get_settings');
      const applied = settings.applied || {}, effective = settings.effective || settings.settings || {};
      defaults = { model: str(applied.model || effective.model), effort: str(applied.effort || effective.effortLevel), permissions: str(applied.permissionMode || effective.permissions?.defaultMode) };
    });
  } else {
    const json = async args => JSON.parse((await host.run(executable, args, { cwd })).stdout);
    const [catalog, roles, thinking, approval] = await Promise.all([
      json(['models', '--json']), json(['config', 'get', 'modelRoles', '--json']), json(['config', 'get', 'defaultThinkingLevel', '--json']), json(['config', 'get', 'tools.approvalMode', '--json']),
    ]);
    models = (catalog.models || []).filter(m => !m.kind || m.kind === 'chat').map(m => ({ id: str(m.selector || `${m.provider}/${m.id}`), label: str(m.name || m.id), provider: str(m.provider), efforts: m.reasoning ? EFFORTS.omp : ['off'] }));
    defaults = { model: str(roles.value?.default), effort: str(thinking.value), permissions: str(approval.value) };
  }
  const permissions = PERMISSIONS[provider].map(option => {
    let disabled = false;
    if (provider === 'codex' && option.id !== 'cli' && restrictions) {
      const sandbox = option.id === 'yolo' ? 'danger-full-access' : option.id === 'read-only' ? 'read-only' : 'workspace-write';
      const approval = option.id === 'yolo' ? 'never' : option.id === 'safe' ? 'untrusted' : 'on-request';
      disabled = (Array.isArray(restrictions.allowedSandboxModes) && !restrictions.allowedSandboxModes.includes(sandbox)) ||
        (Array.isArray(restrictions.allowedApprovalPolicies) && !restrictions.allowedApprovalPolicies.includes(approval));
    }
    return { ...option, ...(disabled ? { disabled, reason: 'Restricted by CLI policy' } : {}) };
  });
  return { provider, defaults, models: models.filter(m => m.id).slice(0, 1000), efforts: EFFORTS[provider], permissions, source: `${provider} CLI`, loadedAt: new Date().toISOString() };
}
