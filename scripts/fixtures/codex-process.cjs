// Deterministic app-server process for the installed-package test. No network/auth.
if (process.argv.includes('--version')) { console.log('codex-cli 0.167.0'); process.exit(0); }
const readline = require('node:readline');
let threadId = 'owned-test-thread', turn = 0, pending;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const f = JSON.parse(line), reply = result => send({id:f.id,result});
  const notify = (method, params) => send({method,params:{threadId,turnId:`turn-${turn}`,...params}});
  if (f.method === 'initialize') reply({userAgent:'codex/0.167.0'});
  if (f.method === 'config/read') reply({config:{model:'test-model',model_reasoning_effort:'low',approval_policy:'on-request',sandbox_mode:'read-only'}});
  if (f.method === 'model/list') reply({data:[{id:'test-model',model:'test-model',displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]});
  if (['thread/start','thread/resume'].includes(f.method)) { threadId=f.params.threadId||threadId;reply({thread:{id:threadId,cwd:process.cwd()},model:f.params.model||'test-model',reasoningEffort:'low',approvalPolicy:'on-request',sandbox:{type:'readOnly'}}); }
  if (f.method === 'turn/start') {
    turn++;reply({turn:{id:`turn-${turn}`,status:'inProgress'}});
    if (f.params.input[0].text.includes('WAIT')) return;
    if (f.params.input[0].text.includes('APPROVAL')) { pending=true;send({id:900,method:'item/commandExecution/requestApproval',params:{threadId,turnId:`turn-${turn}`,itemId:'cmd',command:'pwd'}});return; }
    notify('item/started',{item:{type:'commandExecution',id:'cmd',command:'pwd',cwd:process.cwd()}});
    notify('item/completed',{item:{type:'commandExecution',id:'cmd',command:'pwd',status:'completed',aggregatedOutput:process.cwd(),exitCode:0}});
    notify('item/agentMessage/delta',{itemId:'reply',delta:'PACKAGED_OK'});
    notify('item/completed',{item:{type:'agentMessage',id:'reply',text:'PACKAGED_OK'}});
    notify('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}});
  }
  if (f.id === 900 && pending) { pending=false;notify('item/completed',{item:{type:'agentMessage',id:'approved',text:`DECISION_${f.result.decision}`}});notify('turn/completed',{turn:{id:`turn-${turn}`,status:'completed'}}); }
  if (f.method === 'turn/interrupt') reply({});
});
