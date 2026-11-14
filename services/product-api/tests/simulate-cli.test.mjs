import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../src/db.mjs';
import {registerWorker} from '../src/workers.mjs';
import {appendEvent} from '../src/app.mjs';
const run=promisify(execFile);
test('simulation runner requires opt-in and processes durable queued messages only once',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'simulation-cli-'));const path=join(dir,'db.sqlite');let db=openDatabase(path);
 try{
 db.exec("INSERT INTO tenants VALUES('ten_cli','demo','2026-01-01'); INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES('prj_cli','ten_cli','demo','ws','2026-01-01','2026-01-01'); INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at) VALUES('op_cli','ten_cli','prj_cli','send_message','req-cli-demo','hash','queued','2026-01-01','2026-01-01'); INSERT INTO operation_outbox(operation_id,event,next_at,created_at) VALUES('op_cli','dispatch','2026-01-01','2026-01-01')");
 registerWorker(db,{workerId:'wrk_cli',tenantId:'ten_cli',secret:'simulation-cli-worker-secret-32-characters'});
 appendEvent(db,{tenantId:'ten_cli',projectId:'prj_cli',type:'message_created',operationId:'op_cli',payload:{text:'演示'}});db.close();db=null;
 const cli=(enabled,...args)=>run(process.execPath,[fileURLToPath(new URL('../simulate.mjs',import.meta.url)),...args],{env:{...process.env,PRODUCT_API_DB:path,PRODUCT_API_SIMULATE:enabled?'1':'0'}});
 await assert.rejects(cli(false));
 assert.equal(JSON.parse((await cli(true,'--recover')).stdout).states[0].state,'queued');
 assert.equal(JSON.parse((await cli(true)).stdout).states[0].state,'completed');
 await cli(true);db=openDatabase(path);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM simulation_receipts').get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type='message_completed'").get().n,1);
 }finally{db?.close();await rm(dir,{recursive:true,force:true});}
});
