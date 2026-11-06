import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../reference/src/chat/providers.js';

test('capability probe is cached, version-only, does not expose executable or create runtimes', async () => {
  const calls = [], starts = [];
  const registry = createProviderRegistry({
    resolveExecutable: async name => `/private/bin/${name}`,
    probe: async (file, args) => { calls.push([file, args]); return { stdout: file.endsWith('codex') ? 'codex-cli 0.167.0' : file.endsWith('omp') ? 'omp v18.17.0' : '2.1.318 (Claude Code)' }; },
    factories: Object.fromEntries(['omp', 'claude', 'codex'].map(id => [id, options => context => { starts.push([id, options, context]); return { fake: true }; }])),
    sessionRoot: '/private/test-sessions',
  });
  const [one, two] = await Promise.all([registry.descriptions(), registry.descriptions()]);
  assert.deepEqual(one, two);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([, args]) => JSON.stringify(args) === '["--version"]'));
  assert.ok(one.every(item => item.available && !Object.hasOwn(item, 'executable')));
  assert.equal(starts.length, 0);
  await registry.providers.omp({ session: { id: 'fake' } });
  assert.equal(starts.length, 1);
  assert.equal(starts[0][1].executable, '/private/bin/omp');
});

test('missing, failed, and incompatible providers fail closed with no terminal fallback', async () => {
  for (const stdout of ['omp v16.3.12', 'omp v19.0.0', 'unexpected']) {
    const registry = createProviderRegistry({ resolveExecutable: async name => name === 'omp' ? '/bin/omp' : null, probe: async () => ({ stdout }) });
    const items = await registry.descriptions();
    assert.ok(items.every(item => !item.available));
    await assert.rejects(registry.providers.omp({}));
    await assert.rejects(registry.providers.claude({}));
  }
  const registry = createProviderRegistry({ resolveExecutable: async () => '/bin/fake', probe: async () => { throw Error('SECRET'); } });
  assert.ok((await registry.descriptions()).every(item => !item.available && !item.reason.includes('SECRET')));
});
