/** Single-control-process pool. One active execution globally on the small acceptance server. */
import {createWorkerCoordinator,executionFor} from './worker-executions.mjs';
export function createWorkerPool({db,workers,append,publish,budget,requireIsolation=true,paused=()=>false}){
 if(!Array.isArray(workers)||!workers.length||workers.length>10||new Set(workers.map(w=>w.id)).size!==workers.length)throw Error('Use 1–10 unique registered Workers');
 const members=new Map(workers.map(w=>[w.id,createWorkerCoordinator({db,workerId:w.id,transport:w.transport,append,publish,budget,requireIsolation,paused})]));let busy=false,cursor=0,lastProbe=0;
 const target=operationId=>{const run=executionFor(db,operationId),c=run&&members.get(run.worker_id);if(!c)throw Object.assign(new Error('执行不属于已配置 Worker'),{status:409});return c;};
 return {
  async tick(){if(busy)return false;busy=true;try{
   if(Date.now()-lastProbe>10000){for(const c of members.values())await c.probe();lastProbe=Date.now();}
   for(const c of members.values())await c.recover();
   if(paused())return false;
   const placeholders=[...members.keys()].map(()=>'?').join(',');
   if(db.prepare("SELECT 1 FROM worker_executions WHERE worker_id IN ("+placeholders+") AND state NOT IN ('completed','cancelled','failed')").get(...members.keys()))return false;
   if(!db.prepare("SELECT 1 FROM operations o JOIN operation_outbox q ON q.operation_id=o.id WHERE o.state='queued' LIMIT 1").get())return false;
   const order=[...members.values()];for(let i=0;i<order.length;i++){const index=(cursor+i)%order.length;if(await order[index].tick()){cursor=(index+1)%order.length;return true;}}return false;
  }finally{busy=false;}},
  cancel:body=>target(body.operationId).cancel(body),recoverOperation:body=>target(body.operationId).recoverOperation(body),
  workerCapabilities:id=>members.get(id)?.capabilities()||{},
  capabilities(){const list=[...members.values()].map(c=>c.capabilities()),any=key=>list.some(c=>c[key]);return {bridge:any('bridge'),questions:any('questions'),approvals:any('approvals'),nativeStop:any('nativeStop'),workerProtocol:true,isolated:any('isolated'),usage:Boolean(budget),learning:false,paused:paused()};}
 };
}
