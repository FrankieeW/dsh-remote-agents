import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatManager } from '../../src/chat/manager.js';
import { validateSettings, DEFAULT_SETTINGS, codexPermissionOptions } from '../../src/chat/settings.js';
import { createProviderRegistry } from '../../src/chat/providers.js';

const until = async check => { for(let i=0;i<100;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw Error('timeout'); };
test('settings accept only provider-specific CLI fields and permission values', () => {
  assert.deepEqual(validateSettings('codex', {}), DEFAULT_SETTINGS);
  for (const value of [{model:'-c bad'}, {model:'bad\nmodel'}, {model:[]}, {effort:'ultra'}, {permissions:'bypassPermissions'}, {env:{SECRET:'x'}}, {command:'rm'}]) assert.throws(()=>validateSettings('codex',value));
  assert.deepEqual(codexPermissionOptions('yolo'), {sandbox:'danger-full-access',approvalPolicy:'never',approvalsReviewer:'user'});
  assert.deepEqual(codexPermissionOptions('cli'), {});
  assert.equal(validateSettings('claude', {permissions:'bypassPermissions'}).permissions,'bypassPermissions');
});

test('settings persist, invalidate idle runtimes, preserve native IDs, reject busy/closed changes', async t => {
  const cwd=await mkdtemp(join(tmpdir(),'settings-')),statePath=join(cwd,'chat.json');
  const seen=[];let release, closed=0;
  const providers={codex:async context=>{seen.push(context.session);return {send:async()=>{context.emit('provider.session',{id:'owned'});context.emit('provider.settings',{model:'resolved-model',permissions:'never',secret:'NO'});if(seen.length===2)await new Promise(r=>release=r);},abort:async()=>{},close:async()=>{closed++;}};}};
  const manager=new ChatManager({statePath,providers});t.after(()=>manager.dispose());
  const s=await manager.create({provider:'codex',cwd});assert.deepEqual(s.settings,DEFAULT_SETTINGS);
  await manager.send({id:s.id,text:'first',requestId:'1'});await until(async()=>(await manager.get(s.id)).status==='idle');
  assert.deepEqual((await manager.get(s.id)).effectiveSettings,{model:'resolved-model',permissions:'never'});
  const changed=await manager.configure({id:s.id,settings:{model:'new-model',effort:'high',permissions:'yolo'}});
  assert.equal(changed.providerSessionId,'owned');assert.equal(changed.effectiveSettings,undefined);assert.equal(closed,1);
  await manager.send({id:s.id,text:'second',requestId:'2'});await until(()=>!!release);
  assert.equal(seen[1].settings.model,'new-model');assert.equal(seen[1].providerSessionId,'owned');
  await assert.rejects(manager.configure({id:s.id,settings:DEFAULT_SETTINGS}),{code:'BUSY'});
  release();await until(async()=>(await manager.get(s.id)).status==='idle');await manager.close(s.id);
  await assert.rejects(manager.configure({id:s.id,settings:DEFAULT_SETTINGS}),{code:'CLOSED'});await manager.dispose();
  const reopened=new ChatManager({statePath,providers});t.after(()=>reopened.dispose());assert.equal((await reopened.get(s.id)).settings.permissions,'yolo');
});

test('older sessions keep explicit approval behavior; remote cwd is validated on its own host',async t=>{
  const root=await mkdtemp(join(tmpdir(),'settings-migrate-'));const statePath=join(root,'chat.json');
  const providers={omp:async()=>{throw Error('must remain lazy');}};
  const manager=new ChatManager({statePath,providers,validateDirectory:async(id,path)=>{assert.equal(id,'remote');assert.equal(path,'/remote/project');return path;}});t.after(()=>manager.dispose());
  const s=await manager.create({provider:'omp',machineId:'remote',cwd:'/remote/project'});assert.equal(s.machineId,'remote');await manager.dispose();
  const data=JSON.parse(await readFile(statePath,'utf8'));delete data.sessions[0].settings;await writeFile(statePath,JSON.stringify(data));
  const reopened=new ChatManager({statePath,providers});t.after(()=>reopened.dispose());assert.equal((await reopened.get(s.id)).settings.permissions,'always-ask');
});

test('remote updates use one pinned update job, recheck versions, and reject arbitrary/local commands',async()=>{
  let version='0.166.0',release;const calls=[];
  const host={remote:true,executable:async id=>['codex','node','npm'].includes(id)?`/usr/bin/${id}`:null,run:async(file,args)=>{calls.push([file,args]);if(args[0]==='--version')return{stdout:`codex-cli ${version}`};if(args[0]==='-e')return{stdout:JSON.stringify({path:'/usr/lib/node_modules/@openai/codex/bin/codex.js'})};await new Promise(r=>release=r);version='0.167.0';return{stdout:'secret output is not returned'};}};
  const registry=createProviderRegistry({hosts:{host:async()=>host}});
  const plan=await registry.updatePlan({machineId:'remote',provider:'codex'});
  const [one,two]=await Promise.all([registry.startUpdate({machineId:'remote',provider:'codex',token:plan.token}),registry.startUpdate({machineId:'remote',provider:'codex',token:plan.token})]);
  assert.equal(one.id,two.id);assert.equal(calls.filter(([,args])=>args[0]==='install').length,1);
  await assert.rejects(registry.providers.codex({session:{machineId:'remote',provider:'codex'}}),/updating/);
  release();await until(()=>registry.updateStatus(one.id).status!=='running');
  const done=registry.updateStatus(one.id);assert.equal(done.version,'0.167.0');assert.equal(done.compatible,true);assert.ok(!JSON.stringify(done).includes('secret'));
  assert.equal((await registry.descriptions('remote')).find(p=>p.id==='codex').available,true);
  await assert.rejects(registry.startUpdate({machineId:'local',provider:'codex'}));await assert.rejects(registry.startUpdate({machineId:'remote',provider:'shell'}));
});
