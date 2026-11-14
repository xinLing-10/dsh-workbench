import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {createBridge} from '../src/bridge.mjs';
import {createTenant,createInvite} from '../src/auth.mjs';
import {registerWorker} from '../src/workers.mjs';
import {createDispatcher} from '../src/dispatcher.mjs';
import {createSimulationFlow} from '../src/simulation-flow.mjs';
async function fixture(){
 const db=openDatabase(':memory:');const config={simulate:true,simulationFlow:true,allowRedeem:true,maxBodyBytes:65536,sessionTtlMs:60000};
 const app=createApp({db,config,bridge:createBridge({config})});const server=createServer((req,res)=>app.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='';
 async function call(method,path,body){const r=await fetch(base+path,{method,headers:{'content-type':'application/json',cookie,'x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data,text};}
 const tenant=createTenant(db);const invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});
 await call('POST','/api/v1/invitations/redeem',{token:invite.token,email:'flow@example.com',password:'fictional-password'});
 csrf=(await call('GET','/api/v1/me')).data.data.csrfToken;
 const project=(await call('POST','/api/v1/projects',{name:'模拟需求交付'})).data.data.project;
 registerWorker(db,{workerId:'wrk_flow',tenantId:tenant.id,secret:'fictional-flow-worker-secret-32-chars'});
 const prefix='/api/v1/projects/'+project.id;
 const send=async()=>{const response=await call('POST',prefix+'/messages',{text:'帮理发店减少电话预约',requestId:randomUUID()});assert.equal(response.status,202);return response.data.data.operation.id;};
 const pending=async()=>(await call('GET',prefix+'/interactions')).data.data.interactions;
 const answer=(id,answer)=>call('POST',prefix+'/interactions/'+id+'/respond',{answer});
 const cancel=id=>call('POST',prefix+'/actions',{action:'cancel_operation',operationId:id,requestId:randomUUID()});
 return {db,app,call,send,pending,answer,cancel,prefix,project,dispatcher:createDispatcher({db,enabled:true,interactive:true,publish:app.publish}),close:async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}};
}
const answers={answers:[{id:'audience',selected:[],custom:'第一次使用电脑的理发店店主'},{id:'delivery',selected:['示例需求说明']}]};
async function reachQuestion(f){await f.dispatcher.tick();let card=(await f.pending())[0];assert.equal(card.kind,'permission');assert.equal((await f.answer(card.id,'allow')).status,200);await f.dispatcher.tick();card=(await f.pending())[0];assert.equal(card.kind,'question');return card;}
test('approval, structured answers, reading, hash confirmation and download form a complete simulation',async()=>{
 const f=await fixture();try{
 const id=await f.send();await f.dispatcher.tick();await f.dispatcher.tick();assert.equal((await f.pending()).length,1);
 const permission=(await f.pending())[0];await f.answer(permission.id,'allow');
 // Switching runtime flags cannot turn a persisted interactive operation into an automatic echo.
 f.dispatcher=createDispatcher({db:f.db,enabled:true,interactive:false,publish:f.app.publish});await f.dispatcher.tick();
 const question=(await f.pending())[0];assert.equal(question.questions.length,2);
 assert.equal((await f.answer(question.id,answers)).status,200);await f.dispatcher.tick();
 assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'completed');
 const list=(await f.call('GET',f.prefix+'/artifacts')).data.data.artifacts;assert.equal(list.length,1);assert.equal(list[0].confirmed,false);
 const path=f.prefix+'/artifacts/'+list[0].id;
 const read=await f.call('GET',path);assert.match(read.data.data.text,/模拟交付示例/);assert.match(read.data.data.text,/理发店店主/);
 const download=await f.call('GET',path+'/download');assert.equal(download.status,200);assert.equal(download.text,read.data.data.text);
 const hash=createHash('sha256').update(download.text).digest('hex');
 assert.equal((await f.call('POST',path+'/confirm',{hash:'wrong'})).status,409);
 assert.equal((await f.call('POST',path+'/confirm',{hash})).status,200);
 await f.dispatcher.tick();f.dispatcher.recover();assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM simulation_documents').get().n,1);
 assert.equal((await f.cancel(id)).status,409);
 }finally{await f.close();}
});
test('denying permission stops without a question or generated artifact',async()=>{
 const f=await fixture();try{const id=await f.send();await f.dispatcher.tick();await f.answer((await f.pending())[0].id,'deny');await f.dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'cancelled');assert.equal((await f.pending()).length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifact_index').get().n,0);}finally{await f.close();}
});
for(const phase of ['queued','permission','question'])test('cancelling at '+phase+' removes cards and blocks late answers',async()=>{
 const f=await fixture();try{
 const id=await f.send();if(phase==='permission')await f.dispatcher.tick();if(phase==='question')await reachQuestion(f);
 const cards=await f.pending();assert.equal((await f.cancel(id)).status,200);assert.equal((await f.cancel(id)).status,200);
 await f.dispatcher.tick();assert.equal((await f.pending()).length,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifact_index').get().n,0);
 if(cards[0])assert.equal((await f.answer(cards[0].id,'allow')).status,404);
 assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'cancelled');
 }finally{await f.close();}
});
test('expired waiting lease becomes uncertain and cannot generate an artifact',async()=>{
 const f=await fixture();try{const id=await f.send();await f.dispatcher.tick();const card=(await f.pending())[0];f.db.exec("UPDATE worker_leases SET expires_at='2000-01-01'");await f.dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'uncertain');assert.equal((await f.pending()).length,0);assert.equal((await f.answer(card.id,'allow')).status,404);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifact_index').get().n,0);}finally{await f.close();}
});
test('lost completion acknowledgement recovers one artifact without confirming it',async()=>{
 const f=await fixture();try{
 const id=await f.send();const question=await reachQuestion(f);await f.answer(question.id,answers);
 const flow=createSimulationFlow(f.db,f.app.publish);
 f.dispatcher=createDispatcher({db:f.db,enabled:true,engine:{async execute(job){await flow.execute(job);throw new Error('lost completion');}}});
 await f.dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'uncertain');
 f.dispatcher=createDispatcher({db:f.db,enabled:true,interactive:false});f.dispatcher.recover();f.dispatcher.recover();
 assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'completed');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM simulation_documents').get().n,1);assert.equal(f.db.prepare('SELECT confirmed FROM artifact_index').get().confirmed,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type='message_completed'").get().n,1);
 }finally{await f.close();}
});


