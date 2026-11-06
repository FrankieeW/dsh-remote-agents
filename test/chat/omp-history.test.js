import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readOmpTurn } from '../reference/src/chat/omp-history.js';
const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'dsh-omp-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const session={id:'owned-app',provider:'omp',machineId:'local',providerSessionId:'owned-native',cwd:'/project',messages:[{id:'a1',role:'assistant'},{id:'a2',role:'assistant'}],requests:[{assistantMessageId:'a1',textHash:hash('continue')},{assistantMessageId:'a2',textHash:hash('continue')}]};
  const rows=[{type:'session',id:'owned-native',cwd:'/project',secret:'DO_NOT_RETURN'}];let parentId=null;
  const add=(type,message)=>{const row={type,id:'row-'+rows.length,parentId,message};rows.push(row);parentId=row.id;return row;};
  add('message',{role:'user',content:[{type:'text',text:'continue'}]});
  for(let i=0;i<21;i++){
    add('message',{role:'assistant',credentialId:'DO_NOT_RETURN',providerPayload:{key:'DO_NOT_RETURN'},content:[{type:'toolCall',id:'tool-'+i,name:'read',arguments:{path:'/project/file-'+i}}]});
    add('message',{role:'toolResult',toolCallId:'tool-'+i,content:[{type:'text',text:'x'.repeat(10000)},{type:'image',data:'DO_NOT_RETURN'}],details:{ok:true}});
  }
  add('message',{role:'assistant',content:[{type:'text',text:'First reply'}]});
  add('message',{role:'user',content:[{type:'text',text:'continue'}]});
  add('message',{role:'assistant',content:[{type:'toolCall',id:'second-tool',name:'bash',arguments:{command:'pwd'}},{type:'text',text:'Second reply'}]});
  add('message',{role:'toolResult',toolCallId:'second-tool',content:[{type:'text',text:'/project'}],isError:false});
  const directory=join(root,session.id);await mkdir(directory);
  const file=join(directory,'2026-11-07_owned-native.jsonl');
  const save=()=>writeFile(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await save();
  return {root,session,rows,file,directory,save};
}

test('owned native turns page beyond 16 tools and repeated prompts map by request order',async t=>{
  const f=await fixture(t),before=await readFile(f.file);
  const one=await readOmpTurn(f.root,f.session,'a1');assert.equal(one.totalTools,21);assert.equal(one.tools.length,16);assert.equal(one.hasMore,true);assert.equal(one.text,'First reply');assert.equal(one.tools[0].previewTruncated,true);
  const next=await readOmpTurn(f.root,f.session,'a1',{offset:one.nextOffset});assert.equal(next.tools.length,5);assert.equal(next.tools[0].id,'tool-16');assert.equal(next.hasMore,false);
  const two=await readOmpTurn(f.root,f.session,'a2');assert.equal(two.totalTools,1);assert.equal(two.tools[0].id,'second-tool');assert.equal(two.text,'Second reply');
  const detail=await readOmpTurn(f.root,f.session,'a1',{toolId:'tool-0'});assert.equal(detail.tool.result.content[0].text.length,10000);assert.equal(detail.tool.previewTruncated,false);
  assert.ok(!JSON.stringify([one,two,detail]).includes('DO_NOT_RETURN'));
  assert.deepEqual(await readFile(f.file),before,'history lookups never modify the CLI file');
});

test('history lookup rejects foreign identities, messages, branches and unsafe paths',async t=>{
  const f=await fixture(t);
  await assert.rejects(readOmpTurn(f.root,{...f.session,id:'../outside'},'a1'));
  await assert.rejects(readOmpTurn(f.root,{...f.session,cwd:'/other'},'a1'),/identity or project/);
  await assert.rejects(readOmpTurn(f.root,{...f.session,machineId:'remote'},'a1'),/local OMP/);
  await assert.rejects(readOmpTurn(f.root,f.session,'unknown'));
  await assert.rejects(readOmpTurn(f.root,f.session,'a1',{limit:1000}));
  await assert.rejects(readOmpTurn(f.root,f.session,'a1',{toolId:'second-tool'}),/not part/);
  const altered=structuredClone(f.session);altered.requests[0].textHash=hash('different');await assert.rejects(readOmpTurn(f.root,altered,'a1'),/cannot be matched safely/);
  f.rows.at(-1).parentId='missing';await f.save();await assert.rejects(readOmpTurn(f.root,f.session,'a1'),/parent chain/);
});

test('incomplete trailing writes are tolerated, file and directory symlinks are refused',async t=>{
  const f=await fixture(t);await writeFile(f.file,(await readFile(f.file,'utf8'))+'{"type":"message"');
  assert.equal((await readOmpTurn(f.root,f.session,'a1')).totalTools,21);
  const outside=join(f.root,'outside.jsonl');await writeFile(outside,await readFile(f.file));await rm(f.file);await symlink(outside,f.file);
  await assert.rejects(readOmpTurn(f.root,f.session,'a1'),/uniquely/);
  await rm(f.directory,{recursive:true});await symlink(f.root,f.directory);await assert.rejects(readOmpTurn(f.root,f.session,'a1'),/symlink/);
});
