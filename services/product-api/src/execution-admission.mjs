/** A parked human interaction retains its engine/lease but releases the global activity slot. */
import {leaseIsActive} from './workers.mjs';
export function isParked(db,run){
 if(run.state!=='waiting'||run.stop_requested)return false;
 if(!leaseIsActive(db,{sub:run.worker_id,tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,leaseId:run.lease_id,generation:run.generation}))return false;
 if(db.prepare("SELECT 1 FROM service_model_calls WHERE operation_id=? AND state!='settled'").get(run.operation_id))return false;
 return Boolean(db.prepare("SELECT 1 FROM interaction_requests WHERE operation_id=? AND state='pending' AND (expires_at IS NULL OR expires_at>?)").get(run.operation_id,new Date().toISOString()));
}
export function canResume(db,operationId){
 const own=db.prepare('SELECT * FROM worker_executions WHERE operation_id=?').get(operationId);
 if(!own||!['waiting','uncertain'].includes(own.state))return true;
 // Disabled/quarantined Workers remain audit records, outside the active pool.
 return !db.prepare("SELECT e.* FROM worker_executions e JOIN workers w ON w.id=e.worker_id WHERE w.status='active' AND e.operation_id!=? AND e.state NOT IN ('completed','cancelled','failed')").all(operationId).some(r=>!isParked(db,r) && !(r.state==='waiting' && !r.stop_requested && !db.prepare("SELECT 1 FROM interaction_requests WHERE operation_id=? AND state='pending'").get(r.operation_id) && (r.created_at+' '+r.operation_id)>(own.created_at+' '+own.operation_id)));
}
export function resumeAnswered(db,operationId){
 if(!canResume(db,operationId))return false;
 db.prepare("UPDATE worker_executions SET state='running',updated_at=? WHERE operation_id=? AND state='waiting'").run(new Date().toISOString(),operationId);
 db.prepare("UPDATE operations SET state='running',updated_at=? WHERE id=? AND state='waiting'").run(new Date().toISOString(),operationId);
 return true;
}
