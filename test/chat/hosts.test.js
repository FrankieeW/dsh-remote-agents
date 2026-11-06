import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHosts, remoteCommand, sshArgs } from '../../src/chat/hosts.js';
import { FleetManager } from '../../src/core/index.js';
const machine={id:'remote',type:'ssh',host:'dev-box',name:'Development',user:'alice',port:2222};

test('remote argv preserves spaces/quotes/metacharacters without shell expansion',()=>{
  const args=['a b',"it's",'$(touch /tmp/MUST_NOT_CREATE)', '; echo bad'];
  const command=remoteCommand('/usr/bin/printf',['%s\n',...args],'/tmp');
  assert.deepEqual(execFileSync('/bin/sh',['-c',command],{encoding:'utf8'}).trim().split('\n'),args);
  const ssh=sshArgs(machine,command);assert.ok(ssh.includes('BatchMode=yes'));assert.ok(ssh.includes('StrictHostKeyChecking=yes'));assert.ok(ssh.includes('-T'));
  assert.deepEqual(ssh.slice(-3),['--','dev-box',command]);assert.throws(()=>sshArgs({...machine,host:'-oProxyCommand=bad'},'pwd'));
});

test('local completion returns directories only and remote completion/execution never use local cwd or credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'host-completion-'));await mkdir(join(root,'code space'));await writeFile(join(root,'file'),'x');
  const calls=[],spawns=[];
  const fleet={snapshot:async()=>({machines:[{id:'local',type:'local'},machine]}),namespace:async()=> 'test-namespace'};
  const hosts=createHosts(fleet,{executeFn:async(file,args,options)=>{calls.push({file,args,options});return {stdout:args.at(-1).includes('pwd -P')?'/srv/code\n':'./alpha\0./a space\0./beta\0'};},spawnFn:(...args)=>{spawns.push(args);return {};}});
  const local=await hosts.browse({path:root+'/c'});assert.deepEqual(local.entries,[{name:'code space',path:join(await realpath(root),'code space')+'/'}]);
  const remote=await hosts.browse({machineId:'remote',path:'~/a'});assert.deepEqual(remote.entries.map(e=>e.name),['a space','alpha']);
  const host=await hosts.host('remote');host.spawn('/bin/claude',['--model','a b'],{cwd:'/remote-only/path',env:{SECRET:'never forward'}});
  assert.equal(spawns[0][0],'ssh');assert.equal(spawns[0][2].cwd,undefined);assert.equal(spawns[0][2].env,undefined);assert.match(spawns[0][1].at(-1),/remote-only/);
  await assert.rejects(hosts.host('unknown'));await assert.rejects(hosts.browse({machineId:'remote',path:'bad\npath'}));
  assert.ok(calls.every(c=>c.file==='ssh'));
});

test('registered remote workspaces deduplicate per machine and preserve mappings across reloads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'remote-workspaces-'));const statePath=join(root,'fleet.json');
  const fleet=new FleetManager({statePath});const m=await fleet.addMachine({name:'Dev',host:'dev-box'});
  const one=await fleet.addWorkspace({machineId:m.id,cwd:'/srv/code'});const two=await fleet.addWorkspace({machineId:m.id,cwd:'/srv/code'});assert.equal(one.id,two.id);
  const reloaded=new FleetManager({statePath});const s=await reloaded.snapshot({readOnly:true});assert.equal(s.projects.length,1);assert.equal(s.projects[0].source,'workspace');
  await assert.rejects(reloaded.removeMachine(m.id));
});
