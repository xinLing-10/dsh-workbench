import {signToken,bodyDigest} from '../../../packages/manager-contracts/tokens.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomBytes,createHash} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';import {createApp,appendEvent} from '../src/app.mjs';import {createTenant,createInvite} from '../src/auth.mjs';import {registerWorker} from '../src/workers.mjs';
import {createWorkerCoordinator,executionFor,executionJob,executionClaims,acceptWorkerEvent} from '../src/worker-executions.mjs';import {createWorkerTransport} from '../src/worker-transport.mjs';
import {createWorkerRunner} from '../../worker-bridge/lib/runner.mjs';import {createWorkerServer} from '../../worker-bridge/lib/server.mjs';import {createProductClient} from '../../worker-bridge/lib/client.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<150;n++){const result=await fn();if(result)return result;await delay(20);}throw Error('Timed out');}
async function fixture(t,execute){
 const directory=await mkdtemp(join(tmpdir(),'unified-worker-')),db=openDatabase(join(directory,'product.sqlite')),tenant=createTenant(db),workerId='wrk_unified_test',secret=randomBytes(32).toString('hex');registerWorker(db,{workerId,tenantId:tenant.id,secret});
 const config={simulate:false,publicOrigin:'',cookieSecure:false,allowRedeem:true,maxBodyBytes:65536,sessionTtlMs:60000,inviteTtlMs:60000,workspaceRoot:join(directory,'workspaces')};await mkdir(config.workspaceRoot);
 let coordinator;const bridge={capabilities:()=>coordinator?.capabilities() || {},cancel:body=>coordinator.cancel(body),recoverOperation:body=>coordinator.recoverOperation(body)};
 const app=createApp({db,config,bridge});const apiServer=createServer((req,res)=>void app.handle(req,res));await new Promise(r=>apiServer.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+apiServer.address().port;config.publicOrigin=base;
 const runner=createWorkerRunner({directory:join(directory,'journal'),workerId,tenantId:tenant.id,productApiUrl:base,secret,heartbeatMs:500,execute:body=>execute({...body,workspaceRoot:config.workspaceRoot})});
 const workerServer=createWorkerServer({runner,workerId,secret,nonceDirectory:join(directory,'nonces')});await new Promise(r=>workerServer.listen(0,'127.0.0.1',r));
 const transport=createWorkerTransport({url:'http://127.0.0.1:'+workerServer.address().port,workerId,secret});coordinator=createWorkerCoordinator({db,workerId,transport,append:appendEvent,publish:app.publish});
 let cookie='',csrf='';async function api(method,path,body,{anonymous=false,noCsrf=false}={}){const response=await fetch(base+'/api/v1'+path,{method,headers:{...(cookie&&!anonymous?{cookie}:{}),...(!noCsrf?{'x-csrf-token':csrf}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,...await response.json()};}
 const invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});assert.equal((await api('POST','/invitations/redeem',{token:invite.token,email:'worker@example.test',password:'Synthetic-2026!'})).status,201);csrf=(await api('GET','/me')).data.csrfToken;
 const project=(await api('POST','/projects',{name:'统一协议离线夹具'})).data.project;await mkdir(join(config.workspaceRoot,project.id));
 const path='/projects/'+project.id;
 async function queue(text='虚构任务'){const response=await api('POST',path+'/messages',{text,requestId:'req_'+randomBytes(8).toString('hex')});assert.equal(response.status,202);return response.data.operation.id;}
 t.after(async()=>{await runner.close();workerServer.closeAllConnections();apiServer.closeAllConnections();await Promise.all([new Promise(r=>workerServer.close(r)),new Promise(r=>apiServer.close(r))]);app.managerCore.dispose();db.close();await rm(directory,{recursive:true,force:true});});
 return {db,app,runner,transport,workerUrl:'http://127.0.0.1:'+workerServer.address().port,get coordinator(){return coordinator;},set coordinator(c){coordinator=c;},workerId,tenantId:tenant.id,secret,api,queue,path,project,config,directory};
}
test('one signed chain dispatches, asks, denies approval, registers bytes and completes with ordered receipts',async t=>{
 let invocations=0;
 const f=await fixture(t,async({job,client,workspaceRoot})=>{
  invocations++;
  const q={kind:'question',prompt:'给谁用？',questions:[{id:'audience',question:'给谁用？',options:[{label:'自己'},{label:'朋友'}],multiSelect:false}]};
  const first=await client.createInteraction(q),replay=await client.createInteraction(q);assert.equal(first.id,replay.id);
  await client.waitAnswer(first.id,{pollMs:100,deadlineMs:3000});
  const permission=await client.createInteraction({kind:'permission',prompt:'允许测试便笺吗？',scope:'manager_test_note'});
  const answer=await client.waitAnswer(permission.id,{pollMs:100,deadlineMs:3000});assert.equal(answer.answer,'deny');
  const bytes=Buffer.from('# 离线夹具成果\n没有执行受拒绝的便笺工具。');await writeFile(join(workspaceRoot,job.projectId,'result.md'),bytes);
  return {status:'completed',reason:{kind:'completed'},text:'离线夹具完成；工具已拒绝。',artifacts:[{relativePath:'result.md',sha256:createHash('sha256').update(bytes).digest('hex')}]};
 });
 const id=await f.queue();await f.coordinator.tick();
 let pending=await until(()=>f.db.prepare("SELECT * FROM interaction_requests WHERE operation_id=? AND state='pending'").get(id));assert.equal(executionFor(f.db,id).state,'waiting');
 assert.equal((await f.api('POST',f.path+'/interactions/'+pending.id+'/respond',{answer:{answers:[{id:'audience',selected:['自己']}]}})).status,200);
 pending=await until(()=>f.db.prepare("SELECT * FROM interaction_requests WHERE operation_id=? AND kind='permission' AND state='pending'").get(id));assert.equal((await f.api('POST',f.path+'/interactions/'+pending.id+'/respond',{answer:'deny'})).status,200);
 await until(()=>executionFor(f.db,id).state==='completed');assert.equal(invocations,1);assert.equal(f.db.prepare('SELECT count(*) n FROM worker_execution_artifacts WHERE operation_id=?').get(id).n,1);
 const publicView=await f.api('GET',f.path+'/operations/'+id+'/execution');assert.equal(publicView.data.execution.engineAcknowledged,true);assert(!JSON.stringify(publicView).includes(f.secret));
 await f.transport.dispatch(executionJob(f.db,executionFor(f.db,id)));assert.equal(invocations,1);await f.coordinator.tick();assert.equal(invocations,1);
});
test('stop requires actual engine abortion and retires waiting cards without implicit approval',async t=>{
 const f=await fixture(t,async({client,onControl})=>{const abort=new AbortController();onControl({cancel:()=>abort.abort()});const q=await client.createInteraction({kind:'permission',prompt:'是否允许工具？'});try{await client.waitAnswer(q.id,{signal:abort.signal,pollMs:100,deadlineMs:10000});}catch{}return {status:'cancelled',reason:{kind:'aborted'},text:''};});
 const id=await f.queue();await f.coordinator.tick();await until(()=>f.db.prepare("SELECT 1 FROM interaction_requests WHERE operation_id=? AND state='pending'").get(id));
 const stop=await f.api('POST',f.path+'/actions',{action:'cancel_operation',operationId:id,requestId:'stop-request-001'});assert.equal(stop.status,200);assert.equal(stop.data.engineAcknowledged,true);assert.equal(executionFor(f.db,id).state,'cancelled');assert.equal(f.db.prepare("SELECT count(*) n FROM interaction_requests WHERE operation_id=? AND state='pending'").get(id).n,0);
});
test('lost dispatch acknowledgement and controller restart reattach the same engine without another model dispatch',async t=>{
 let complete,calls=0;const f=await fixture(t,async()=>{calls++;await new Promise(r=>complete=r);return {status:'completed',reason:{kind:'completed'},text:'夹具'};});
 const lost={...f.transport,dispatch:async job=>{await f.transport.dispatch(job);throw Error('ack lost');}};
 f.coordinator=createWorkerCoordinator({db:f.db,workerId:f.workerId,transport:lost,append:appendEvent});const id=await f.queue();await f.coordinator.tick();assert.equal(executionFor(f.db,id).state,'uncertain');
 const resumed=createWorkerCoordinator({db:f.db,workerId:f.workerId,transport:f.transport,append:appendEvent});await resumed.recover();assert.equal(executionFor(f.db,id).state,'running');assert.equal(calls,1);complete();await until(()=>executionFor(f.db,id).state==='completed');await resumed.tick();assert.equal(calls,1);
});
test('expired lease and absent original engine stay uncertain, never replayed or approved',async t=>{
 let release;const f=await fixture(t,async()=>{await new Promise(r=>release=r);return {status:'uncertain'};});const id=await f.queue();await f.coordinator.tick();
 f.db.prepare("UPDATE worker_leases SET expires_at='2000-01-01' WHERE operation_id=?").run(id);await f.coordinator.recover();assert.equal(executionFor(f.db,id).state,'uncertain');
 const next=await f.queue('后续任务');await f.coordinator.tick();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(next).state,'queued');release();
});
test('event fences reject scope substitution, gaps, conflicting replay and unregistered completion artifacts',async t=>{
 let release;const f=await fixture(t,async()=>{await new Promise(r=>release=r);return {status:'uncertain'};});const id=await f.queue();await f.coordinator.tick();const run=executionFor(f.db,id),claims=executionClaims(run);
 const event={protocolVersion:1,engineId:run.engine_id,eventId:'evt_test_002',sequence:run.sequence+1,type:'completed',endReason:'completed',artifactIds:['art_missing']};
 assert.throws(()=>acceptWorkerEvent(f.db,claims,event,appendEvent));assert.throws(()=>acceptWorkerEvent(f.db,{...claims,projectId:'prj_other'},{...event,artifactIds:[]},appendEvent));assert.throws(()=>acceptWorkerEvent(f.db,claims,{...event,artifactIds:[],sequence:event.sequence+2},appendEvent));
 const actual=JSON.parse(f.db.prepare('SELECT payload_json FROM worker_execution_events WHERE operation_id=? AND sequence=1').get(id).payload_json);assert.equal(acceptWorkerEvent(f.db,claims,actual,appendEvent).replayed,true);assert.throws(()=>acceptWorkerEvent(f.db,claims,{...actual,text:'changed'},appendEvent));release();
});
test('observation and recovery enforce browser authentication, project ownership and CSRF',async t=>{
 const f=await fixture(t,async()=>({status:'completed',reason:{kind:'completed'},text:'夹具'}));const id=await f.queue();await f.coordinator.tick();await until(()=>executionFor(f.db,id).state==='completed');
 assert.equal((await f.api('GET',f.path+'/operations/'+id+'/execution',undefined,{anonymous:true})).status,401);
 assert.equal((await f.api('POST',f.path+'/operations/'+id+'/recover',{}, {noCsrf:true})).status,403);
 assert.equal((await f.api('GET','/projects/prj_other/operations/'+id+'/execution')).status,404);
});

test('private Worker RPC rejects unsigned, body-tampered and replayed control requests',async t=>{
 const f=await fixture(t,async()=>({status:'uncertain'}));
 const target='/worker/v1/handshake',body={workerId:f.workerId};
 const token=signToken({aud:'manager-worker',sub:'product-api',workerId:f.workerId,method:'POST',target,jti:'nonce_replay_test_001',body:bodyDigest(body)},f.secret,60);
 const call=(payload,auth)=>fetch(f.workerUrl+target,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+auth}:{})},body:JSON.stringify(payload)});
 assert.equal((await call(body)).status,403);assert.equal((await call({...body,workerId:'wrk_other'},token)).status,403);assert.equal((await call(body,token)).status,200);assert.equal((await call(body,token)).status,403);
 assert.throws(()=>createWorkerTransport({url:'http://remote.example',workerId:f.workerId,secret:f.secret}));
});
test('a Worker restart observes an unfinished journal as uncertain without recreating an engine',async t=>{
 let release;const f=await fixture(t,async()=>{await new Promise(r=>release=r);return {status:'uncertain'};});const id=await f.queue();await f.coordinator.tick();
 let restartedCalls=0;const restarted=createWorkerRunner({directory:join(f.directory,'journal'),workerId:f.workerId,tenantId:f.tenantId,productApiUrl:'http://127.0.0.1:1',secret:f.secret,execute:async()=>{restartedCalls++;return {status:'uncertain'};}});
 const job=executionJob(f.db,executionFor(f.db,id));assert.equal((await restarted.observe(job)).state,'uncertain');assert.equal((await restarted.dispatch(job)).state,'uncertain');assert.equal(restartedCalls,0);await restarted.close();release();
});

test('queued cancellation removes the outbox without pretending an engine was stopped',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {status:'uncertain'};});await f.coordinator.tick();const id=await f.queue();
 const result=await f.api('POST',f.path+'/actions',{action:'cancel_operation',operationId:id,requestId:'stop-queued-001'});assert.equal(result.status,200);assert.equal(result.data.notDispatched,true);assert.equal(result.data.engineAcknowledged,false);await f.coordinator.tick();assert.equal(calls,0);assert.equal(executionFor(f.db,id),undefined);
});
