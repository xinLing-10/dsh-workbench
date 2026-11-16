/** Explicitly authorized, one-call text-only smoke. No model tools or customer state. */
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
if(!process.argv.includes('--authorized-10k-2'))throw Error('Explicit authorization flag required');
const release=process.env.MANAGER_PROBE_RELEASE||'/srv/manager-trial/current';
const root=process.env.MANAGER_PROBE_ROOT||'/srv/manager-trial/private/next-stream-real-20261115';
await mkdir(root,{mode:0o700}); // exclusive: a rerun cannot replace the ledger
const load=p=>import(pathToFileURL(join(release,p)).href);
const {openDatabase}=await load('services/product-api/src/db.mjs');
const {createServiceBudget}=await load('services/product-api/src/service-budget.mjs');
const {setRunAuthorization}=await load('services/product-api/src/run-authorization.mjs');
const {createModelGateway}=await load('services/product-api/src/model-gateway.mjs');
const {createApp,appendEvent}=await load('services/product-api/src/app.mjs');
const {createSession}=await load('services/product-api/src/auth.mjs');
const {registerWorker}=await load('services/product-api/src/workers.mjs');
const {createWorkerCoordinator}=await load('services/product-api/src/worker-executions.mjs');
const {createWorkerTransport}=await load('services/product-api/src/worker-transport.mjs');
const {createWorkerRunner}=await load('services/worker-bridge/lib/runner.mjs');
const {createWorkerServer}=await load('services/worker-bridge/lib/server.mjs');
const {createDockerSandbox}=await load('services/worker-bridge/lib/isolation.mjs');
const {parseModelWire}=await load('services/worker-bridge/lib/isolated-runtime.mjs');
const db=openDatabase(join(root,'control.sqlite')),now=new Date().toISOString(),secret=randomBytes(32).toString('hex');
db.prepare('INSERT INTO tenants VALUES(?,?,?)').run('ten_stream','Fictional stream smoke',now);
db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run('usr_stream','ten_stream','stream@example.test','login-disabled','{}','active',now);
db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('ten_stream','usr_stream','owner',now);
db.prepare('INSERT INTO platform_admins VALUES(?,?)').run('usr_stream',now);
db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('prj_stream','ten_stream','Fictional model streaming','prj_stream',now,now);
const workspace=join(root,'workspaces');await mkdir(join(workspace,'prj_stream'),{recursive:true,mode:0o700});
setRunAuthorization(db,{id:'next-stream-20261115',tokenLimit:10000,maxRequests:2,carryoverCommitted:44892,aggregateLimit:200000});
const budget=createServiceBudget({db});
for(const [scope,scopeId]of [['global','*'],['user','usr_stream'],['project','prj_stream']])budget.policy('usr_stream',{scope,scopeId,limit:10000,window:'lifetime',revision:0,reason:'Explicit 10k / 2 call real streaming authorization'});
const env=await readFile('/srv/manager-trial/private/api.env','utf8');
const envValue=name=>{const v=env.split('\n').find(x=>x.startsWith(name+'='))?.slice(name.length+1).trim();return v?.replace(/^["']|["']$/g,'');};
const credential=envValue('PRODUCT_API_MODEL_CREDENTIAL_FILE'),model=envValue('PRODUCT_API_MODEL');if(!credential||!model)throw Error('Existing credential configuration missing');
assert.equal((await stat(credential)).mode&0o077,0);
const gateway=createModelGateway({budget,model,resolveToken:async()=>(await readFile(credential,'utf8')).trim(),attribution:envValue('PRODUCT_API_MODEL_USER_AGENT')?{'user-agent':envValue('PRODUCT_API_MODEL_USER_AGENT')}:{}});
const workerConfig=JSON.parse(await readFile('/srv/manager-trial/private/worker.json','utf8'));
const sandbox=createDockerSandbox({...workerConfig.isolation,workspaceRoot:workspace});
const isolation=await sandbox.check();
let coordinator,runner,workerServer,apiServer,abortEvents,readEvents,terminal=false;
const observations=[],start=Date.now();let firstPreviewAt,finalAt,previews=0,completedEvents=0;
const config={formalService:true,workerProtocol:true,maxBodyBytes:65536,workspaceRoot:workspace};
const app=createApp({db,config,bridge:{capabilities:()=>coordinator?.capabilities()||{}},modelGateway:gateway});
const report={authorization:{tokenLimit:10000,maxRequests:2,carryoverCommitted:44892,aggregateLimit:200000},toolsExecuted:0,source:'real-provider',textOnly:true};
const save=async()=>{const rows=db.prepare('SELECT id,state,actual,reservation FROM service_model_calls ORDER BY created_at').all();Object.assign(report,{requests:rows.length,used:rows.filter(x=>x.state==='settled').reduce((n,x)=>n+x.actual,0),held:rows.filter(x=>x.state!=='settled').reduce((n,x)=>n+Math.max(x.reservation,x.actual||0),0),unknown:rows.filter(x=>x.state==='unknown').length,at:new Date().toISOString()});await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});};
try{
 apiServer=createServer((q,r)=>void app.handle(q,r));await new Promise(r=>apiServer.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+apiServer.address().port;config.publicOrigin=base;
 registerWorker(db,{workerId:'wrk_stream',tenantId:'ten_stream',secret});
 runner=createWorkerRunner({directory:join(root,'journal'),workerId:'wrk_stream',tenantId:'ten_stream',productApiUrl:base,secret,isolation,isolationCheck:()=>sandbox.check(),
 execute:async({job,client,onControl})=>{
  const controller=new AbortController();onControl({cancel:()=>controller.abort()});
  const reply=await client.modelMessage({id:'call_next_stream_20261115',body:{model,max_tokens:768,stream:true,thinking:{type:'disabled'},messages:[{role:'user',content:job.text}]}},{signal:controller.signal});
  if(reply.record.status!=='completed')return {status:'uncertain'};
  const text=parseModelWire(reply.wire).content.filter(x=>x.type==='text').map(x=>x.text).join('\n\n'),bytes=Buffer.from(text);
  const relativePath='streaming-principles.md';await writeFile(join(workspace,job.projectId,relativePath),bytes,{flag:'wx',mode:0o600});
  return {status:'completed',reason:{kind:'completed'},text,artifacts:[{relativePath,sha256:createHash('sha256').update(bytes).digest('hex')}]};
 }});
 workerServer=createWorkerServer({runner,workerId:'wrk_stream',secret,nonceDirectory:join(root,'nonces')});await new Promise(r=>workerServer.listen(0,'127.0.0.1',r));
 coordinator=createWorkerCoordinator({db,workerId:'wrk_stream',transport:createWorkerTransport({url:'http://127.0.0.1:'+workerServer.address().port,workerId:'wrk_stream',secret}),budget,requireIsolation:true,append:appendEvent,publish:app.publish});
 const session=createSession(db,{userId:'usr_stream',tenantId:'ten_stream',ttlMs:600000}),headers={cookie:'pm_session='+session.sessionId,'x-csrf-token':session.csrfToken,'content-type':'application/json'};
 abortEvents=new AbortController();const response=await fetch(base+'/api/v1/projects/prj_stream/events',{headers,signal:abortEvents.signal});
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
 readEvents=(async()=>{try{for(;;){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});for(;;){const i=pending.indexOf('\n\n');if(i<0)break;const frame=pending.slice(0,i);pending=pending.slice(i+2);const data=frame.split('\n').find(x=>x.startsWith('data: '));if(!data)continue;const event=JSON.parse(data.slice(6));if(event.type==='message_stream'){assert.equal(event.operationId,operationId);assert.equal(typeof event.payload.text,'string');previews++;firstPreviewAt??=Date.now();observations.push({id:event.id,length:event.payload.text.length});}if(event.type==='message_completed'){completedEvents++;finalAt=Date.now();}}}}catch(e){if(!abortEvents.signal.aborted)throw e;}})();
 const sent=await fetch(base+'/api/v1/projects/prj_stream/messages',{method:'POST',headers,body:JSON.stringify({requestId:'next_stream_one_call',text:'这是虚构的待办清单学习项目。请用约二百字、分六个短段，解释用户点击保存后，页面、服务端和数据库怎样协作。每段用一句话。只提供原理讲解，不声称修改软件。不使用工具、不提问、不执行命令。'})});assert.ok(sent.ok);
 const operationId=(await sent.json()).data.operation.id;assert.equal(await coordinator.tick(),true);
 const deadline=Date.now()+130000;
 while(Date.now()<deadline){await coordinator.tick();const run=db.prepare('SELECT state FROM worker_executions WHERE operation_id=?').get(operationId);if(['completed','failed','uncertain','cancelled'].includes(run?.state)){assert.equal(run.state,'completed');terminal=true;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(terminal,'Worker did not produce a terminal receipt');
 // Let the already flushed SSE response reach its independent reader.
 for(let n=0;n<30&&!completedEvents;n++)await new Promise(r=>setTimeout(r,20));
 assert.ok(previews>0);assert.equal(completedEvents,1);assert.ok(firstPreviewAt<finalAt,'Preview must arrive before final delivery');
 const artifact=db.prepare('SELECT * FROM artifact_index WHERE project_id=?').get('prj_stream');assert.ok(artifact);
 const bytes=await readFile(join(workspace,'prj_stream','streaming-principles.md'));assert.equal(createHash('sha256').update(bytes).digest('hex'),artifact.sha256);
 Object.assign(report,{passed:true,previews,completedEvents,firstPreviewMs:firstPreviewAt-start,finalMs:finalAt-start,artifact:{bytes:bytes.length,sha256:artifact.sha256},orderedEventIds:observations.every((x,i)=>i===0||x.id>observations[i-1].id)});
}catch(error){Object.assign(report,{passed:false,error:error.message});process.exitCode=1;}
finally{
 abortEvents?.abort();await readEvents?.catch(()=>{});await runner?.close();await sandbox.close();
 apiServer?.closeAllConnections();workerServer?.closeAllConnections();await Promise.all([apiServer&&new Promise(r=>apiServer.close(r)),workerServer&&new Promise(r=>workerServer.close(r))]);
 app.managerCore.dispose();await save();db.close();console.log(JSON.stringify(report));
}
