/** Disposable, synthetic UI fixture. No Worker, credentials or provider calls. */
import {createServer} from 'node:http';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp,appendEvent} from '../src/app.mjs';
import {createTenant,createInvite,redeemInvite} from '../src/auth.mjs';
if(!process.argv.includes('--fixture'))throw Error('Explicit --fixture required');
const directory=await mkdtemp(join(tmpdir(),'manager-style-fixture-')),db=openDatabase(join(directory,'product.sqlite'));
const tenant=createTenant(db,{name:'样式验证：虚构租户'}),invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});
const user=await redeemInvite(db,{token:invite.token,email:'ui-fixture@local.test',password:'Fixture-Style-2026!'});
const at=new Date().toISOString();
for(const [id,name]of [['prj_style','小店预约 · 产品计划'],['prj_empty','我的新想法'],['prj_question','小店预约 · 回答问题'],['prj_permission','小店预约 · 操作许可']])db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,tenant.id,name,id,at,at);
const add=(projectId,type,text)=>appendEvent(db,{tenantId:tenant.id,projectId,type,payload:{text}});
const messages=[['message_created','我想为自己的理发店做一个预约工具，让客人不用打电话就能预约。但我不懂开发，应该从哪里开始？'],['message_completed','我们可以先从一个简单、实用的版本开始。你不需要先学会写代码，我会陪你把想法一步步变成清晰的方案。\n\n## 先解决最重要的一件事\n让客人能**选服务、选时间、留下联系方式**，店主能查看当天预约。\n\n- **客人预约**：选择服务与时间，填写姓名和电话。\n- **店主管理**：查看当天安排，确认或取消预约。\n- **暂时不做**：在线支付、会员积分，先把基础流程做好。\n\n> 先做好一个小而完整的流程，再根据真实使用情况增加功能。\n\n我把这些内容整理成了一份需求草稿，你可以从右上角的“我的成果”打开阅读。'],['message_created','这个范围很合适。请把预约取消规则也考虑进去。'],['message_completed','好的，已把取消规则加入需求草稿。\n\n**建议规则**：客人可以提前 2 小时取消，临近预约时联系店主处理。这样既方便客人，也给店里留出安排时间。\n\n接下来，请打开**我的成果**阅读草稿。如果有不合适的地方，直接告诉我；确认后我们再一起讨论页面和操作流程。\n\n*本页内容为界面演示，未调用模型。*']];
for(const [type,text]of messages)add('prj_style',type,text);
for(const [version,text]of [[1,'# 小店预约需求草稿\n\n界面演示文档，未调用模型。\n\n客人选择服务、选择时间、填写联系方式；店主查看预约。'],[2,'# 小店预约需求草稿\n\n界面演示文档，未调用模型。\n\n一、服务对象\n第一次使用线上预约的顾客和店主。\n\n二、核心流程\n选择服务 → 选择时间 → 填写联系方式 → 店主确认。\n\n三、取消规则\n顾客可提前 2 小时取消，临近预约时联系店主。\n\n四、本轮暂不包含\n在线支付、会员积分。']]){const id='art_style_'+version,bytes=Buffer.from(text);db.prepare('INSERT INTO artifact_index VALUES(?,?,?,?,?,?,0,?)').run(id,tenant.id,'prj_style','小店预约需求草稿.md',createHash('sha256').update(bytes).digest('hex'),version,at);db.prepare('INSERT INTO artifact_contents VALUES(?,?,NULL,NULL,NULL)').run(id,bytes);}
for(const [project,kind]of [['prj_question','question'],['prj_permission','permission']]){
 add(project,'message_created','我想做一个简单的预约工具，请先帮助我整理需求。');
 add(project,'message_completed','开始前，先一起确认这一步。下面是界面演示，不会调用真实模型或执行命令。');
 const questions=kind==='question'?[{id:'audience',question:'这个工具主要给谁使用？',options:['附近的老顾客','第一次到店的新顾客'],multiSelect:true}]:[];
 db.prepare("INSERT INTO interaction_requests(id,tenant_id,project_id,kind,prompt,state,created_at,expires_at,questions_json) VALUES(?,?,?,?,?,'pending',?,?,?)").run('int_style_'+kind,tenant.id,project,kind,kind==='question'?'先告诉我，你更希望帮助谁？':'是否允许整理本项目的需求草稿？本示例只验证许可卡片。',at,new Date(Date.now()+86400000).toISOString(),JSON.stringify(questions));
}
const workspaceRoot=join(directory,'workspaces');await mkdir(workspaceRoot);
const port=8098,config={port,maxBodyBytes:65536,publicOrigin:'http://localhost:'+port,workspaceRoot,sessionTtlMs:86400000};
const app=createApp({db,config,bridge:{capabilities:()=>({bridge:false,simulation:true})}});
const server=createServer((req,res)=>void app.handle(req,res));server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:config.publicOrigin,fixture:true,modelCalls:0})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{app.managerCore.dispose();db.close();process.exit(0);}));
