/** Unified signed HTTP + actual DSH engine; fixture and paid evidence kept separate. */
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,open} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {fileURLToPath} from 'node:url';import {randomBytes,createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.mjs';import {createApp,appendEvent} from '../src/app.mjs';import {createTenant,createInvite} from '../src/auth.mjs';import {registerWorker} from '../src/workers.mjs';import {createWorkerCoordinator,executionFor,executionJob} from '../src/worker-executions.mjs';import {createWorkerTransport} from '../src/worker-transport.mjs';import {createWorkerRunner} from '../../worker-bridge/lib/runner.mjs';import {createWorkerServer} from '../../worker-bridge/lib/server.mjs';import {executeNativeInteraction} from '../src/native-tools.mjs';import {openBudget} from '../src/model-budget.mjs';import {currentAccount} from '../src/current-deepseek-account.mjs';
if(!process.argv.includes('--fixture') && !process.argv.includes('--authorized-real'))throw Error('Choose --fixture or --authorized-real');
const fixture=process.argv.includes('--fixture'),serve=process.argv.includes('--serve');
const root=fileURLToPath(new URL('../../../',import.meta.url)),control=join(root,'services/product-api/control-data'),oldDirectory=join(control,'authorized-20261114-200k');
function oldSnapshot(){const db=new DatabaseSync(join(oldDirectory,'budget.sqlite'),{readOnly:true});try{const a=db.prepare('SELECT * FROM authorization WHERE id=1').get(),calls=db.prepare('SELECT status,actual,reservation FROM calls').all();return {limit:a.token_limit,used:a.initial_used+calls.reduce((n,c)=>n+(c.status==='settled'?c.actual:0),0),held:calls.reduce((n,c)=>n+(c.status==='settled'?0:Math.max(c.reservation,c.actual || 0)),0),requests:calls.length,unknown:calls.filter(c=>c.status!=='settled').length};}finally{db.close();}}
const oldBefore=oldSnapshot();
const directory=fixture?await mkdtemp(join(control,'unified-worker-fixture-')):join(control,'authorized-20261114-worker-v1');await mkdir(directory,{recursive:true,mode:0o700});
const lock=await open(join(directory,'attempt.lock'),'wx',0o600);await lock.close();
if(!fixture && (oldBefore.limit!==200000 || oldBefore.used+oldBefore.held+50000>200000))throw Error('Aggregate authorization needs review');
const authorization={scope:fixture?'offline-native-fixture':'unified-worker-real',tokenLimit:50000,maxRequests:8,aggregateLimit:200000,carryover:oldBefore,syntheticOnly:true,automaticToolApproval:false,authorizedAt:'2026-11-14',note:'User explicitly authorized new bounded verification while retaining previous unknown hold.'};
await writeFile(join(directory,'authorization.json'),JSON.stringify(authorization,null,2),{mode:0o600});
const ledger=openBudget(join(directory,'budget.sqlite'),{limit:50000,initialUsed:0,maxRequests:8});
const budget={snapshot:()=>ledger.snapshot(),settle:(...a)=>ledger.settle(...a),reserve:(...a)=>{if(!fixture){const old=oldSnapshot();if(old.used+old.held+50000>200000 || JSON.stringify(old)!==JSON.stringify(oldBefore))throw Error('Carryover changed; no model dispatch');}return ledger.reserve(...a);}};
const account=fixture?{model:'deepseek-flash',resolveToken:async()=>'fixture-only-token',attribution:{}}:await currentAccount();
const workspaceRoot=await mkdtemp(join(tmpdir(),'unified-worker-projects-'));const db=openDatabase(join(directory,'product.sqlite')),tenant=createTenant(db,{name:fixture?'离线原生夹具':'真实Worker协议验证'}),workerId='wrk_unified_owner',secret=randomBytes(32).toString('hex');registerWorker(db,{workerId,tenantId:tenant.id,secret});
let coordinator,paused=false;const bridge={capabilities:()=>coordinator?.capabilities() || {bridge:false},cancel:body=>coordinator.cancel(body),recoverOperation:body=>coordinator.recoverOperation(body)};
const config={simulate:false,publicOrigin:'',cookieSecure:false,allowRedeem:true,maxBodyBytes:65536,sessionTtlMs:86400000,inviteTtlMs:60000,workspaceRoot};const app=createApp({db,config,bridge});const server=createServer((req,res)=>void app.handle(req,res));await new Promise(r=>server.listen(serve?8093:0,'127.0.0.1',r));config.publicOrigin='http://localhost:'+server.address().port;
function fixtureFetch(job){return async(_url,init)=>{
 const body=JSON.parse(init.body),calls=body.messages.flatMap(m=>Array.isArray(m.content)?m.content.filter(b=>b.type==='tool_use'):[]),tool=calls.length===0?'ask_user_question':calls.length===1?'manager_test_note':null;
 const args=tool==='manager_test_note'?{}:{questions:[{id:'audience',question:'给谁看？',options:[{label:'自己'},{label:'朋友'}]},{id:'topics',question:'文章主题？',multi_select:true,options:[{label:'生活'},{label:'学习'}]}]};
 const events=[{type:'message_start',message:{id:'fixture-'+job.engineId+'-'+calls.length,model:account.model,role:'assistant',content:[],usage:{input_tokens:10,output_tokens:0}}}];
 if(tool)events.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:'call-'+calls.length,name:tool,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(args)}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:7}});
 else events.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'【离线夹具】博客给自己看，写生活与学习内容；便笺权限被拒绝，未执行便笺写入。'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}});
 events.push({type:'message_stop'});return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
};}
const nativeResults=new Map();let nativeStarts=0;
const runner=createWorkerRunner({directory:join(directory,'worker-journal'),workerId,tenantId:tenant.id,productApiUrl:config.publicOrigin,secret,execute:async({job,onControl})=>{
 nativeStarts++;
 const stoppedCase=job.text.includes('[STOP-CASE]');
 const result=await executeNativeInteraction({directory,callId:job.engineId,prompt:job.text,firstTool:'ask_user_question',interactionFlow:stoppedCase?'single':'question-then-approval',maxTokens:1024,budget,account,fetchImpl:fixture?fixtureFetch(job):globalThis.fetch,onControl,bridge:{productApiUrl:config.publicOrigin,workerId,workerSecret:secret,tenantId:tenant.id,projectId:job.projectId,operationId:job.operationId,leaseId:job.leaseId,generation:job.generation}});
 nativeResults.set(job.operationId,result);
 if(result.status==='completed'){
  const text='# '+(fixture?'离线原生夹具':'真实模型答疑')+'交付记录\n\n'+result.text+'\n\n此文档是模型答疑记录，不是代码实现、测试通过或用户确认。';const bytes=Buffer.from(text);await writeFile(join(workspaceRoot,job.projectId,'learning-report.md'),bytes,{mode:0o600});
  return {...result,artifacts:[{relativePath:'learning-report.md',sha256:createHash('sha256').update(bytes).digest('hex'),source:{callId:job.engineId,model:account.model}}]};
 }
 return result;
}});
const workerServer=createWorkerServer({runner,workerId,secret,nonceDirectory:join(directory,'worker-control-nonces')});await new Promise(r=>workerServer.listen(0,'127.0.0.1',r));
const transport=createWorkerTransport({url:'http://127.0.0.1:'+workerServer.address().port,workerId,secret});
const makeCoordinator=()=>createWorkerCoordinator({db,workerId,transport,append:appendEvent,publish:app.publish,paused:()=>paused || budget.snapshot().frozen});coordinator=makeCoordinator();
let cookie='',csrf='';async function api(method,path,body){const response=await fetch(config.publicOrigin+'/api/v1'+path,{method,headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,...await response.json()};}
const invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});const created=await api('POST','/invitations/redeem',{token:invite.token,email:'worker-real@local.test',password:'Worker-2026!'});if(created.status!==201)throw Error('Synthetic user setup failed');csrf=(await api('GET','/me')).data.csrfToken;
async function queue(name,text){const project=(await api('POST','/projects',{name})).data.project;await mkdir(join(workspaceRoot,project.id));const reply=await api('POST','/projects/'+project.id+'/messages',{text,requestId:'request-'+randomBytes(10).toString('hex')});if(reply.status!==202)throw Error('Queue failed');await coordinator.tick();return {projectId:project.id,operationId:reply.data.operation.id};}
async function pendingFor(job,kind){for(let n=0;n<600;n++){
 const row=db.prepare("SELECT * FROM interaction_requests WHERE operation_id=? AND kind=? AND state='pending'").get(job.operationId,kind);if(row)return row;
 if(nativeResults.has(job.operationId))throw Error('Native execution ended before '+kind);
 if(n%50===0)await coordinator.recover();await new Promise(r=>setTimeout(r,150));
}throw Error('Timed out waiting for '+kind);}
async function terminal(job){for(let n=0;n<600;n++){const run=executionFor(db,job.operationId);if(['completed','cancelled','failed','uncertain'].includes(run.state))return run;if(n%50===0)await coordinator.recover();await new Promise(r=>setTimeout(r,150));}throw Error('Missing engine receipt');}
const report={scope:authorization.scope,results:[],automaticToolApproval:false};
try{
 console.log(JSON.stringify({phase:'starting',scope:report.scope,url:config.publicOrigin,directory}));
 const job=await queue(fixture?'离线夹具 · 完整操作链':'真实模型 · 完整操作链','请先调用 ask_user_question 向我确认两题：博客给谁看，单选自己或朋友；文章主题，多选生活或学习。取得回答后，调用一次 manager_test_note 请求创建固定便笺。若权限被拒绝，明确说明没有写入便笺，并用简短中文总结博客定位、HTML/CSS/JavaScript的分工，然后直接结束。资料均为虚构，不读其他文件，不使用其他工具。');
 const question=await pendingFor(job,'question');const questions=JSON.parse(question.questions_json);
 const partial=await api('POST',`/projects/${job.projectId}/interactions/${question.id}/respond`,{answer:{answers:[]}});if(partial.status!==400)throw Error('Incomplete answers accepted');
 const count=budget.snapshot().requests;coordinator=makeCoordinator();await coordinator.recover();if(budget.snapshot().requests!==count || nativeStarts!==1)throw Error('Recovery invoked model again');
 const answer=await api('POST',`/projects/${job.projectId}/interactions/${question.id}/respond`,{answer:{answers:questions.map(q=>({id:q.id,selected:q.options.map(o=>o.label).slice(0,q.multiSelect?2:1)}))}});if(answer.status!==200)throw Error('Answer failed');
 console.log(JSON.stringify({phase:'question-answered',operationId:job.operationId,recoveryWithoutRedispatch:true}));
 const permission=await pendingFor(job,'permission');const denial=await api('POST',`/projects/${job.projectId}/interactions/${permission.id}/respond`,{answer:'deny'});if(denial.status!==200)throw Error('Denial failed');
 const run=await terminal(job),native=nativeResults.get(job.operationId);if(run.state!=='completed' || native?.reason?.kind!=='completed')throw Error('Native full chain did not complete');
 let noteWritten=false;try{await readFile(join(directory,'native-interactions',run.engine_id,'workspace/test-note.txt'));noteWritten=true;}catch{}
 if(noteWritten)throw Error('Rejected tool wrote a note');
 const artifacts=(await api('GET',`/projects/${job.projectId}/artifacts`)).data.artifacts;if(artifacts.length!==1)throw Error('Missing registered document');const artifact=artifacts[0];
 if((await api('POST',`/projects/${job.projectId}/artifacts/${artifact.id}/confirm`,{hash:artifact.sha256})).status!==200)throw Error('Document confirmation failed');
 const download=await fetch(config.publicOrigin+`/api/v1/projects/${job.projectId}/artifacts/${artifact.id}/download`,{headers:{cookie}});const downloaded=Buffer.from(await download.arrayBuffer());if(!download.ok || createHash('sha256').update(downloaded).digest('hex')!==artifact.sha256)throw Error('Document download mismatch');
 const beforeReplay=budget.snapshot().requests;await transport.dispatch(executionJob(db,run));if(budget.snapshot().requests!==beforeReplay || nativeStarts!==1)throw Error('Duplicate dispatch invoked model');
 report.results.push({case:'full-chain',status:'passed',...job,engineId:run.engine_id,recoveryWithoutRedispatch:true,permission:'denied',noteWritten,artifactId:artifact.id,sha256:artifact.sha256,downloadBytes:downloaded.length,modelCalls:native.records.length,nativeScope:native.scope,modelRecords:native.records.map(r=>({id:r.id,status:r.status,httpStatus:r.httpStatus,model:r.modelReturned,usage:r.usage,toolCalls:r.toolCalls}))});
 console.log(JSON.stringify({phase:'full-chain-passed',operationId:job.operationId,modelCalls:native.records.length}));
 if(budget.snapshot().frozen)throw Error('Budget needs review');
 const stop=await queue(fixture?'离线夹具 · 原生停止':'真实模型 · 原生停止','[STOP-CASE] 请调用 ask_user_question 问我是否继续本次虚构测试，单选继续或暂停，等用户回答，不要自行回答，也不要调用其他工具。');await pendingFor(stop,'question');
 const stopped=await api('POST',`/projects/${stop.projectId}/actions`,{action:'cancel_operation',operationId:stop.operationId,requestId:'request-stop-001'});const stoppedRun=await terminal(stop),stoppedNative=nativeResults.get(stop.operationId);
 if(stopped.status!==200 || stopped.data.engineAcknowledged!==true || stoppedRun.state!=='cancelled' || stoppedNative?.reason?.kind!=='aborted')throw Error('Missing actual native stop receipt');
 report.results.push({case:'native-stop',status:'passed',...stop,engineId:stoppedRun.engine_id,endReason:stoppedNative.reason,modelCalls:stoppedNative.records.length,nativeScope:stoppedNative.scope,modelRecords:stoppedNative.records.map(r=>({id:r.id,status:r.status,httpStatus:r.httpStatus,model:r.modelReturned,usage:r.usage}))});
}catch(error){report.error=String(error.message);report.status='failed';console.error(JSON.stringify({phase:'needs-review',message:report.error}));}
finally{
 paused=true;report.status ||= 'passed';report.budget=budget.snapshot();report.oldBefore=oldBefore;report.oldAfter=oldSnapshot();report.oldBudgetPreserved=JSON.stringify(report.oldBefore)===JSON.stringify(report.oldAfter);report.aggregateCommittedAndHeld=report.oldAfter.used+report.oldAfter.held+report.budget.used+report.budget.held;
 await writeFile(join(directory,'unified-worker-report.json'),JSON.stringify(report,null,2),{mode:0o600});await writeFile(join(directory,'run-context.json'),JSON.stringify({workspaceRoot,url:config.publicOrigin,directory,scope:report.scope}),{mode:0o600});
 console.log(JSON.stringify({phase:'finished',status:report.status,directory,url:config.publicOrigin,cases:report.results.map(r=>({case:r.case,status:r.status,modelCalls:r.modelCalls})),budget:{requests:report.budget.requests,used:report.budget.used,held:report.budget.held,frozen:report.budget.frozen},aggregateCommittedAndHeld:report.aggregateCommittedAndHeld,oldBudgetPreserved:report.oldBudgetPreserved}));
 if(!serve){await runner.close();workerServer.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise(r=>workerServer.close(r)),new Promise(r=>server.close(r))]);app.managerCore.dispose();db.close();ledger.close();if(report.status!=='passed')process.exitCode=1;}
 else{const close=async()=>{await runner.close();workerServer.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise(r=>workerServer.close(r)),new Promise(r=>server.close(r))]);app.managerCore.dispose();db.close();ledger.close();process.exit(0);};process.on('SIGTERM',close);process.on('SIGINT',close);}
}
