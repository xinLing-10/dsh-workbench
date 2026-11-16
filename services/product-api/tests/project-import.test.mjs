import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,realpath} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';import {createTenant} from '../src/auth.mjs';import {saveSources} from '../src/project-sources.mjs';import {importProjectFiles} from '../src/project-import.mjs';
test('project imports require consent and source versions; preserve directory tree and reject overwrites',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'project-import-'))),db=openDatabase(join(root,'db.sqlite')),tenant=createTenant(db),directory=join(root,'prj_a');await mkdir(directory);t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const at=new Date().toISOString();db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('prj_a',tenant.id,'虚构项目','ws_a',at,at);
 const files=saveSources(db,'prj_a',[{path:'sample/src/app.ts',content:'export const version = 1;'}]),input={db,projectId:'prj_a',directory,files,consent:true};
 assert.throws(()=>importProjectFiles({...input,consent:false}),/授权/);assert.throws(()=>importProjectFiles({...input,files:[{...files[0],sha256:'bad'}]}),/版本/);
 const first=importProjectFiles(input);assert.equal(first.replayed,false);assert.equal(await readFile(join(directory,'imported-project/sample/src/app.ts'),'utf8'),'export const version = 1;');assert.equal(importProjectFiles(input).replayed,true);
 await writeFile(join(directory,'imported-project/sample/src/app.ts'),'changed');assert.throws(()=>importProjectFiles(input),/已修改/);
});
test('import cannot target another project source, active operation, or a symlink workspace',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'project-import-boundary-'))),db=openDatabase(join(root,'db.sqlite')),tenant=createTenant(db),directory=join(root,'prj_a');await mkdir(directory);t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});const at=new Date().toISOString();
 for(const id of ['prj_a','prj_b'])db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,tenant.id,id,id,at,at);
 const files=saveSources(db,'prj_a',[{path:'readme.md',content:'fictional'}]);assert.throws(()=>importProjectFiles({db,projectId:'prj_b',directory,files,consent:true}),/版本/);
 db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at) VALUES(?,?,?,'send_message','req_a','hash','waiting',?,?)").run('op_a',tenant.id,'prj_a',at,at);
 assert.throws(()=>importProjectFiles({db,projectId:'prj_a',directory,files,consent:true}),/任务/);db.prepare("UPDATE operations SET state='cancelled'").run();await symlink(directory,join(root,'link'));assert.throws(()=>importProjectFiles({db,projectId:'prj_a',directory:join(root,'link'),files,consent:true}),/路径/);
});

import {createServer} from 'node:http';import {createApp} from '../src/app.mjs';import {createInvite} from '../src/auth.mjs';
test('HTTP folder import enforces session, CSRF, tenant and explicit copy consent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'project-import-http-')),db=openDatabase(join(root,'db.sqlite')),workspaceRoot=join(root,'workspaces');await mkdir(workspaceRoot);
 const app=createApp({db,config:{workspaceRoot,maxBodyBytes:65536,allowRedeem:true,sessionTtlMs:60000},bridge:{capabilities:()=>({})}}),server=createServer((q,r)=>app.handle(q,r));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));app.managerCore.dispose();db.close();await rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;let cookie='',csrf='',projectId='';
 async function call(method,path,body,{noCsrf=false}={}){const r=await fetch(base+'/api/v1'+path,{method,headers:{cookie,origin:base,'content-type':'application/json',...(!noCsrf?{'x-csrf-token':csrf}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,...await r.json()};}
 for(const [index,email] of [[1,'first@example.test'],[2,'second@example.test']]){
 const tenant=createTenant(db),invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});await call('POST','/invitations/redeem',{email,token:invite.token,password:'Synthetic-2026!'});csrf=(await call('GET','/me')).data.csrfToken;
 if(index===1){const project=(await call('POST','/projects',{name:'虚构待修改项目'})).data.project;await mkdir(join(workspaceRoot,project.id));projectId=project.id;
 const path='/projects/'+project.id+'/sources';const files=(await call('POST',path,{files:[{path:'sample/app.js',content:'export const version=1;'}]})).data.files;
 assert.equal((await call('POST',path+'/import-workspace',{consent:true,files},{noCsrf:true})).status,403);
 assert.equal((await call('POST',path+'/import-workspace',{consent:false,files})).status,409);
 const result=await call('POST',path+'/import-workspace',{consent:true,files});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.data.directory,'imported-project');
 assert.equal(db.prepare("SELECT count(*) n FROM project_events WHERE project_id=? AND type='project_imported'").get(project.id).n,1);
 }else assert.equal((await call('POST','/projects/'+projectId+'/sources/import-workspace',{consent:true,files:[]})).status,404);
 }

});
