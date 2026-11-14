/** Worker-owned durable journal; a restarted worker never recreates an unknown engine. */
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {validateJob,sameExecution,WORKER_TERMINAL} from './worker-contract.mjs';
import {createProductClient} from './client.mjs';
const reject=message=>Object.assign(new Error(message),{status:409});
export function createWorkerRunner({directory,workerId,tenantId,productApiUrl,secret,execute,isolation=null,isolationCheck=null,heartbeatMs=15000}) {
 const active=new Map(),tails=new Map();let dispatchTail=Promise.resolve();
 const file=job=>join(directory,job.engineId+'.json');
 async function read(job){try{return JSON.parse(await readFile(file(job),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function save(record){await mkdir(directory,{recursive:true,mode:0o700});const target=file(record.job),temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(record),{mode:0o600});await rename(temp,target);}
 function checked(job){validateJob(job);if(job.workerId!==workerId || job.tenantId!==tenantId || createHash('sha256').update(JSON.stringify({type:'send_message',text:job.text})).digest('hex')!==job.payloadHash)throw reject('Job identity or payload mismatch');}
 const client=job=>createProductClient({baseUrl:productApiUrl,secret,workerId,tenantId,projectId:job.projectId,operationId:job.operationId,leaseId:job.leaseId,generation:job.generation});
 async function flush(record){for(const event of record.events){if(event.sequence<=record.acknowledged)continue;try{await client(record.job).recordEvent(event);record.acknowledged=event.sequence;await save(record);}catch(error){if([403,410].includes(error.status)){record.invalidated=true;record.state='uncertain';active.get(record.job.engineId)?.control?.cancel?.();await save(record);}return;}}}
 function serial(job,fn){const prev=tails.get(job.engineId)||Promise.resolve();const next=prev.catch(()=>{}).then(fn);tails.set(job.engineId,next);return next.finally(()=>{if(tails.get(job.engineId)===next)tails.delete(job.engineId);});}
 const event=(record,type,extra={})=>serial(record.job,async()=>{
  const e={protocolVersion:1,engineId:record.job.engineId,eventId:'evt_'+randomUUID().replaceAll('-',''),sequence:record.events.length+1,type,...extra};
  record.events.push(e);record.state=type==='heartbeat'?record.state:type==='started'?'running':type;await save(record);await flush(record);return e;
 });
 async function dispatch(job){checked(job);
  const old=await read(job);if(old){if(!sameExecution(old.job,job))throw reject('Execution identity changed');return {accepted:true,engineId:job.engineId,state:active.has(job.engineId)?old.state:WORKER_TERMINAL.includes(old.state)?old.state:'uncertain'};}
  if(active.size)throw reject('Worker busy');if(Date.parse(job.deadline)<=Date.now())throw reject('Job expired');
  // Persist acceptance before any engine side effect. A lost acknowledgement is observable.
  const record={job,state:'accepted',events:[],acknowledged:0,stopRequested:false};await save(record);
  const entry={record,control:null,promise:null};active.set(job.engineId,entry);
  await event(record,'started');
  let timer,deadlineTimer;entry.promise=(async()=>{
   deadlineTimer=setTimeout(()=>{record.invalidated=true;record.state='uncertain';entry.control?.cancel?.();void save(record);},Math.max(1,Date.parse(job.deadline)-Date.now()));deadlineTimer.unref?.();
   timer=setInterval(()=>void event(record,'heartbeat').catch(()=>{}),heartbeatMs);timer.unref?.();
   try{
    const result=await execute({job,client:client(job),onControl:control=>{entry.control=control;if(record.stopRequested || record.invalidated)control.cancel?.();}});
    clearInterval(timer);
    if(record.invalidated || result?.status==='uncertain' || !['completed','cancelled','failed'].includes(result?.status)){await serial(job,async()=>{record.state='uncertain';await save(record);});return;}
    const artifactIds=[];
    // Artifact bytes are validated by the product API before a terminal success receipt.
    if(result.status==='completed' && !record.stopRequested && result.artifacts?.length){const artifacts=await client(job).registerArtifacts(result.artifacts);artifactIds.push(...artifacts.map(a=>a.id));}
    if(record.stopRequested && result.status==='completed'){record.state='uncertain';await save(record);return;}
    const expected={completed:'completed',cancelled:'aborted',failed:'failed'}[result.status];
    if(result.reason?.kind!==expected){record.state='uncertain';await save(record);return;}
    await event(record,result.status,{endReason:expected,artifactIds,text:String(result.text || '').slice(0,16000)});
   }catch{clearInterval(timer);await serial(job,async()=>{if(!WORKER_TERMINAL.includes(record.state))record.state='uncertain';await save(record);});}
   finally{clearInterval(timer);clearTimeout(deadlineTimer);active.delete(job.engineId);}
  })();
  return {accepted:true,engineId:job.engineId,state:'running'};
 }
 async function observe(job){checked(job);const entry=active.get(job.engineId),record=entry?.record || await read(job);if(!record || !sameExecution(record.job,job))throw reject('Unknown execution');return {engineId:job.engineId,state:entry?record.state:WORKER_TERMINAL.includes(record.state)?record.state:'uncertain',events:record.events};}
 async function stop(job){checked(job);const entry=active.get(job.engineId);if(!entry)return observe(job);
  if(!sameExecution(entry.record.job,job))throw reject('Execution identity changed');entry.record.stopRequested=true;await save(entry.record);entry.control?.cancel?.();
  let timeout;try{await Promise.race([entry.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Engine stop receipt timeout')),15000);})]);}finally{clearTimeout(timeout);}
  return observe(job);
 }
 return {dispatch:job=>{const next=dispatchTail.catch(()=>{}).then(()=>dispatch(job));dispatchTail=next;return next;},observe,stop,async health(){let checked=isolation;if(isolationCheck)try{checked=await isolationCheck();}catch{checked=null;}return {...this.capabilities,isolation:checked};},capabilities:{protocolVersion:1,workerId,isolation,questions:true,approvals:true,nativeStop:true},async close(){for(const entry of active.values())entry.control?.cancel?.();await Promise.allSettled([...active.values()].map(e=>e.promise));}};
}
