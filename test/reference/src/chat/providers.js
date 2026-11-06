import { planUpdate } from './updates.js';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createClaudeProvider } from './claude.js';
import { createOmpProvider } from './omp.js';
import { createCodexProvider } from './codex.js';
import { readCliOptions } from './cli-options.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const execute = promisify(execFile);
const LABELS = { codex: 'Codex', claude: 'Claude Code', omp: 'OMP · Oh My Pi' };
export async function findExecutable(name, configured) {
  const candidates = configured ? [configured] : [...new Set([
    ...(process.env.PATH || '').split(delimiter).filter(isAbsolute),
    join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ])].map(directory => join(directory, name));
  for (const path of candidates) {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) continue;
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch { /* Try the next explicit PATH entry. Never search the working project. */ }
  }
  return null;
}

/** Local capability checks run --version only; never start a conversation/auth flow. */
export function createProviderRegistry({ claudeExecutable, ompExecutable, codexExecutable, sessionRoot, hosts, probe = execute, resolveExecutable = findExecutable, factories = { claude: createClaudeProvider, omp: createOmpProvider, codex: createCodexProvider } } = {}) {
  const caches = new Map(), optionCache = new Map(), updates = new Map();
  const localHost = { remote: false, run: probe, spawn };
  const getHost = id => hosts ? hosts.host(id) : id === "local" ? Promise.resolve(localHost) : Promise.reject(new Error("SSH is unavailable"));
  const configured = { claude: claudeExecutable, omp: ompExecutable, codex: codexExecutable };
  async function inspect(id, host) {
    const base = { id, label: LABELS[id], capabilities: { local: true, remote: true, streamingText: true, tools: true, approvals: true, questions: false, attachments: false, models: true, settings: true } };
    let executable;
    try { executable = host.remote ? await host.executable(id) : await resolveExecutable(id, configured[id]); }
    catch { return { ...base, available: false, reason: `Could not check ${LABELS[id]} on the SSH host. Check SSH connectivity and PATH.` }; }
    if (!executable) return { ...base, available: false, reason: `${id} was not found. Install it and sign in using its native CLI.` };
    try {
      const { stdout } = await host.run(executable, ['--version'], { timeout: host.remote ? 15000 : 5000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true });
      const match = String(stdout).match(/(?<!\d)(\d+)\.(\d+)\.(\d+)\b/);
      if (!match) throw new Error('version');
      const [, major, minor, patch] = match.map(Number);
      const compatible = id === 'codex' ? major === 0 && minor === 167 : id === 'omp' ? major === 18 && minor >= 17 : major === 2 && (minor > 1 || minor === 1 && patch >= 318);
      return { ...base, executable, version: match[0], available: compatible, reason: compatible ? undefined : `Unsupported version: ${match[0]}. Requires ${id === 'codex' ? 'Codex 0.167.x (app-server v2)' : id === 'omp' ? 'OMP 18.17.x–18.x (RPC v2)' : 'Claude Code ≥2.1.318 and <3'}.` };
    } catch (error) {
      const timedOut = error.killed || error.code === 'TIMEOUT' || /timed out|timeout/i.test(error.message || '');
      return { ...base, available: false, reason: timedOut ? `${LABELS[id]} version check timed out. Check SSH connectivity and CLI startup, then refresh versions.` : `${LABELS[id]} version check failed. Check CLI startup and PATH, then refresh versions.` };
    }
  }
  async function inspectHost(machineId = 'local') {
    let cached = caches.get(machineId);
    if (!cached || Date.now() >= cached.expires) {
      const promise = getHost(machineId).then(host => Promise.all(['claude', 'codex', 'omp'].map(id => inspect(id, host))));
      cached = { promise, expires: Date.now() + 60000 }; caches.set(machineId, cached);
      promise.catch(() => caches.delete(machineId));
    }
    return cached.promise;
  }
  async function descriptions(machineId = 'local', refresh = false) {
    if (refresh) { caches.delete(machineId); optionCache.clear(); }
    return (await inspectHost(machineId)).map(({ executable, ...item }) => {
      const update = [...updates.values()].filter(job => job.machineId === machineId && job.provider === item.id).at(-1);
      return update ? { ...item, update: { ...update } } : item;
    });
  }
  async function resolved(session) {
    if ([...updates.values()].some(job => job.machineId === session.machineId && job.provider === session.provider && job.status === 'running')) throw new Error('This remote CLI is updating. Try again after the update finishes.');
    const found = (await inspectHost(session.machineId || 'local')).find(item => item.id === session.provider);
    if (!found?.available) throw new Error(found?.reason || 'Provider unavailable');
    return { found, host: await getHost(session.machineId || 'local') };
  }
  async function options(session, refresh = false) {
    const key = JSON.stringify([session.machineId || 'local', session.provider, session.cwd]);
    let cached = optionCache.get(key);
    if (!cached || refresh || cached.expires < Date.now()) {
      const promise = resolved(session).then(({ found, host }) => readCliOptions(session.provider, host, found.executable, session.cwd));
      cached = { promise, expires: Date.now() + 60000 }; optionCache.set(key, cached);
      promise.catch(() => optionCache.delete(key));
      if (optionCache.size > 64) optionCache.delete(optionCache.keys().next().value);
    }
    return cached.promise;
  }
  const providers = Object.fromEntries(['claude', 'codex', 'omp'].map(id => [id, async context => {
    const { found, host } = await resolved({ ...context.session, provider: id });
    return factories[id]({ executable: found.executable, sessionRoot, execution: host })(context);
  }]));
  async function updatePlan({ machineId, provider }) {
    if (machineId === 'local' || !Object.hasOwn(LABELS, provider)) throw new Error('Select a remote CLI to update');
    const host = await getHost(machineId);
    if (!host.remote) throw new Error('Select an SSH host');
    const found = (await inspectHost(machineId)).find(item => item.id === provider);
    const { executable, args, ...plan } = await planUpdate(host, found, provider, machineId);
    return plan;
  }
  async function startUpdate({ machineId, provider, token }) {
    if (machineId === 'local' || !Object.hasOwn(LABELS, provider)) throw new Error('Select a remote CLI to update');
    const existing = [...updates.values()].find(job => job.machineId === machineId && job.provider === provider && job.status === 'running');
    if (existing) return { ...existing };
    const host = await getHost(machineId);
    if (!host.remote) throw new Error('This update action is for SSH hosts only');
    caches.delete(machineId);
    const found = (await inspectHost(machineId)).find(item => item.id === provider);
    if (!found?.executable) throw new Error('CLI not found. Install it on the SSH host first.');
    const plan = await planUpdate(host, found, provider, machineId);
    if (!plan.canUpdate) throw new Error(plan.reason);
    if (!token || token !== plan.token) throw new Error('The update plan changed. Refresh versions and review the target before updating.');
    // Recheck after asynchronous discovery: double clicks share one job.
    const raced = [...updates.values()].find(job => job.machineId === machineId && job.provider === provider && job.status === 'running');
    if (raced) return { ...raced };
    if (updates.size >= 32) {
      const oldest = [...updates.values()].find(job => job.status !== 'running');
      if (!oldest) throw new Error('Too many CLI updates are running');
      updates.delete(oldest.id);
    }
    const job = { id: randomUUID(), machineId, provider, status: 'running', beforeVersion: found.version, targetVersion: plan.targetVersion, method: plan.method, startedAt: new Date().toISOString() };
    updates.set(job.id, job);
    void (async () => {
      try {
        await host.run(plan.executable, plan.args, { timeout: 120000, maxBuffer: 512 * 1024 });
        caches.delete(machineId); optionCache.clear();
        const current = (await descriptions(machineId)).find(item => item.id === provider);
        job.status = current?.available && current.version === plan.targetVersion ? 'completed' : 'failed'; job.version = current?.version;
        job.compatible = current?.available === true;
        job.message = job.status === 'completed' ? `Installed ${current.version}. Ready for new sessions.` : current?.reason || 'The selected executable did not change to the target version. Check PATH and refresh before retrying.';
      } catch (error) { job.status = 'failed'; job.message = `${error.message} Review the pinned update command on the SSH host; refresh versions before retrying.`; }
      finally { job.finishedAt = new Date().toISOString(); }
    })();
    return { ...job };
  }
  function updateStatus(id) {
    const job = updates.get(id);
    if (!job) throw new Error('Update status expired; refresh the remote CLI versions.');
    return { ...job };
  }
  return { providers, descriptions, options, updatePlan, startUpdate, updateStatus };

}
