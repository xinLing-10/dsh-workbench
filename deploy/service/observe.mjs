/** Read-only server soak monitor. One sample per invocation; no provider requests. */
import {DatabaseSync} from 'node:sqlite';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {readFile,writeFile,appendFile,stat,chmod,mkdir} from 'node:fs/promises';import {dirname,resolve} from 'node:path';import {freemem,totalmem,loadavg} from 'node:os';import {pathToFileURL} from 'node:url';
import {createWorkerTransport} from '../../services/product-api/src/worker-transport.mjs';
const exec=promisify(execFile);
const local=url=>{const u=new URL(url);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.hash||u.search)throw Error('Observe only configured loopback services');return u;};
export function evaluate(samples,{hours=24,intervalSec=60,maxGapSec=180,expectNoModelCalls=false}={}){
 if(!Number.isFinite(hours)||hours<=0||!Number.isInteger(intervalSec)||intervalSec<1||!Number.isInteger(maxGapSec)||maxGapSec<intervalSec)throw Error('Invalid observation thresholds');
 const valid=samples.every(s=>s&&Number.isFinite(Date.parse(s.at))&&typeof s.healthy==='boolean');if(!valid)throw Error('Invalid sample');
 const ordered=[...samples].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));const elapsedMs=ordered.length>1?Date.parse(ordered.at(-1).at)-Date.parse(ordered[0].at):0;
 let gaps=0;for(let i=1;i<ordered.length;i++)if(Date.parse(ordered[i].at)-Date.parse(ordered[i-1].at)>maxGapSec*1000)gaps++;
 let restarts=0;const baseline=new Map();for(const s of ordered)for(const u of s.units||[]){const old=baseline.get(u.unit);if(old && ((u.restarts??0)!==(old.restarts??0)||(u.started&&old.started&&u.started!==old.started)))restarts++;baseline.set(u.unit,u);}
 const unexpectedRequests=expectNoModelCalls&&ordered.length?Math.max(0,(ordered.at(-1).model?.requests??0)-(ordered[0].model?.requests??0)):0;
 const failures=ordered.filter(s=>!s.healthy).length;const required=Math.ceil(hours*3600/intervalSec)+1;
 return {status:failures||gaps||restarts||unexpectedRequests?'failed':elapsedMs>=hours*3600000&&ordered.length>=required?'passed':'observing',samples:ordered.length,required,elapsedHours:elapsedMs/3600000,failures,gaps,restarts,unexpectedRequests,first:ordered[0]?.at??null,last:ordered.at(-1)?.at??null};
}
export async function sample(config,{fetchImpl=globalThis.fetch,execImpl=exec,system=()=>({freeMb:Math.floor(freemem()/1048576),totalMb:Math.floor(totalmem()/1048576),load1:loadavg()[0]})}={}){
 const record={at:new Date().toISOString(),healthy:false,resources:system(),checks:{}};local(config.healthUrl);local(config.workerUrl);
 if(!Array.isArray(config.units)||config.units.length!==2||config.units.some(u=>!/^manager-acceptance-(api|worker)\.service$/.test(u)))throw Error('Explicit acceptance unit names required');
 try{const response=await fetchImpl(config.healthUrl,{redirect:'error',signal:AbortSignal.timeout(5000)});record.checks.http=response.status===200;const payload=await response.json();record.modelPaused=payload.data?.capabilities?.paused===true;if(config.expectNoModelCalls)record.checks.modelPaused=record.modelPaused;}catch{record.checks.http=false;}
 if(config.removedCredential){try{await stat(config.removedCredential);record.checks.credentialRemoved=false;}catch(e){record.checks.credentialRemoved=e.code==='ENOENT';}}
 record.units=[];for(const unit of config.units)try{const {stdout}=await execImpl('systemctl',['show',unit,'--property=ActiveState,NRestarts,MemoryCurrent,ActiveEnterTimestampMonotonic','--no-pager'],{timeout:5000});const values=Object.fromEntries(stdout.trim().split('\n').map(s=>s.split('=')));record.units.push({unit,active:values.ActiveState==='active',restarts:Number(values.NRestarts)||0,memoryBytes:Number(values.MemoryCurrent)||0,started:values.ActiveEnterTimestampMonotonic});}catch{record.units.push({unit,active:false});}
 let db;try{db=new DatabaseSync(config.db,{readOnly:true});db.exec('PRAGMA busy_timeout=3000');
  const worker=db.prepare("SELECT * FROM workers WHERE id=? AND status='active'").get(config.workerId);record.checks.worker=Boolean(worker&&await createWorkerTransport({url:config.workerUrl,workerId:worker.id,secret:worker.secret}).handshake(worker.id));
  record.model=db.prepare("SELECT count(*) requests,COALESCE(SUM(CASE WHEN state='settled' THEN actual ELSE 0 END),0) used,COALESCE(SUM(CASE WHEN state!='settled' THEN MAX(reservation,COALESCE(actual,0)) ELSE 0 END),0) held,COALESCE(SUM(CASE WHEN state='unknown' THEN 1 ELSE 0 END),0) unknown FROM service_model_calls").get();
  record.operations=db.prepare("SELECT count(*) total,COALESCE(SUM(CASE WHEN state='uncertain' THEN 1 ELSE 0 END),0) uncertain FROM worker_executions").get();record.checks.database=true;
 }catch{record.checks.database=false;}finally{db?.close();}
 record.healthy=Object.values(record.checks).every(Boolean)&&record.units.every(u=>u.active)&&record.resources.freeMb>=(config.minFreeMb??100)&&record.model?.unknown===0&&record.operations?.uncertain===0;
 await mkdir(dirname(config.samples),{recursive:true,mode:0o700});await appendFile(config.samples,JSON.stringify(record)+'\n',{mode:0o600});await chmod(config.samples,0o600);return record;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const [command,file]=process.argv.slice(2);if((await stat(file)).mode&0o077)throw Error('Monitor config must be private');const config=JSON.parse(await readFile(file,'utf8'));if(command==='sample'){const r=await sample(config);console.log(JSON.stringify(r));if(!r.healthy)process.exitCode=1;}else if(command==='report'){const records=(await readFile(config.samples,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));const result=evaluate(records,config);await writeFile(config.report,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));if(result.status==='failed')process.exitCode=1;}else throw Error('Use sample|report <private-config.json>');}catch(e){console.error(e.message);process.exitCode=1;}
}
