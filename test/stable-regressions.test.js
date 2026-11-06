import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatManager } from '../src/chat/manager.js';
import { FleetManager } from '../src/core/index.js';
import { createWorkspaceStore } from '../src/client/workspace-store.js';
import { createPoller } from '../src/client/polling.js';
import { planUpdate } from '../src/chat/updates.js';
import { diagnose } from '../src/client/diagnostics.js';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('startup failure remains visible, retries automatically, and preserves known machines on disconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let online = false, catalogReads = 0;
  const store = createWorkspaceStore(async method => {
    if (method === 'chatList') return { sessions: [], providers: [] };
    catalogReads++;
    if (!online) throw Error('SSH connection unavailable');
    return { machines: [{id:'local'}, {id:'remote'}], workspaces: [] };
  });
  t.after(() => store.dispose());
  store.start(); await flush();
  assert.match(store.getSnapshot().workspaceError, /connection/);
  online = true; t.mock.timers.tick(1000); await flush();
  assert.equal(catalogReads, 2); assert.equal(store.getSnapshot().machines.length, 2);
  assert.equal(store.getSnapshot().workspaceError, '');
  online = false; store.refresh(); await flush();
  assert.equal(store.getSnapshot().machines.length, 2);
  assert.match(store.getSnapshot().workspaceError, /connection/);
  store.dispose(); const before = catalogReads; t.mock.timers.tick(60000); await flush(); assert.equal(catalogReads, before);
});

test('polling slows in hidden windows, wakes on visibility/reconnect and never overlaps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = new EventTarget(), win = new EventTarget(); doc.visibilityState = 'hidden';
  let count = 0, release;
  const loop = createPoller(async () => { count++; if (count === 2) await new Promise(r => release = r); }, { document: doc, window: win, delay: () => 700 });
  t.after(() => loop.stop());
  await loop.start(); t.mock.timers.tick(10000); await flush(); assert.equal(count, 1);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(count, 2);
  win.dispatchEvent(new Event('online')); win.dispatchEvent(new Event('online')); t.mock.timers.tick(60000); await flush(); assert.equal(count, 2);
  release(); await flush(); assert.equal(count, 3);
  loop.stop(); win.dispatchEvent(new Event('online')); t.mock.timers.tick(60000); await flush(); assert.equal(count, 3);
});

test('partial settings preserve other fields, reject stale saves, and survive manager restart', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-stable-settings-')), statePath = join(cwd, 'chat.json');
  let starts = 0; const providers = {codex: async () => { starts++; throw Error('must stay lazy'); }};
  const manager = new ChatManager({statePath, providers}); t.after(() => manager.dispose());
  const session = await manager.create({provider:'codex',cwd});
  const first = await manager.configure({id:session.id, patch:{permissions:'read-only'}, expectedRevision:0});
  assert.equal(first.settingsRevision, 1);
  await assert.rejects(manager.configure({id:session.id,patch:{model:'stale'},expectedRevision:0}), {code:'CONFLICT'});
  await manager.configure({id:session.id,patch:{model:'model-a'},expectedRevision:1});
  await manager.configure({id:session.id,patch:{effort:'low'},expectedRevision:2});
  await manager.dispose();
  const restored = new ChatManager({statePath, providers}); t.after(() => restored.dispose());
  assert.deepEqual((await restored.get(session.id)).settings,{model:'model-a',effort:'low',permissions:'read-only'});
  assert.equal((await restored.get(session.id)).settingsRevision,3); assert.equal(starts,0);
});

test('metadata, retained-text search and safe exports survive archive and restart', async t => {
  const cwd=await mkdtemp(join(tmpdir(),'dsh-stable-history-')),statePath=join(cwd,'chat.json');
  const providers={codex:async({emit})=>({send:async()=>emit('text.done',{text:'Unique retained reply `code`'}),abort:async()=>{},close:async()=>{}})};
  const manager=new ChatManager({statePath,providers});t.after(()=>manager.dispose());
  const s=await manager.create({provider:'codex',cwd});await manager.send({id:s.id,text:'hello',requestId:'once'});
  for(let n=0;n<100&&(await manager.get(s.id)).status==='running';n++)await flush();
  await manager.metadata({id:s.id,name:'Release verification',pinned:true,archived:true});
  assert.equal((await manager.search('unique retained'))[0].id,s.id);
  assert.equal((await manager.list())[0].archived,true);
  const json=JSON.parse((await manager.export(s.id,'json')).content);assert.equal(json.messages.length,2);assert.equal(json.requests,undefined);assert.equal(json.providerSessionId,undefined);
  assert.match((await manager.export(s.id,'markdown')).content,/Unique retained reply/);
  await assert.rejects(manager.export(s.id,'html'));
  await manager.dispose();const restored=new ChatManager({statePath,providers});t.after(()=>restored.dispose());
  assert.equal((await restored.get(s.id)).name,'Release verification');assert.equal((await restored.get(s.id)).pinned,true);
  await restored.metadata({id:s.id,archived:false});assert.equal((await restored.list())[0].archived,false);
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).sessions[0].messages.length,2);
});

test('workspace removal deletes only registration, not directory or conversation state', async () => {
  const cwd=await mkdtemp(join(tmpdir(),'dsh-stable-workspace-')),statePath=join(cwd,'fleet.json');
  const fleet=new FleetManager({statePath});const machine=await fleet.addMachine({name:'dev',host:'dev'});
  const workspace=await fleet.addWorkspace({machineId:machine.id,cwd:'/remote/project'});
  await fleet.removeWorkspace(workspace.id);assert.equal((await fleet.snapshot({readOnly:true})).projects.length,0);
  assert.equal((await fleet.snapshot({readOnly:true})).machines.length,2);
});

for(const [source,method] of [
  ['/opt/node/lib/node_modules/@openai/codex/bin/codex.js','npm'],
  ['/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js','bun'],
  ['/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/@openai+codex@0.166.0/node_modules/@openai/codex/bin/codex.js','pnpm'],
]) test(`pinned updater recognizes ${method} and never uses latest or native update`,async()=>{
  const host={executable:async name=>`/bin/${name}`,run:async()=>({stdout:JSON.stringify({path:source})})};
  const plan=await planUpdate(host,{executable:'/bin/codex',version:'0.166.0'},'codex','remote');
  assert.equal(plan.canUpdate,true);assert.equal(plan.method,method);assert.ok(plan.args.includes('@openai/codex@0.167.0'));assert.ok(!plan.args.includes('update'));assert.equal(plan.token.length,64);
});

test('unknown installations remain manual; compatible installations are never downgraded',async()=>{
  const host={executable:async name=>`/bin/${name}`,run:async()=>({stdout:JSON.stringify({path:'/opt/homebrew/Cellar/codex/0.166.0/codex'})})};
  assert.equal((await planUpdate(host,{executable:'/bin/codex',version:'0.166.0'},'codex','remote')).canUpdate,false);
  assert.equal((await planUpdate(host,{executable:'/bin/codex',version:'0.167.9',available:true},'codex','remote')).canUpdate,false);
  assert.match(diagnose("You've hit your 5-hour limit · resets 4:10am (Asia/Shanghai)").detail,/4:10am/);
  assert.equal(diagnose('SSH host: Connection timed out').title,'Connection timed out');
});
