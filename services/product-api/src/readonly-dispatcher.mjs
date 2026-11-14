/** Explicit opt-in test runtime. Never uses simulation receipts or claims tool execution. */
import{appendEvent}from'./app.mjs';import{acquireLease,leaseIsActive}from'./workers.mjs';
export function createReadonlyDispatcher({db,workerId,tenantId,execute,publish=()=>{}}){
 if(!db.prepare("SELECT id FROM workers WHERE id=? AND tenant_id=? AND status='active'").get(workerId,tenantId))throw Error('Worker scope mismatch');
 db.exec("CREATE TABLE IF NOT EXISTS readonly_runs(operation_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, payload_hash TEXT NOT NULL, lease_id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, result_json TEXT)");let busy=false;
 const emit=event=>{try{publish(event);}catch{}};
 const claims=run=>({sub:workerId,tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,leaseId:run.lease_id,generation:run.generation});
 const finish=(run,result,uncertain=false)=>{db.exec('BEGIN IMMEDIATE');let event,status;const emitAfter=[];
  try{
   const op=db.prepare('SELECT * FROM operations WHERE id=?').get(run.operation_id);if(!op||op.tenant_id!==tenantId||op.project_id!==run.project_id||op.payload_hash!==run.payload_hash||op.state!=='running')throw Error('Operation changed');
   status=!uncertain&&result?.status==='completed'&&leaseIsActive(db,claims(run))?'completed':'uncertain';
   db.prepare('UPDATE readonly_runs SET state=?,result_json=? WHERE operation_id=?').run(status,JSON.stringify(result||{}),run.operation_id);
   db.prepare('UPDATE operations SET state=?,updated_at=? WHERE id=?').run(status,new Date().toISOString(),run.operation_id);
   db.prepare("UPDATE worker_leases SET state='revoked' WHERE id=?").run(run.lease_id);
   if(status==='completed')db.prepare('DELETE FROM operation_outbox WHERE operation_id=?').run(run.operation_id);
   if(status==='completed')emitAfter.push(appendEvent(db,{tenantId,projectId:run.project_id,operationId:run.operation_id,type:'message_completed',payload:{text:result.text,scope:'native-dsh-readonly',callId:result.callId,usage:result.usage}}));
   event=appendEvent(db,{tenantId,projectId:run.project_id,operationId:run.operation_id,type:'task_status',payload:{state:status,readonly:true}});db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  for(const e of emitAfter.splice(0))emit(e);emit(event);return status;
 };
 async function tick(){if(busy)return false;busy=true;try{
  // A crash/unknown turn is quarantined, never sent again automatically.
  for(const run of db.prepare("SELECT * FROM readonly_runs WHERE state='running' AND tenant_id=? AND lease_id IN (SELECT id FROM worker_leases WHERE worker_id=?)").all(tenantId,workerId)){if(leaseIsActive(db,claims(run)))return false;finish(run,null,true);}
  if(db.prepare("SELECT 1 FROM readonly_runs WHERE state='uncertain' AND tenant_id=? AND lease_id IN (SELECT id FROM worker_leases WHERE worker_id=?)").get(tenantId,workerId))return false;
  const op=db.prepare("SELECT o.* FROM operations o JOIN operation_outbox q ON q.operation_id=o.id WHERE o.tenant_id=? AND o.state='queued' ORDER BY q.id LIMIT 1").get(tenantId);if(!op)return false;
  const source=db.prepare("SELECT payload_json FROM project_events WHERE operation_id=? AND type='message_created' ORDER BY id LIMIT 1").get(op.id);if(!source)throw Error('Missing durable message');
  const lease=acquireLease(db,{workerId,projectId:op.project_id,operationId:op.id,ttlMs:300000});
  const run={operation_id:op.id,tenant_id:tenantId,project_id:op.project_id,payload_hash:op.payload_hash,lease_id:lease.id,generation:lease.generation};
  db.exec('BEGIN IMMEDIATE');let event;
  try{db.prepare("INSERT INTO readonly_runs VALUES(?,?,?,?,?,?,'running',NULL)").run(op.id,tenantId,op.project_id,op.payload_hash,lease.id,lease.generation);db.prepare("UPDATE operations SET state='running',engine_request_id=?,updated_at=? WHERE id=? AND state='queued'").run('native-'+op.id,new Date().toISOString(),op.id);event=appendEvent(db,{tenantId,projectId:op.project_id,operationId:op.id,type:'task_status',payload:{state:'running',readonly:true}});db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}emit(event);
  let result;try{result=await execute({operationId:op.id,projectId:op.project_id,text:JSON.parse(source.payload_json).text});}catch{result=null;}finish(run,result,!result);return true;
 }finally{busy=false;}}
 return {tick};
}
