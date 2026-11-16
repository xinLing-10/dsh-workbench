/** SQL owns execution identity; views derive status from receipts, never a second status copy. */
import {randomUUID} from 'node:crypto';
import {learningState} from './learning-session.mjs';
const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:status===404?'not_found':'validation'});
export function taskInput(body){
 const mode=body.mode??'work',taskId=body.taskId??null;
 if(!['work','learning'].includes(mode)||taskId!==null&&(typeof taskId!=='string'||!/^tsk_[a-zA-Z0-9_]+$/.test(taskId)))throw fail('任务类型或任务编号无效');
 if(body.taskTitle!==undefined&&(typeof body.taskTitle!=='string'||!body.taskTitle.trim()||body.taskTitle.trim().length>120))throw fail('任务名称需要1—120个字符');
 return {mode,taskId,title:body.taskTitle?.trim()||null};
}
export function bindTask(db,project,operationId,text,input){
 let task=input.taskId?db.prepare('SELECT * FROM business_tasks WHERE id=? AND project_id=? AND tenant_id=?').get(input.taskId,project.id,project.tenant_id):null;
 if(input.taskId&&!task)throw fail('任务不存在',404);
 if(task&&task.kind!==input.mode)throw fail('继续任务时不能更改任务类型');
 if(!task){const at=input.createdAt||new Date().toISOString();task={id:'tsk_'+randomUUID().replaceAll('-',''),title:input.title||text.replace(/\s+/g,' ').slice(0,80),kind:input.mode,created_at:at};
 db.prepare('INSERT INTO business_tasks(id,tenant_id,project_id,title,kind,created_at) VALUES(?,?,?,?,?,?)').run(task.id,project.tenant_id,project.id,task.title,task.kind,at);}
 db.prepare('INSERT INTO business_task_operations(task_id,operation_id) VALUES(?,?)').run(task.id,operationId);
 return {id:task.id,title:task.title,kind:task.kind};
}
export function operationTask(db,operationId){return db.prepare('SELECT t.id,t.title,t.kind FROM business_tasks t JOIN business_task_operations l ON l.task_id=t.id WHERE l.operation_id=?').get(operationId)||null;}
export function taskGraph(db,project){
 return db.prepare('SELECT * FROM business_tasks WHERE project_id=? AND tenant_id=? ORDER BY created_at,id').all(project.id,project.tenant_id).map(t=>{
 const operations=db.prepare(`SELECT o.id,o.state,o.created_at createdAt,o.updated_at updatedAt,w.worker_id workerId,w.state executionState FROM business_task_operations l JOIN operations o ON o.id=l.operation_id LEFT JOIN worker_executions w ON w.operation_id=o.id WHERE l.task_id=? ORDER BY o.created_at,o.rowid`).all(t.id);
 const artifacts=db.prepare(`WITH links AS (SELECT artifact_id,source_operation_id operation_id FROM artifact_contents UNION SELECT artifact_id,operation_id FROM worker_execution_artifacts) SELECT DISTINCT a.id,a.relative_path path,a.version,a.confirmed,a.sha256,l.operation_id operationId FROM artifact_index a JOIN links c ON c.artifact_id=a.id JOIN business_task_operations l ON l.operation_id=c.operation_id WHERE l.task_id=? AND a.project_id=? AND NOT EXISTS(SELECT 1 FROM core_sessions s WHERE s.operation_id=c.operation_id AND a.relative_path NOT LIKE '.dsh/workbench/changes/%/documents/%' AND NOT EXISTS(SELECT 1 FROM template_exports x WHERE x.artifact_id=a.id)) ORDER BY a.created_at,a.id`).all(t.id,project.id).map(a=>({...a,confirmed:Boolean(a.confirmed)}));
 const currentArtifacts=[...new Map(artifacts.toSorted((a,b)=>a.version-b.version).map(a=>[a.path,a])).values()];
 const latest=['uncertain','waiting','running','queued','accepted'].map(state=>operations.find(o=>o.state===state)).find(Boolean)||operations.at(-1);return {workflow:Boolean(db.prepare('SELECT 1 FROM core_bindings WHERE task_id=?').get(t.id)),id:t.id,title:t.title,kind:t.kind,createdAt:t.created_at,state:latest?.state||'queued',delivery:!artifacts.length?'none':currentArtifacts.every(a=>a.confirmed)?'confirmed':'needs_review',operations,artifacts,...(t.kind==='learning'?{learning:learningState(db,t.id)}:{})};
 });
}
/** Idempotent legacy migration. Preserve every original request, event and budget record. */
export function migrateTaskLinks(db){
 const rows=db.prepare("SELECT o.* FROM operations o LEFT JOIN business_task_operations l ON l.operation_id=o.id WHERE o.type='send_message' AND l.operation_id IS NULL ORDER BY o.created_at,o.rowid").all();
 db.exec('BEGIN IMMEDIATE');try{for(const op of rows){const p=db.prepare('SELECT * FROM projects WHERE id=? AND tenant_id=?').get(op.project_id,op.tenant_id);if(!p)continue;const e=db.prepare("SELECT payload_json FROM project_events WHERE operation_id=? AND type='message_created' ORDER BY id LIMIT 1").get(op.id);let text='历史对话';try{text=JSON.parse(e?.payload_json||'{}').text||text;}catch{}bindTask(db,p,op.id,text,{mode:'work',taskId:null,title:null,createdAt:op.created_at});}db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
