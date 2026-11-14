import {runAuthorization} from './run-authorization.mjs';
/** Atomic, durable token limits; credentials and experimental ledgers are never stored here. */
import {bodyDigest} from '../../../packages/manager-contracts/tokens.mjs';
import {inputReservation,usageTotal} from './model-budget.mjs';
export const SERVICE_TOOLS=['ask_user_question','run_project_command'];
const error=(message,status=409)=>Object.assign(new Error(message),{status,code:'capability_unavailable'});
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export const isPlatformAdmin=(db,id)=>Boolean(db.prepare(`SELECT 1 FROM platform_admins WHERE user_id=?`).get(id));
export function auditService(db,actor,action,target,meta={}) {
 db.prepare(`INSERT INTO audit_events(actor,action,target,meta_json,at) VALUES(?,?,?,?,?)`).run(actor,action,target,JSON.stringify(meta),new Date().toISOString());
}
export function createServiceBudget({db,clock=()=>new Date()}) {
 const transaction=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
 const at=()=>clock().toISOString();
 function identity(operationId){
  const op=db.prepare(`SELECT o.*,u.status AS user_status FROM operations o JOIN users u ON u.id=o.actor_user_id AND u.tenant_id=o.tenant_id JOIN projects p ON p.id=o.project_id AND p.tenant_id=o.tenant_id WHERE o.id=? AND p.status='active'`).get(operationId);
  if(!op || op.user_status!=='active')throw error('任务缺少有效的用户归属，需管理员核对');return op;
 }
 function view(scope,scopeId) {
  const p=db.prepare(`SELECT * FROM token_policies WHERE scope=? AND scope_id=?`).get(scope,scopeId);
  const time=at(),start=p?.window==='day'?time.slice(0,10):p?.window==='month'?time.slice(0,7):'';
  const column=scope==='user'?'user_id':scope==='project'?'project_id':null;
  if(!['global','user','project'].includes(scope))throw error('无效额度范围',400);
  const rows=db.prepare('SELECT state,reservation,actual,created_at FROM service_model_calls'+(column?' WHERE '+column+'=?':'')).all(...(column?[scopeId]:[]));
  let used=rows.filter(c=>c.state==='settled' && c.created_at.startsWith(start)).reduce((s,c)=>s+c.actual,0);
  // Outstanding holds survive calendar rollovers and policy-window changes.
  let held=rows.filter(c=>c.state!=='settled').reduce((s,c)=>s+Math.max(c.reservation,c.actual??0),0);
  const carry=scope==='global'?db.prepare('SELECT used,held FROM service_budget_carryovers').all():[];used+=carry.reduce((n,c)=>n+c.used,0);held+=carry.reduce((n,c)=>n+c.held,0);
  const allocation=scope==='global'?runAuthorization(db):null;const limit=allocation?Math.min(p?.token_limit??0,allocation.tokenLimit):p?.token_limit??0;
  return {scope,scopeId,limit,window:p?.window??null,revision:p?.revision??0,configured:Boolean(p),used,held,remaining:Math.max(0,limit-used-held),frozen:rows.some(c=>c.state==='unknown')||carry.some(c=>c.held>0)};
 }
 function scopes(op){return [['global','*'],['user',op.actor_user_id],['project',op.project_id]];}
 function checkIdentity(userId,projectId,amount=1){for(const [s,id]of [['global','*'],['user',userId],['project',projectId]]){const v=view(s,id);if(!v.configured||v.frozen||v.remaining<amount)throw error('额度未配置、已用完或存在待核对用量（'+s+'）');}}
 function check(operationId,amount=1){const op=identity(operationId);for(const [s,id]of scopes(op)){const v=view(s,id);if(!v.configured || v.frozen || v.remaining<amount)throw error('额度未配置、已用完或存在待核对用量（'+s+'）');}return op;}
 function policy(actor,{scope,scopeId,limit,window,revision,reason}){return transaction(()=>{
  if(!isPlatformAdmin(db,actor))throw error('仅平台管理员可修改额度',403);
  if(!['global','user','project'].includes(scope)||typeof scopeId!=='string'||!integer(limit)||!['day','month','lifetime'].includes(window)||!integer(revision)||typeof reason!=='string'||reason.trim().length<4||reason.length>1000)throw error('额度参数或核对说明不完整',400);
  if(scope==='global' && scopeId!=='*' || scope!=='global' && !db.prepare('SELECT id FROM '+(scope==='user'?'users':'projects')+' WHERE id=?').get(scopeId))throw error('额度对象不存在',400);
  const before=view(scope,scopeId);if(before.revision!==revision)throw error('额度已被修改，请刷新');
  // Resetting a window must never erase already charged usage.
  if(before.window && before.window!==window)throw error('额度周期创建后不能直接切换，请保持原周期');
  db.prepare(`INSERT INTO token_policies VALUES(?,?,?,?,?) ON CONFLICT(scope,scope_id) DO UPDATE SET token_limit=excluded.token_limit,revision=excluded.revision,window=excluded.window`).run(scope,scopeId,limit,window,revision+1);
  auditService(db,actor,'token_policy_changed',scope+':'+scopeId,{before,limit,window,reason});return view(scope,scopeId);
 });}
 function forOperation(operationId){return {
  reserve(id,body,options={}){return transaction(()=>{
   if(typeof id!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(id))throw error('无效模型调用编号',400);
   const input=inputReservation(body,{...options,allowedTools:SERVICE_TOOLS}),amount=input+body.max_tokens;
   // Duplicate attempts never redispatch, even with identical payloads.
   if(db.prepare(`SELECT 1 FROM service_model_calls WHERE id=?`).get(id))throw error('调用已记录，不得重发');
   const allocation=runAuthorization(db);if(allocation && db.prepare('SELECT count(*) n FROM service_model_calls').get().n>=allocation.maxRequests)throw error('本轮模型请求总次数已达到授权上限');
   const op=check(operationId,amount);
   db.prepare(`INSERT INTO service_model_calls(id,operation_id,tenant_id,user_id,project_id,payload_hash,reservation,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'held',?,?)`).run(id,operationId,op.tenant_id,op.actor_user_id,op.project_id,bodyDigest(body),amount,at(),at());
   return {input,amount};
  });},
  beforeDispatch(id){return transaction(()=>{
   const c=db.prepare('SELECT * FROM service_model_calls WHERE id=? AND operation_id=?').get(id,operationId);
   if(!c || c.state!=='held' || Date.parse(c.created_at)+120000<clock().getTime())throw error('预占已过期或已核对，不得发起调用');
   const op=identity(operationId);for(const [s,id]of scopes(op)){const v=view(s,id);if(v.frozen||!v.configured||v.used+v.held>v.limit)throw error('额度状态已变化，不得发起调用');}
  });},
  settle(id,{usage,complete,outputLimit,evidence={}}){return transaction(()=>{
   const c=db.prepare(`SELECT * FROM service_model_calls WHERE id=? AND operation_id=?`).get(id,operationId);if(!c || c.state==='settled')throw error('用量已结算或调用不存在');
   const total=usageTotal(usage);const known=usage?['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].reduce((n,k)=>n+(integer(usage[k])?usage[k]:0),0):0;const actual=total??(Number.isSafeInteger(known)&&known>0?known:null);const valid=complete && total!==null && actual<=c.reservation && usage.output_tokens<=outputLimit && actual-usage.output_tokens<=c.reservation-outputLimit;
   db.prepare(`UPDATE service_model_calls SET state=?,actual=?,evidence_json=?,revision=revision+1,updated_at=? WHERE id=?`).run(valid?'settled':'unknown',actual,JSON.stringify(evidence),at(),id);return valid;
  });}
 };}
 function reconcile(actor,{id,revision,actual,reason,evidence}){return transaction(()=>{
  if(!isPlatformAdmin(db,actor))throw error('仅平台管理员可核对用量',403);
  const c=db.prepare(`SELECT * FROM service_model_calls WHERE id=?`).get(id);
  if(!c || c.state!=='unknown' || c.revision!==revision)throw error('记录状态已变化，请刷新');
  if(!integer(actual)||actual<(c.actual??0)||typeof reason!=='string'||reason.trim().length<4||reason.length>1000||typeof evidence!=='string'||evidence.trim().length<8||evidence.length>2000)throw error('需要实际用量、核对原因与账单/服务商凭证编号，不能低于已知用量',400);
  db.prepare(`UPDATE service_model_calls SET state='settled',actual=?,revision=revision+1,updated_at=? WHERE id=?`).run(actual,at(),id);
  auditService(db,actor,'model_usage_reconciled',id,{before:c,actual,reason,evidence});return {id,state:'settled',actual};
 });}
 function reconcileCarryover(actor,{id,revision,actual,reason,evidence}){return transaction(()=>{
  if(!isPlatformAdmin(db,actor))throw error('仅平台管理员可核对用量',403);
  const c=db.prepare('SELECT * FROM service_budget_carryovers WHERE id=?').get(id);
  if(!c || !c.held || c.revision!==revision)throw error('历史预占状态已变化，请刷新');
  if(!integer(actual)||actual<c.used||typeof reason!=='string'||reason.trim().length<4||reason.length>1000||typeof evidence!=='string'||evidence.trim().length<8||evidence.length>2000)throw error('历史核对需要累计实际用量和凭证，不能低于已结算用量',400);
  db.prepare('UPDATE service_budget_carryovers SET used=?,held=0,revision=revision+1 WHERE id=?').run(actual,id);
  auditService(db,actor,'model_usage_reconciled',id,{before:c,actual,reason,evidence,legacy:true});return {id,used:actual,held:0};
 });}
 function expireHolds(){return transaction(()=>{
  const rows=db.prepare("SELECT id FROM service_model_calls WHERE state='held' AND created_at<?").all(new Date(clock().getTime()-180000).toISOString());
  for(const c of rows){db.prepare("UPDATE service_model_calls SET state='unknown',revision=revision+1,updated_at=? WHERE id=? AND state='held'").run(at(),c.id);auditService(db,'service','model_usage_missing',c.id);}
  return rows.length;
 });}
 return {view,check,checkIdentity,policy,forOperation,reconcile,reconcileCarryover,expireHolds,overview(){expireHolds();return {
  unit:'token',authorization:runAuthorization(db),policies:db.prepare(`SELECT scope,scope_id FROM token_policies`).all().map(p=>view(p.scope,p.scope_id)),
  carryovers:db.prepare('SELECT * FROM service_budget_carryovers').all(),
  pending:db.prepare("SELECT id,operation_id,user_id,project_id,state,reservation,actual,revision,created_at,evidence_json FROM service_model_calls WHERE state!='settled' ORDER BY created_at LIMIT 100").all(),
  users:db.prepare(`SELECT id,email FROM users WHERE status='active'`).all(),projects:db.prepare(`SELECT id,name FROM projects WHERE status='active'`).all(),
  executions:db.prepare("SELECT operation_id,worker_id,project_id,state,updated_at FROM worker_executions WHERE state NOT IN ('completed','cancelled','failed')").all(),
  audit:db.prepare("SELECT actor,action,target,meta_json,at FROM audit_events WHERE action IN ('token_policy_changed','model_usage_reconciled','model_usage_missing','platform_admin_granted','platform_admin_revoked','budget_carryover_imported','invitation_created') ORDER BY id DESC LIMIT 50").all()
 };}};
}
