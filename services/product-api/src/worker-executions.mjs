/** Durable operation lifecycle. No model calls and no automatic redispatch. */
import {randomUUID} from 'node:crypto';
import {validateWorkerEvent,WORKER_TERMINAL} from '../../../packages/manager-contracts/worker.mjs';
import {bodyDigest} from '../../../packages/manager-contracts/tokens.mjs';
import {leaseIsActive,acquireLease} from './workers.mjs';
const now=()=>new Date().toISOString();
const conflict=message=>Object.assign(new Error(message),{status:409,code:'conflict'});
export const executionFor=(db,id)=>db.prepare('SELECT * FROM worker_executions WHERE operation_id=?').get(id);
export const executionClaims=run=>({sub:run.worker_id,tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,leaseId:run.lease_id,generation:run.generation});
export function executionJob(db,run) {
 const row=db.prepare("SELECT payload_json FROM project_events WHERE operation_id=? AND type='message_created' ORDER BY id LIMIT 1").get(run.operation_id);
 return {protocolVersion:1,workerId:run.worker_id,tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,leaseId:run.lease_id,generation:run.generation,engineId:run.engine_id,payloadHash:run.payload_hash,deadline:run.deadline,text:JSON.parse(row?.payload_json || '{}').text || ''};
}
export function requireExecution(db,claims,{allowTerminal=false}={}) {
 const run=executionFor(db,claims.operationId);
 if(!run)return null; // Legacy diagnostic leases remain compatible.
 if(!leaseIsActive(db,claims) || run.worker_id!==claims.sub || run.lease_id!==claims.leaseId || run.generation!==claims.generation || run.project_id!==claims.projectId || run.tenant_id!==claims.tenantId || (!allowTerminal && (WORKER_TERMINAL.includes(run.state) || ['uncertain','stopping'].includes(run.state))))throw conflict('执行已停止、待核对或租约失效');
 return run;
}
export function acceptWorkerEvent(db,claims,event,append) {
 validateWorkerEvent(event);
 const run=executionFor(db,claims.operationId);
 if(!run || run.worker_id!==claims.sub || run.tenant_id!==claims.tenantId || run.project_id!==claims.projectId || run.lease_id!==claims.leaseId || run.generation!==claims.generation || run.engine_id!==event.engineId)throw conflict('执行范围不匹配');
 if((run.sequence===0 && event.type!=='started') || (run.sequence>0 && event.type==='started' && event.sequence>run.sequence))throw conflict('缺少开始回执或重复开始');
 const digest=bodyDigest(event),old=db.prepare('SELECT * FROM worker_execution_events WHERE operation_id=? AND (sequence=? OR event_id=?)').get(run.operation_id,event.sequence,event.eventId);
 if(old){if(old.digest!==digest)throw conflict('事件重放内容冲突');return {replayed:true,state:run.state,events:[]};}
 if(!leaseIsActive(db,claims) || WORKER_TERMINAL.includes(run.state) || run.state==='uncertain' || event.sequence!==run.sequence+1)throw conflict('租约、终态或事件顺序不匹配');
 if(event.type==='completed' && run.stop_requested)throw conflict('停止请求后不能提交成功，需核对实际结束原因');
 if(run.stop_requested && !['heartbeat','cancelled','failed'].includes(event.type))throw conflict('执行正在停止');
 if(WORKER_TERMINAL.includes(event.type)) {
   const recorded=db.prepare('SELECT artifact_id FROM worker_execution_artifacts WHERE operation_id=?').all(run.operation_id).map(r=>r.artifact_id);
   if(event.artifactIds.some(id=>!recorded.includes(id)))throw conflict('成果尚未在本次执行登记');
 }
 let state=event.type==='heartbeat'?run.state:event.type==='started'?'running':event.type;
 const events=[];
 db.exec('BEGIN IMMEDIATE');
 try{
  if(!leaseIsActive(db,claims))throw conflict('租约已失效');
  db.prepare('INSERT INTO worker_execution_events VALUES(?,?,?,?,?)').run(run.operation_id,event.sequence,event.eventId,digest,JSON.stringify(event));
  db.prepare('UPDATE worker_executions SET state=?,sequence=?,updated_at=? WHERE operation_id=?').run(state,event.sequence,now(),run.operation_id);
  db.prepare('UPDATE operations SET state=?,engine_revision=?,updated_at=? WHERE id=?').run(state==='stopping'?'running':state,event.sequence,now(),run.operation_id);
  if(event.type==='heartbeat')db.prepare("UPDATE worker_leases SET expires_at=? WHERE id=? AND state='active'").run(new Date(Math.min(Date.now()+60000,Date.parse(run.deadline))).toISOString(),run.lease_id);
  if(WORKER_TERMINAL.includes(state)){
   db.prepare("UPDATE worker_leases SET state='revoked' WHERE id=?").run(run.lease_id);
   db.prepare('DELETE FROM operation_outbox WHERE operation_id=?').run(run.operation_id);
   const cards=db.prepare("SELECT id FROM interaction_requests WHERE operation_id=? AND state='pending'").all(run.operation_id);
   db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND state='pending'").run(run.operation_id);
   for(const c of cards)events.push(append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'interaction_cancelled',payload:{interactionId:c.id}}));
   if(state==='completed')events.push(append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'message_completed',payload:{text:event.text || '',scope:'worker-protocol-v1',engineReceipt:true}}));
  }
  if(event.type!=='heartbeat')events.push(append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'task_status',payload:{state,workerProtocol:true,sequence:event.sequence,engineReceipt:WORKER_TERMINAL.includes(state)}}));
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
 return {state,replayed:false,events};
}
export function createWorkerCoordinator({db,workerId,transport,append,publish=()=>{},paused=()=>false,budget=null,requireIsolation=false}) {
 const worker=db.prepare("SELECT * FROM workers WHERE id=? AND status='active'").get(workerId);if(!worker)throw conflict('Worker 未注册或已停用');
 let busy=false,ready=false;
 const emit=events=>{for(const e of events)try{publish(e);}catch{}};
 function uncertain(run,reason) {
  const events=[];db.exec('BEGIN IMMEDIATE');
  try{
   const changed=db.prepare("UPDATE worker_executions SET state='uncertain',updated_at=? WHERE operation_id=? AND state NOT IN ('completed','cancelled','failed','uncertain')").run(now(),run.operation_id);
   if(changed.changes){db.prepare("UPDATE operations SET state='uncertain',updated_at=? WHERE id=? AND state NOT IN ('completed','cancelled','failed')").run(now(),run.operation_id);db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND state='pending'").run(run.operation_id);events.push(append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'recovery_check',payload:{state:'uncertain',reason,workerProtocol:true}}));}
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}emit(events);
 }
 async function recover(onlyOperation=null) {
  for(const run of db.prepare("SELECT * FROM worker_executions WHERE worker_id=? AND state NOT IN ('completed','cancelled','failed')").all(workerId)){
   if(onlyOperation && run.operation_id!==onlyOperation)continue;
   try{
    const observation=await transport.observe(executionJob(db,run));
    if(observation?.engineId!==run.engine_id || observation?.state==='uncertain' || !leaseIsActive(db,executionClaims(run))) {uncertain(run,'执行进程或租约待核对，不会重发');continue;}
    if(run.state==='uncertain'){
      const state=run.stop_requested?'stopping':db.prepare("SELECT 1 FROM interaction_requests WHERE operation_id=? AND state='pending'").get(run.operation_id)?'waiting':'running';
      db.prepare('UPDATE worker_executions SET state=?,updated_at=? WHERE operation_id=?').run(state,now(),run.operation_id);
      db.prepare('UPDATE operations SET state=?,updated_at=? WHERE id=?').run(state==='stopping'?'running':state,now(),run.operation_id);
      emit([append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'recovery_check',payload:{state,reattached:true,workerProtocol:true}})]);
    }
    for(const event of observation.events || []){const current=executionFor(db,run.operation_id);if(event.sequence>current.sequence)emit(acceptWorkerEvent(db,executionClaims(current),event,append).events);}
   }catch{if(!leaseIsActive(db,executionClaims(run)) || Date.now()-Date.parse(run.updated_at)>60000)uncertain(run,'观察通道中断，不会重发');}
  }
 }
 async function tick(){if(busy)return false;busy=true;try{
  ready=await transport.handshake(workerId);if(!ready)return false;
  await recover();if(paused() || (requireIsolation && !transport.isolated))return false;
  if(db.prepare("SELECT 1 FROM worker_executions WHERE worker_id=? AND state NOT IN ('completed','cancelled','failed')").get(workerId))return false;
  if(budget)budget.expireHolds();
  const op=db.prepare("SELECT o.* FROM operations o JOIN operation_outbox q ON q.operation_id=o.id JOIN projects p ON p.id=o.project_id WHERE o.tenant_id=? AND o.type='send_message' AND o.state='queued' AND p.status='active' AND q.next_at<=? AND NOT EXISTS(SELECT 1 FROM worker_executions r WHERE r.operation_id=o.id) ORDER BY q.id LIMIT 100").all(worker.tenant_id,now()).find(candidate=>{if(!budget)return true;try{budget.check(candidate.id);return true;}catch{return false;}});if(!op)return false;
  const lease=acquireLease(db,{workerId,projectId:op.project_id,operationId:op.id,ttlMs:60000});
  const engineId='eng_'+randomUUID().replaceAll('-','');const created=now();let event;
  db.exec('BEGIN IMMEDIATE');try{
   const result=db.prepare("UPDATE operations SET state='running',engine_request_id=?,updated_at=? WHERE id=? AND state='queued'").run(engineId,created,op.id);if(!result.changes)throw conflict('操作已被接下');
   db.prepare("INSERT INTO worker_executions(operation_id,worker_id,tenant_id,project_id,lease_id,generation,engine_id,payload_hash,state,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'dispatching',?,?,?)").run(op.id,workerId,op.tenant_id,op.project_id,lease.id,lease.generation,engineId,op.payload_hash,new Date(Date.now()+300000).toISOString(),created,created);
   db.prepare('UPDATE operation_outbox SET attempts=attempts+1 WHERE operation_id=?').run(op.id);
   event=append(db,{tenantId:op.tenant_id,projectId:op.project_id,operationId:op.id,type:'task_status',payload:{state:'running',workerProtocol:true}});db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');db.prepare("UPDATE worker_leases SET state='revoked' WHERE id=?").run(lease.id);throw error;}emit([event]);
  const run=executionFor(db,op.id);try{const ack=await transport.dispatch(executionJob(db,run));if(ack?.engineId!==engineId || ack?.accepted!==true)throw conflict('缺少接受回执');}catch{uncertain(run,'派发结果不明，仅允许观察，不会再次派发');}
  return true;
 }finally{busy=false;}}
 async function cancel({operationId,projectId,tenantId}) {
  const run=executionFor(db,operationId);if(!run || run.worker_id!==workerId || run.project_id!==projectId || run.tenant_id!==tenantId)throw conflict('执行不存在');
  if(run.state==='cancelled')return {state:'cancelled',engineAcknowledged:true};
  if(!['dispatching','running','waiting','stopping'].includes(run.state))throw conflict('当前执行不能安全停止');
  db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE worker_executions SET state='stopping',stop_requested=1,updated_at=? WHERE operation_id=?").run(now(),operationId);db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND state='pending'").run(operationId);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  try{
   const receipt=await transport.stop(executionJob(db,run));
   for(const event of receipt.events || []){const current=executionFor(db,operationId);if(event.sequence>current.sequence)emit(acceptWorkerEvent(db,executionClaims(current),event,append).events);}
   const finished=executionFor(db,operationId);if(finished.state!=='cancelled')throw conflict('缺少引擎停止回执');return {state:'cancelled',engineAcknowledged:true};
  }catch(error){uncertain(executionFor(db,operationId),'停止回执待核对');throw error;}
 }
 return {tick,recover,cancel,async probe(){ready=await transport.handshake(workerId);return ready;},async recoverOperation({operationId,projectId,tenantId}){const run=executionFor(db,operationId);if(!run || run.worker_id!==workerId || run.project_id!==projectId || run.tenant_id!==tenantId)throw conflict('执行不存在');await recover(operationId);},capabilities:()=>({bridge:ready,questions:ready,approvals:ready,nativeStop:ready,workerProtocol:true,isolated:ready&&Boolean(transport.isolated),usage:Boolean(budget),learning:false,paused:paused()})};
}
