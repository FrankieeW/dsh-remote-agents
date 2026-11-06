import { createHash } from 'node:crypto';

export const UPDATE_TARGETS = Object.freeze({
  claude: { package: '@anthropic-ai/claude-code', version: '2.1.318' },
  codex: { package: '@openai/codex', version: '0.167.0' },
  omp: { package: '@oh-my-pi/pi-coding-agent', version: '18.17.0' },
});
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;

// Inspect the installed executable's canonical package path. Never guess a global
// package manager from its presence alone, or replace a standalone binary with npm.
const inspectScript = `const fs=require('fs');const p=fs.realpathSync(process.argv[1]);console.log(JSON.stringify({path:p}));`;
export async function planUpdate(host, found, provider, machineId) {
  const target = UPDATE_TARGETS[provider];
  const base = { provider, machineId, targetVersion: target.version, beforeVersion: found?.version, canUpdate: false };
  const manual = `Install ${target.package}@${target.version} using the CLI's existing installation method, then refresh versions.`;
  if (!found?.executable) return { ...base, method: 'manual', reason: `CLI not found. ${manual}` };
  if (found.available) return { ...base, method: 'none', reason: `Installed ${found.version} is compatible; no update needed.` };
  let canonical;
  try {
    const node = await host.executable('node');
    if (!node) throw new Error('Node is unavailable');
    canonical = JSON.parse((await host.run(node, ['-e', inspectScript, found.executable], { timeout: 15000, maxBuffer: 8192 })).stdout).path;
  } catch { return { ...base, method: 'manual', reason: `Could not identify the installation source. ${manual}` }; }
  let manager, executable, args;
  const packagePart = `/node_modules/${target.package}/`;
  if (provider === 'claude' && /\/\.local\/share\/claude\/versions\//.test(canonical)) {
    manager = 'Claude native installer'; executable = found.executable; args = ['install', target.version];
  } else if (canonical.includes('/.bun/install/global/') && canonical.includes(packagePart)) {
    manager = 'bun'; executable = await host.executable('bun'); args = ['add', '--global', `${target.package}@${target.version}`];
  } else if (/\/pnpm\/global\//.test(canonical) && canonical.includes(packagePart)) {
    manager = 'pnpm'; executable = await host.executable('pnpm'); args = ['add', '--global', `${target.package}@${target.version}`];
  } else if (canonical.includes(`/lib${packagePart}`)) {
    manager = 'npm'; executable = await host.executable('npm');
    const prefix = canonical.slice(0, canonical.indexOf(`/lib${packagePart}`));
    args = ['install', '--global', '--prefix', prefix || '/', `${target.package}@${target.version}`];
  }
  if (!executable) return { ...base, method: 'manual', reason: `Automatic updates are unavailable for this installation. ${manual}` };
  const token = createHash('sha256').update(JSON.stringify([machineId, provider, found.executable, found.version, canonical, executable, args])).digest('hex');
  return { ...base, canUpdate: true, method: manager, token, command: [executable, ...args].map(quote).join(' '), executable, args };
}
