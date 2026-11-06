import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, posix, join } from 'node:path';
import { validSSH } from '../core/ssh.js';
import { shellQuote } from '../core/index.js';
const execute = promisify(execFile);
const safePath = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && (value.startsWith('/') || value === '~' || value.startsWith('~/'));
const shellPath = path => path === '~' ? '"$HOME"' : path.startsWith('~/') ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
export function sshArgs(machine, command) {
  if (!validSSH(machine)) throw new Error('Invalid SSH machine');
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    ...(machine.user ? ['-l', machine.user] : []), ...(machine.port ? ['-p', String(machine.port)] : []), '--', machine.host, command];
}
const pathEnv = 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
export function remoteCommand(file, args, cwd) {
  if (!safePath(cwd)) throw new Error('Invalid remote directory');
  return `${pathEnv}cd ${shellPath(cwd)} && exec ${[file, ...args].map(shellQuote).join(' ')}`;
}

/** Only registered machine IDs are accepted; remote credentials/config never cross hosts. */
export function createHosts(fleet, { executeFn = execute, spawnFn = spawn } = {}) {
  async function host(machineId = 'local') {
    const snapshot = await fleet.snapshot({ readOnly: true });
    const machine = snapshot.machines.find(value => value.id === machineId);
    if (!machine) throw new Error('Machine is no longer registered');
    const remote = machine.type === 'ssh';
    const runShell = async command => {
      try { return await executeFn('ssh', sshArgs(machine, command), { timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' }); }
      catch (e) { throw new Error(`SSH ${machine.name}: operation failed (${e.code || 'connection error'}). Check connectivity, known_hosts and the directory.`); }
    };
    const canonicalize = async path => {
      if (!safePath(path)) throw new Error('Enter an absolute directory or ~/path');
      if (!remote) {
        const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
        const resolved = await realpath(expanded);
        if (!(await stat(resolved)).isDirectory()) throw new Error('Path is not a directory');
        return resolved;
      }
      const { stdout } = await runShell(`cd ${shellPath(path)} && pwd -P`);
      const result = stdout.trim();
      if (!isAbsolute(result) || !safePath(result)) throw new Error('Remote shell returned an invalid directory');
      return result;
    };
    return { machine, remote, canonicalize, runShell,
      async run(file, args, options = {}) {
        if (!remote) return executeFn(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', ...options });
        try { return await executeFn('ssh', sshArgs(machine, remoteCommand(file, args, options.cwd || '~')), { timeout: options.timeout || 25000, maxBuffer: options.maxBuffer || 8 * 1024 * 1024, encoding: 'utf8', signal: options.signal }); }
        catch (e) {
          const hint = e.killed || /timed out|timeout/i.test(e.message || '') ? 'Connection timed out' : /Host key verification failed/i.test(e.stderr || '') ? 'Host key verification failed; verify this host in a terminal' : /Permission denied/i.test(e.stderr || '') ? 'SSH authentication failed; check your key and user' : 'CLI operation failed; check CLI startup and PATH';
          throw Object.assign(new Error(`SSH ${machine.name}: ${hint} (${e.code || 'connection error'}).`), { code: e.killed ? 'TIMEOUT' : e.code });
        }
      },
      spawn(file, args, options = {}) {
        if (!remote) return spawnFn(file, args, options);
        return spawnFn('ssh', sshArgs(machine, remoteCommand(file, args, options.cwd || '~')), { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal: options.signal });
      },
      async executable(name) {
        const { stdout } = await runShell(`${pathEnv}command -v ${shellQuote(name)} || true`);
        const path = stdout.trim();
        return isAbsolute(path) && safePath(path) ? path : null;
      },
      async sessionDirectory(id) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
        // Each plugin state path has its own persisted fleet namespace.
        const namespace = (await fleet.namespace?.()) || 'dsh';
        if (!/^[A-Za-z0-9_-]+$/.test(namespace)) throw new Error('Invalid state namespace');
        const path = `~/.dsh/remote-agents/omp-sessions/${namespace}/${id}`;
        await runShell(`umask 077; mkdir -p ${shellPath(path)} && test ! -L ${shellPath(path)} && chmod 700 ${shellPath(path)}`);
        return canonicalize(path);
      },
      async browse(input) {
        if (!safePath(input)) throw new Error('Enter an absolute directory or ~/path');
        const ends = input.endsWith('/') || input === '~';
        const baseInput = ends ? input : posix.dirname(input);
        const prefix = ends ? '' : posix.basename(input);
        const base = await canonicalize(baseInput);
        let entries, truncated = false;
        if (remote) {
          const { stdout } = await runShell(`cd ${shellQuote(base)} || exit; n=0; for p in ./* ./.[!.]* ./..?*; do [ -d "$p" ] || continue; name=\${p#./}; case "$name" in ${shellQuote(prefix)}*) ;; *) continue ;; esac; n=$((n+1)); [ "$n" -le 200 ] || break; printf '%s\\0' "$p"; done; [ "$n" -le 200 ] || printf '__TRUNCATED__\\0'`);
          entries = stdout.split('\0').filter(Boolean); truncated = entries.includes('__TRUNCATED__');
          entries = entries.filter(p => p.startsWith('./')).map(p => p.slice(2));
        } else {
          const items = await readdir(base, { withFileTypes: true }); entries = [];
          for (const item of items) {
            if (item.isDirectory() || (item.isSymbolicLink() && await stat(join(base, item.name)).then(s => s.isDirectory(), () => false))) entries.push(item.name);
          }
        }
        entries = entries.filter(name => !/[\x00-\x1f\x7f]/.test(name) && name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())).sort();
        truncated ||= entries.length > 100;
        return { base, entries: entries.slice(0, 100).map(name => ({ name, path: posix.join(base, name) + '/' })), truncated };
      },
    };
  }
  return { host, validateDirectory: async (id, path) => (await host(id)).canonicalize(path), browse: async ({ machineId = 'local', path = '~/' }) => (await host(machineId)).browse(path) };
}
