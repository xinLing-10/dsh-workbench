/** Single control process: one active execution slot, durable human waits may park. */
import {isParked} from './execution-admission.mjs';
import {createWorkerCoordinator,executionFor} from './worker-executions.mjs';
export function createWorkerPool({db,workers,append,publish,budget,requireIsolation=true,paused=()=>false}){
 if(!Array.isArray(workers)||!workers.length||workers.length>10||new Set(workers.map(w=>w.id)).size!==workers.length)throw Error('Use 1–10 unique registered Workers');
 const canDispatch=()=>!db.prepare("SELECT * FROM worker_executions WHERE worker_id IN ("+workers.map(()=>'?').join(',')+") AND state NOT IN ('completed','cancelled','failed')").all(...workers.map(w=>w.id)).some(r=>!isParked(db,r));
 const members=new Map(workers.map(w=>[w.id,createWorkerCoordinator({db,workerId:w.id,transport:w.transport,append,publish,budget,requireIsolation,paused,admit:canDispatch})]));let busy=false,lastProbe=0;
 const target=operationId=>{const run=executionFor(db,operationId),c=run&&members.get(run.worker_id);if(!c)throw Object.assign(new Error('执行不属于已配置 Worker'),{status:409});return c;};
 return {
  async tick(){if(busy)return false;busy=true;try{
   if(Date.now()-lastProbe>10000){for(const c of members.values())await c.probe();lastProbe=Date.now();}
   for(const c of members.values())await c.recover();
   if(paused())return false;
   const placeholders=[...members.keys()].map(()=>'?').join(',');
   if(db.prepare("SELECT * FROM worker_executions WHERE worker_id IN ("+placeholders+") AND state NOT IN ('completed','cancelled','failed')").all(...members.keys()).some(r=>!isParked(db,r)))return false;
   if(!db.prepare("SELECT 1 FROM operations o JOIN operation_outbox q ON q.operation_id=o.id WHERE o.state='queued' LIMIT 1").get())return false;
   const entries=[...members.entries()].map(([id,c])=>({id,c,tenant:db.prepare('SELECT tenant_id FROM workers WHERE id=?').get(id).tenant_id}));
   const tenants=[...new Set(entries.map(e=>e.tenant))],last=db.prepare("SELECT last_tenant FROM scheduler_state WHERE id='pool'").get()?.last_tenant;
   const start=(tenants.indexOf(last)+1)%tenants.length;
   for(let i=0;i<tenants.length;i++){const tenant=tenants[(start+i)%tenants.length];for(const e of entries.filter(e=>e.tenant===tenant)){if(await e.c.tick()){db.prepare("INSERT INTO scheduler_state VALUES('pool',?) ON CONFLICT(id) DO UPDATE SET last_tenant=excluded.last_tenant").run(tenant);return true;}}}return false;
  }finally{busy=false;}},
  cancel:body=>target(body.operationId).cancel(body),recoverOperation:body=>target(body.operationId).recoverOperation(body),
  workerCapabilities:id=>members.get(id)?.capabilities()||{},
  capabilities(){const list=[...members.values()].map(c=>c.capabilities()),any=key=>list.some(c=>c[key]);return {bridge:any('bridge'),questions:any('questions'),approvals:any('approvals'),nativeStop:any('nativeStop'),workerProtocol:true,isolated:any('isolated'),usage:Boolean(budget),learning:false,paused:paused()};}
 };
}
