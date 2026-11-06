import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { createClaudeProvider } from './claude.js';
import { createOmpProvider } from './omp.js';

const execute = promisify(execFile);
const LABELS = { claude: 'Claude Code', omp: 'OMP · Oh My Pi' };
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
export function createProviderRegistry({ claudeExecutable, ompExecutable, sessionRoot, probe = execute, resolveExecutable = findExecutable, factories = { claude: createClaudeProvider, omp: createOmpProvider } } = {}) {
  let cache;
  let expires = 0;
  const configured = { claude: claudeExecutable, omp: ompExecutable };
  async function inspect(id) {
    const base = { id, label: LABELS[id], capabilities: { local: true, remote: false, streamingText: true, tools: true, approvals: true, questions: false, attachments: false, models: false } };
    const executable = await resolveExecutable(id === 'claude' ? 'claude' : 'omp', configured[id]);
    if (!executable) return { ...base, available: false, reason: `${id} was not found. Install it and sign in using its native CLI.` };
    try {
      const { stdout } = await probe(executable, ['--version'], { timeout: 3000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true });
      const match = String(stdout).match(/(?<!\d)(\d+)\.(\d+)\.(\d+)\b/);
      if (!match) throw new Error('version');
      const [, major, minor, patch] = match.map(Number);
      const compatible = id === 'omp' ? major === 18 && minor >= 17 : major === 2 && (minor > 1 || minor === 1 && patch >= 318);
      return { ...base, executable, version: match[0], available: compatible, reason: compatible ? undefined : `Unsupported version: ${match[0]}. Requires ${id === 'omp' ? 'OMP 18.17.x–18.x (RPC v2)' : 'Claude Code ≥2.1.318 and <3'}.` };
    } catch {
      return { ...base, available: false, reason: `${LABELS[id]} version check failed. Terminal parsing is not used as a fallback.` };
    }
  }
  async function descriptions() {
    if (!cache || Date.now() >= expires) {
      expires = Date.now() + 60000;
      cache = Promise.all(['claude', 'omp'].map(inspect));
    }
    // Executable paths stay server-side; the browser cannot supply launch arguments.
    return (await cache).map(({ executable, ...item }) => item);
  }
  const providers = Object.fromEntries(['claude', 'omp'].map(id => [id, async context => {
    await descriptions();
    const found = (await cache).find(item => item.id === id);
    if (!found?.available) throw new Error(found?.reason || 'Provider unavailable');
    return factories[id]({ executable: found.executable, sessionRoot })(context);
  }]));
  return { providers, descriptions };
}