test('accepted interactive intent survives disabling the runtime flow flag before dispatch',async()=>{
 const f=await fixture();try{await f.send();const restarted=createDispatcher({db:f.db,enabled:true,interactive:false});await restarted.tick();assert.equal((await f.pending())[0].kind,'permission');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM simulation_receipts').get().n,0);}finally{await f.close();}
});

test('database reopen restores the same question after a lost waiting acknowledgement',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const dir=await mkdtemp(join(tmpdir(),'flow-reopen-'));const f=await fixture();let copy;
 try{
 const id=await f.send();const question=await reachQuestion(f);
 f.db.prepare("UPDATE operations SET state='running' WHERE id=?").run(id); // Fault injection after question commit.
 const path=join(dir,'restored.sqlite');f.db.prepare('VACUUM INTO ?').run(path);
 copy=openDatabase(path);const restarted=createDispatcher({db:copy,enabled:true,interactive:false});await restarted.tick();
 assert.equal(copy.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'waiting');
 assert.equal(copy.prepare('SELECT question_id FROM simulation_flows WHERE operation_id=?').get(id).question_id,question.id);
 assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM interaction_requests').get().n,2);
 assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM artifact_index').get().n,0);
 }finally{copy?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});

test('cancellation between resume and document generation cannot be resurrected by an error',async()=>{
 const f=await fixture();try{
 const id=await f.send();const question=await reachQuestion(f);await f.answer(question.id,answers);
 const flow=createSimulationFlow(f.db,f.app.publish);
 const dispatcher=createDispatcher({db:f.db,enabled:true,engine:{async execute(job){assert.equal((await f.cancel(id)).status,200);return flow.execute(job);}}});
 await dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'cancelled');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM artifact_index').get().n,0);
 dispatcher.recover();assert.equal(f.db.prepare('SELECT state FROM operations WHERE id=?').get(id).state,'cancelled');
 }finally{await f.close();}
});

test('project status prioritizes the waiting task over later queued messages',async()=>{
 const f=await fixture();try{const first=await f.send();await f.dispatcher.tick();await f.send();const detail=(await f.call('GET',f.prefix)).data.data;assert.equal(detail.operations[0].id,first);assert.equal(detail.operations[0].state,'waiting');}finally{await f.close();}
});
