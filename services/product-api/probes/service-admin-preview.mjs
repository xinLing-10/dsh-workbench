/** Disposable UI fixture; never imports credentials, starts a Worker or calls a provider. */
import {createServer} from 'node:http';import {mkdtemp,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openDatabase} from '../src/db.mjs';import {createApp} from '../src/app.mjs';import {createTenant,createInvite,redeemInvite} from '../src/auth.mjs';import {createServiceBudget} from '../src/service-budget.mjs';
if(!process.argv.includes('--fixture'))throw Error('Explicit --fixture required');
const directory=await mkdtemp(join(tmpdir(),'manager-admin-fixture-')),db=openDatabase(join(directory,'product.sqlite')),tenant=createTenant(db,{name:'离线演示租户'});
const invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000}),user=await redeemInvite(db,{token:invite.token,email:'service-fixture@local.test',password:'Fixture-2026!'});
db.prepare('INSERT INTO platform_admins VALUES(?,?)').run(user.userId,new Date().toISOString());
const at=new Date().toISOString(),projectId='prj_service_fixture';db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(projectId,tenant.id,'离线演示：预算与隔离验证',projectId,at,at);
db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at,actor_user_id) VALUES(?,?,?,'send_message','fixture-request','fixture','uncertain',?,?,?)").run('op_service_fixture',tenant.id,projectId,at,at,user.userId);
const budget=createServiceBudget({db});for(const [scope,scopeId,limit]of [['global','*',200000],['user',user.userId,50000],['project',projectId,30000]])budget.policy(user.userId,{scope,scopeId,limit,window:'month',revision:0,reason:'离线界面演示，非真实模型额度'});
const b=budget.forOperation('op_service_fixture');b.reserve('call_offline_fixture',{model:'fixture',max_tokens:100,stream:true,thinking:{type:'disabled'},messages:[{role:'user',content:'虚构界面示例，不调用模型'}]});b.settle('call_offline_fixture',{complete:false,usage:null,outputLimit:100,evidence:{fixture:true}});
// Synthetic control-plane records only; no engine or provider is started.
for(const [index,state]of ['queued','queued','waiting','completed','completed','cancelled'].entries()){
 const id='op_console_'+index;db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at,actor_user_id) VALUES(?,?,?,'send_message',?,'fixture',?,?,?,?)").run(id,tenant.id,projectId,'fixture-console-'+index,state,at,at,user.userId);
}
for(let day=0;day<7;day++){
 const date=new Date();date.setUTCDate(date.getUTCDate()-day);const when=date.toISOString(),tokens=[4600,2700,6200,3500,1800,4100,2300][day];
 db.prepare(`INSERT INTO service_model_calls(id,operation_id,tenant_id,user_id,project_id,payload_hash,reservation,actual,state,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,'synthetic-ui',?,?,'settled','{"fixture":true}',?,?)`).run('call_console_'+day,'op_console_3',tenant.id,user.userId,projectId,tokens,tokens,when,when);
}
db.prepare("INSERT INTO workers(id,tenant_id,secret,status,generation) VALUES(?,?,?,'active',0)").run('wrk_console_fixture',tenant.id,'synthetic-never-used-worker-secret');
const port=Number(process.env.PRODUCT_API_PREVIEW_PORT||8095);
const workspaceRoot=join(directory,'workspaces');await mkdir(workspaceRoot);const config={port,allowRedeem:process.env.PRODUCT_API_ALLOW_REDEEM==='1',previewFixture:true,formalService:false,maxBodyBytes:65536,publicOrigin:'http://localhost:'+port,workspaceRoot,sessionTtlMs:86400000};
const app=createApp({db,config,bridge:{capabilities:()=>({bridge:false,isolated:false,workerProtocol:false})}});const server=createServer((req,res)=>void app.handle(req,res));server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:config.publicOrigin,fixture:true,directory,modelCalls:0})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{app.managerCore.dispose();db.close();process.exit(0);}));
