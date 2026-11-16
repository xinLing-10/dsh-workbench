/** Isolated UI fixture, no Worker/model/production credentials. */
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp,appendEvent} from '../src/app.mjs';
import {createTenant,createInvite,redeemInvite} from '../src/auth.mjs';
import {bindTask} from '../src/business-tasks.mjs';
import {learningCompletion} from '../src/learning-session.mjs';
import {saveSources} from '../src/project-sources.mjs';
if(!process.argv.includes('--fixture'))throw Error('Explicit --fixture required');
const directory=await mkdtemp(join(tmpdir(),'manager-business-fixture-')),db=openDatabase(join(directory,'api.sqlite')),tenant=createTenant(db,{name:'虚构演示空间'}),invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});
const user=await redeemInvite(db,{token:invite.token,email:'business@example.test',password:'Synthetic-Business-2026!'}),at=new Date().toISOString();
db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('prj_business',tenant.id,'虚构演示 · 预约产品','fixture',at,at);const project=db.prepare('SELECT * FROM projects WHERE id=?').get('prj_business');
saveSources(db,project.id,[{path:'src/booking.ts',content:'// 虚构预约功能\nexport function book(time) { return {time,status:"pending"}; }'}]);
for(const [i,kind,title] of [[1,'work','整理预约产品需求'],[2,'learning','学懂预约功能原理']]){const op='op_business_'+i;db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at,actor_user_id) VALUES(?,?,?,'send_message',?,'fixture','completed',?,?,?)").run(op,tenant.id,project.id,op,at,at,user.userId);const task=bindTask(db,project,op,title,{mode:kind,taskId:null,title});
const learning=kind==='learning'?{action:'plan',profile:{goal:'学懂预约流程',level:'zero',minutes:20},evidence:{sources:[{id:'S1',path:'src/booking.ts',hash:'fixture',lines:2}],gaps:[],capturedAt:at}}:null;
appendEvent(db,{tenantId:tenant.id,projectId:project.id,operationId:op,type:'message_created',payload:{text:title,task,learning,context:{refs:[{id:'S1',type:'source',path:'src/booking.ts',startLine:1,endLine:2,sha256:'0'.repeat(64)}],truncated:false}}});
const text=learning?learningCompletion(db,{operation_id:op},{type:'completed',text:JSON.stringify({plan:{title:'零基础预约课程',map:['功能流程','数据','代码'],lessons:['先看预约流程','理解数据和状态','读懂一段代码'].map(title=>({title,objective:'能用自己的话说明这一环节如何工作',minutes:15,sourceIds:['S1'],question:'请说说你的理解。'}))}})}):'# 预约需求说明\n\n这是虚构界面演示，未调用模型。\n\n用户选择时间，再提交预约；店主查看预约状态。';
appendEvent(db,{tenantId:tenant.id,projectId:project.id,operationId:op,type:'message_completed',payload:{text,fixture:true}});const bytes=Buffer.from(text);db.prepare('INSERT INTO artifact_index VALUES(?,?,?,?,?,?,?,?)').run('art_business_'+i,tenant.id,project.id,title+'.md',createHash('sha256').update(bytes).digest('hex'),1,0,at);db.prepare('INSERT INTO artifact_contents VALUES(?,?,?,?,?)').run('art_business_'+i,bytes,null,op,null);}
const port=8166,app=createApp({db,config:{maxBodyBytes:65536,sessionTtlMs:3600000,publicOrigin:''},bridge:{capabilities:()=>({simulation:true,bridge:false,workerProtocol:false})}}),server=createServer((q,r)=>app.handle(q,r));server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({fixture:true,url:'http://127.0.0.1:'+port,projectId:project.id,modelCalls:0})));for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{server.closeAllConnections();server.close(async()=>{app.managerCore.dispose();db.close();await rm(directory,{recursive:true,force:true});process.exit(0);});});
