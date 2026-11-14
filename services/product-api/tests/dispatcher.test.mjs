import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {registerWorker} from '../src/workers.mjs';
import {appendEvent} from '../src/app.mjs';
import {createDispatcher,createSimulationEngine} from '../src/dispatcher.mjs';
function seed(db){
 db.exec("INSERT INTO tenants VALUES ('ten_sim','simulation','2026-01-01'); INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES('prj_sim','ten_sim','simulation','ws','2026-01-01','2026-01-01')");
 registerWorker(db,{workerId:'wrk_sim',tenantId:'ten_sim',secret:'simulation-test-worker-secret-32-chars'});
}
function enqueue(db,id='op_sim'){
 const at=new Date().toISOString();
 db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at) VALUES(?,'ten_sim','prj_sim','send_message',?,?,'queued',?,?)").run(id,'request_'+id,'hash_'+id,at,at);
 db.prepare("INSERT INTO operation_outbox(operation_id,event,next_at,created_at) VALUES(?,'dispatch',?,?)").run(id,at,at);
 appendEvent(db,{tenantId:'ten_sim',projectId:'prj_sim',operationId:id,type:'message_created',payload:{text:'请做一个预约产品'}});
}
const state=db=>db.prepare("SELECT state FROM operations WHERE id='op_sim'").get().state;
const replies=db=>db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type='message_completed'").get().n;
test('simulation is explicit and repeated ticks produce one durable reply',async()=>{
 const db=openDatabase(':memory:');try{
 seed(db);enqueue(db);db.exec("INSERT INTO operation_outbox(operation_id,event,next_at,created_at) SELECT operation_id,event,next_at,created_at FROM operation_outbox");assert.throws(()=>createDispatcher({db}));
 const dispatcher=createDispatcher({db,enabled:true});
 assert.equal(await dispatcher.tick(),true);assert.equal(state(db),'completed');
 assert.equal(await dispatcher.tick(),false);dispatcher.recover();
 assert.equal(replies(db),1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM simulation_receipts').get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get().n,0);
 assert.match(db.prepare("SELECT payload_json FROM project_events WHERE type='message_completed'").get().payload_json,/模拟执行/);
 }finally{db.close();}
});
test('two dispatchers do not execute a worker or operation concurrently',async()=>{
 const db=openDatabase(':memory:');try{
 seed(db);enqueue(db);enqueue(db,'op_second');
 let release;const gate=new Promise(r=>release=r);let calls=0;
 const mock=createSimulationEngine(db);const engine={async execute(job){calls++;await gate;return mock.execute(job);}};
 const one=createDispatcher({db,enabled:true,engine});const two=createDispatcher({db,enabled:true,engine});
 const first=one.tick();assert.equal(await two.tick(),false);assert.equal(calls,1);
 release();await first;assert.equal(state(db),'completed');
 await two.tick();assert.equal(calls,2);assert.equal(replies(db),2);
 }finally{db.close();}
});
test('a durable receipt survives a lost acknowledgement and database reopen',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dispatch-restart-'));const path=join(dir,'db.sqlite');let db=openDatabase(path);
 try{
 seed(db);enqueue(db);const mock=createSimulationEngine(db);
 const crash={async execute(job){await mock.execute(job);throw new Error('lost acknowledgement');}};
 await createDispatcher({db,enabled:true,engine:crash}).tick();assert.equal(state(db),'uncertain');assert.equal(replies(db),0);
 db.close();db=openDatabase(path);
 const restarted=createDispatcher({db,enabled:true});restarted.recover();restarted.recover();
 assert.equal(state(db),'completed');assert.equal(replies(db),1);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM simulation_receipts').get().n,1);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
test('unknown execution is quarantined without automatic re-execution',async()=>{
 const db=openDatabase(':memory:');try{
 seed(db);enqueue(db);enqueue(db,'op_second');let calls=0;
 const dispatcher=createDispatcher({db,enabled:true,engine:{async execute(){calls++;throw new Error('unknown');}}});
 await dispatcher.tick();assert.equal(state(db),'uncertain');
 db.exec("UPDATE worker_leases SET expires_at='2000-01-01'");
 dispatcher.recover();assert.equal(await dispatcher.tick(),false);assert.equal(calls,1);
 assert.equal(db.prepare("SELECT state FROM operations WHERE id='op_second'").get().state,'queued');assert.equal(replies(db),0);
 }finally{db.close();}
});
test('an expired lease cannot commit a late acknowledgement; receipt recovery is explicit evidence',async()=>{
 const db=openDatabase(':memory:');try{
 seed(db);enqueue(db);const mock=createSimulationEngine(db);
 const engine={async execute(job){const result=await mock.execute(job);db.exec("UPDATE worker_leases SET expires_at='2000-01-01'");return result;}};
 const dispatcher=createDispatcher({db,enabled:true,engine});await dispatcher.tick();
 assert.equal(state(db),'uncertain');assert.equal(replies(db),0);
 dispatcher.recover();assert.equal(state(db),'completed');assert.equal(replies(db),1);
 }finally{db.close();}
});
test('an expired lease blocks simulated effects and the next job is not silently retried',async()=>{
 const db=openDatabase(':memory:');try{
 seed(db);enqueue(db);const mock=createSimulationEngine(db);
 const engine={async execute(job){db.exec("UPDATE worker_leases SET expires_at='2000-01-01'");return mock.execute(job);}};
 await createDispatcher({db,enabled:true,engine}).tick();
 assert.equal(state(db),'uncertain');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM simulation_receipts').get().n,0);
 }finally{db.close();}
});
