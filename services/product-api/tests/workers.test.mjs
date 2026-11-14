import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {openDatabase} from '../src/db.mjs';
import {registerWorker,acquireLease,revokeLease,disableWorker,authenticateWorker} from '../src/workers.mjs';
import {createApp} from '../src/app.mjs';
import {createBridge} from '../src/bridge.mjs';
import {bodyDigest,signToken} from '../../../packages/manager-contracts/tokens.mjs';
const secret='worker-one-secret-with-at-least-32-characters';
function fixture(){
  const db=openDatabase(':memory:');
  for(const t of ['ten_a','ten_b'])db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(t,t,new Date().toISOString());
  for(const [p,t] of [['prj_a','ten_a'],['prj_a2','ten_a'],['prj_b','ten_b']])db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(p,t,p,p,'2026-01-01','2026-01-01');
  registerWorker(db,{workerId:'wrk_a',tenantId:'ten_a',secret});
  return db;
}
function claims(lease,extra={}){return {aud:'product-api',sub:lease.workerId,tenantId:lease.tenantId,projectId:lease.projectId,operationId:lease.operationId,leaseId:lease.id,generation:lease.generation,jti:randomUUID(),...extra};}
function signed(lease,method,target,body,extra={}){return signToken(claims(lease,{method,target,...(body===undefined?{}:{body:bodyDigest(body)}),...extra}),secret);}
test('one active operation per worker; revocation increments the fencing generation',()=>{
  const db=fixture();try{
    const first=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a',operationId:'op_1'});
    assert.throws(()=>acquireLease(db,{workerId:'wrk_a',projectId:'prj_a2',operationId:'op_2'}));
    revokeLease(db,first.id);
    const second=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a',operationId:'op_2'});
    assert.equal(second.generation,first.generation+1);
    const target='/internal/v1/interactions';
    assert.equal(authenticateWorker(db,{method:'POST',url:target,headers:{authorization:'Bearer '+signed(first,'POST',target,{})}},{}),'lease');
    assert.throws(()=>acquireLease(db,{workerId:'wrk_a',projectId:'prj_b'}));
  }finally{db.close();}
});
test('internal tokens bind method, complete target, body and single-use nonce',()=>{
  const db=fixture();try{
    const lease=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'});
    const path='/internal/v1/interactions';const body={projectId:'prj_a'};const token=signed(lease,'POST',path,body);
    const req={method:'POST',url:path,headers:{authorization:'Bearer '+token}};
    assert.equal(authenticateWorker(db,{...req,method:'GET'},body),'target');
    assert.equal(authenticateWorker(db,{...req,url:path+'?changed=1'},body),'target');
    assert.equal(authenticateWorker(db,req,{projectId:'prj_a2'}),'digest');
    assert.equal(authenticateWorker(db,req,body).projectId,'prj_a');
    assert.equal(authenticateWorker(db,req,body),'replay');
  }finally{db.close();}
});
test('expired leases, disabled workers, incorrect identity and inflated scope are denied',()=>{
  const db=fixture();try{
    const lease=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'});
    const req=(extra={})=>({method:'POST',url:'/internal/v1/interactions',headers:{authorization:'Bearer '+signed(lease,'POST','/internal/v1/interactions',{},extra)}});
    assert.equal(authenticateWorker(db,req({projectId:'prj_a2'}),{}),'lease');
    assert.equal(authenticateWorker(db,req({tenantId:'ten_b'}),{}),'lease');
    assert.equal(authenticateWorker(db,req({operationId:'op_other'}),{}),'lease');
    assert.equal(authenticateWorker(db,req({sub:'unregistered'}),{}),'signature');
    db.prepare("UPDATE worker_leases SET expires_at='2000-01-01' WHERE id=?").run(lease.id);
    assert.equal(authenticateWorker(db,req(),{}),'lease');
    const next=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'});
    assert.ok(next.generation>lease.generation);
    disableWorker(db,'wrk_a');
    assert.equal(authenticateWorker(db,{method:'POST',url:'/internal/v1/interactions',headers:{authorization:'Bearer '+signed(next,'POST','/internal/v1/interactions',{})}},{}),'signature');
    assert.throws(()=>acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'}));
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit_events').all()).includes(secret),false);
  }finally{db.close();}
});
test('a credential from another registered worker cannot sign this identity',()=>{
  const db=fixture();try{
    const lease=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'});
    const token=signToken(claims(lease,{method:'GET',target:'/internal/test'}),'different-worker-secret-with-32-characters');
    assert.equal(authenticateWorker(db,{method:'GET',url:'/internal/test',headers:{authorization:'Bearer '+token}}),'signature');
  }finally{db.close();}
});
test('resource checks prevent same-tenant project substitution and revoked polls stop',async()=>{
  const db=fixture();const config={maxBodyBytes:65536};const app=createApp({db,config,bridge:createBridge({config})});
  const server=createServer((req,res)=>app.handle(req,res));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const lease=acquireLease(db,{workerId:'wrk_a',projectId:'prj_a'});
  const call=(method,path,body)=>fetch(base+path,{method,headers:{authorization:'Bearer '+signed(lease,method,path,body),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    assert.equal((await call('POST','/internal/v1/projects/prj_a2/artifacts',{items:[]})).status,404);
    assert.equal((await call('POST','/internal/v1/interactions',{projectId:'prj_a2',kind:'question',prompt:'foreign'})).status,403);
    const created=await (await call('POST','/internal/v1/interactions',{projectId:'prj_a',operationId:'',kind:'question',prompt:'demo'})).json();
    const id=created.data.interactionId;
    const waiting=call('GET',`/internal/v1/interactions/${id}/answer?waitMs=3000`);
    await new Promise(r=>setTimeout(r,100));revokeLease(db,lease.id);
    assert.equal((await waiting).status,403);
    assert.equal((await call('POST',`/internal/v1/interactions/${id}/cancel`,{})).status,403);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
});
