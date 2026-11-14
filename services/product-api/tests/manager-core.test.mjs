import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/app.mjs';
import {createBridge} from '../src/bridge.mjs';
import {createTenant,createInvite} from '../src/auth.mjs';
import {knowledgeView} from '../../../dsh-workbench/knowledge.js';
import {createManagerService} from '../../../dsh-workbench/manager.js';
import {__test as pluginHost} from '../../../dsh-workbench/index.js';
const PREFIX='/api/v1';
async function fixture(t,{runtime=null}={}) {
  const directory=await mkdtemp(join(tmpdir(),'product-manager-core-'));
  const db=openDatabase(join(directory,'api.sqlite'));
  const config={workspaceRoot:join(directory,'projects'),allowRedeem:true,maxBodyBytes:65536,sessionTtlMs:60000,inviteTtlMs:60000,publicOrigin:'',cookieSecure:false};
  await mkdir(config.workspaceRoot);
  const app=createApp({db,config,bridge:createBridge({config}),managerRuntime:runtime});
  const server=createServer((req,res)=>void app.handle(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;config.publicOrigin=base;
  t.after(async()=>{app.managerCore.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();await rm(directory,{recursive:true,force:true});});
  async function user(email) {
    let cookie='',csrf='';
    async function call(method,path,body,options={}) {
      const response=await fetch(base+PREFIX+path,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'&&!options.noCsrf?{'x-csrf-token':csrf}:{}),...(body?{'content-type':'application/json'}:{}),...options.headers},body:body?JSON.stringify(body):undefined});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      return {status:response.status,...await response.json()};
    }
    const invite=createInvite(db,{tenantId:createTenant(db).id,ttlMs:60000});
    assert.equal((await call('POST','/invitations/redeem',{token:invite.token,email,password:'Synthetic-2026!'})).status,201);
    csrf=(await call('GET','/me')).data.csrfToken;
    return {call};
  }
  const a=await user('a@example.test');
  const project=(await a.call('POST','/projects',{name:'虚构项目'})).data.project;
  const root=join(config.workspaceRoot,project.id);await mkdir(root);
  const path='/projects/'+project.id;
  return {a,user,db,app,project,root,path,config,base};
}
const action=(action,revision=0,extra={})=>({action,revision,requestId:randomUUID(),...extra});

test('all shared POST routes reject missing CSRF; other tenants and anonymous cannot read or write',async t=>{
  const f=await fixture(t);const b=await f.user('b@example.test');
  for(const suffix of ['/manager/actions','/knowledge','/document-review/comments','/learning/context','/learning/actions']) {
    assert.equal((await f.a.call('POST',f.path+suffix,{}, {noCsrf:true})).status,403,suffix);
    assert.equal((await b.call('POST',f.path+suffix,{})).status,404,suffix);
  }
  for(const suffix of ['/manager','/knowledge','/learning','/learning/sources','/document-review?name=x'])
    assert.equal((await b.call('GET',f.path+suffix)).status,404,suffix);
  const anonymous=await fetch(f.base+PREFIX+f.path+'/manager');assert.equal(anonymous.status,401);
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',{}, {headers:{origin:'https://other.example'}})).status,403);
});
test('task contract and idempotency use the same durable manager record as the plugin',async t=>{
  const f=await fixture(t);const body=action('configure',0,{mode:'requirements',goal:'整理虚构小店需求',root:'/etc',boardId:'untrusted'});
  const first=await f.a.call('POST',f.path+'/manager/actions',body);assert.equal(first.status,200);
  const replay=await f.a.call('POST',f.path+'/manager/actions',body);assert.equal(replay.data.manager.revision,1);
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'design',goal:'过期'}))).status,409);
  const persisted=JSON.parse(await readFile(join(f.root,'.dsh/workbench/changes',f.project.id,'manager.json')));
  assert.equal(persisted.contract.goal,body.goal);assert.equal(persisted.boardId,f.project.id);
  const stages=JSON.parse(await readFile(join(f.root,'.dsh/workbench/boards',f.project.id+'.json')));
  const plugin=createManagerService({adapter:()=>null});
  const view=await plugin.view(f.root,f.project.id,stages);plugin.dispose();
  assert.equal(view.contract.id,first.data.manager.contract.id);assert.equal(view.revision,1);
  const roster=await pluginHost.ensureBoardIndex(f.root);assert(roster.boards.some(board=>board.id===f.project.id));
  assert.equal((await pluginHost.readBoard(f.root,f.project.id)).project.goal,body.goal);
  const unavailable=await f.a.call('POST',f.path+'/manager/actions',action('message',1,{text:'开始'}));assert.equal(unavailable.status,409);
  assert.equal((await f.a.call('GET',f.path+'/manager')).data.manager.jobs.length,0);
});
test('knowledge writes, source extraction, revisions and search are shared with original plugin',async t=>{
  const f=await fixture(t);await f.a.call('GET',f.path+'/manager');
  const added=await f.a.call('POST',f.path+'/knowledge',{action:'upsert',revision:0,node:{id:'FR-001',type:'FR',title:'预约',body:'支持预约',status:'draft'}});assert.equal(added.status,200);
  const wrong=await f.a.call('POST',f.path+'/knowledge',{action:'upsert',revision:0,node:{id:'FR-002'}});assert.equal(wrong.status,409);
  const stages=JSON.parse(await readFile(join(f.root,'.dsh/workbench/boards',f.project.id+'.json')));
  const plugin=await knowledgeView(f.root,f.project.id,stages,{q:'预约'});
  const web=await f.a.call('GET',f.path+'/knowledge?q='+encodeURIComponent('预约'));
  assert.deepEqual(web.data.nodes,plugin.nodes);assert.equal(web.data.revision,1);
});
test('learning source fences, progress and memory setting persist through the same service',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'README.md'),'# 虚构项目\n用于教学。');await writeFile(join(f.root,'.env'),'SECRET=never-send');
  const sources=await f.a.call('GET',f.path+'/learning/sources');assert.equal(sources.status,200);assert(sources.data.files.includes('README.md'));assert(!sources.data.files.includes('.env'));
  const context=await f.a.call('POST',f.path+'/learning/context',{paths:['README.md']});assert.equal(context.data.sources[0].id,'S1');
  assert.equal((await f.a.call('POST',f.path+'/learning/context',{paths:['../outside.md']})).status,409);
  const enabled=await f.a.call('POST',f.path+'/learning/actions',action('learning-memory-setting',0,{enabled:false}));assert.equal(enabled.status,200);
  assert.equal((await f.a.call('GET',f.path+'/learning')).data.learning.memoryEnabled,false);
  assert.equal((await f.a.call('POST',f.path+'/learning/actions',action('configure',1))).status,409);
  const before=await readFile(join(f.root,'README.md'),'utf8');
  assert.equal((await f.a.call('POST',f.path+'/learning/actions',action('learning-progress',1,{planId:'missing',lessonId:'missing',status:'self-checked'}))).status,409);
  assert.equal(await readFile(join(f.root,'README.md'),'utf8'),before);
});
test('concurrent revisions serialize and survive a new API instance without copying business state',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'requirements',goal:'一'})),f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'design',goal:'二'}))]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const second=createApp({db:f.db,config:f.config,bridge:createBridge({config:f.config})});
  try {assert.equal((await second.managerCore.view(f.db.prepare('SELECT * FROM projects WHERE id=?').get(f.project.id))).revision,1);}finally{second.managerCore.dispose();}
});
test('project directory symlinks are rejected without writing outside the workspace',async t=>{
  const f=await fixture(t);await rm(f.root,{recursive:true});await symlink(tmpdir(),f.root);
  assert.equal((await f.a.call('GET',f.path+'/manager')).status,400);
});

test('shared supervisor completes a task with an injected fixture adapter and restores without re-submitting',async t=>{
  const submits=[];const adapter={create:async body=>body.id,submit:async body=>{submits.push(body);},read:async()=>({terminal:true,reason:'completed',text:JSON.stringify({reply:'这是隔离执行夹具回复。',proposal:null})}),cancel:async()=>{}};
  const f=await fixture(t,{runtime:{adapter}});
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'requirements',goal:'虚构需求'}))).status,200);
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('message',1,{text:'请解释'}))).status,200);
  await f.app.managerCore.tick();await f.app.managerCore.tick();
  const view=(await f.a.call('GET',f.path+'/manager')).data.manager;
  assert.equal(submits.length,1);assert.equal(view.jobs[0].status,'completed');assert(view.messages.some(m=>m.text.includes('隔离执行夹具')));
  const resumed=createApp({db:f.db,config:f.config,bridge:createBridge({config:f.config}),managerRuntime:{adapter}});
  try{await resumed.managerCore.restore();await resumed.managerCore.tick();assert.equal(submits.length,1);}finally{resumed.managerCore.dispose();}
});
test('document review comments gate stage acceptance and edited source invalidates the same receipt',async t=>{
  const f=await fixture(t);await f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'requirements',goal:'虚构需求'}));
  const dir=join(f.root,'.dsh/workbench/changes',f.project.id,'documents');
  for(const name of ['需求分析阶段.md','需求交接.md','需求分析阶段.docx'])await writeFile(join(dir,name),'# 虚构需求\n\nFR-001 预约');
  const review=await f.a.call('GET',f.path+'/document-review?name='+encodeURIComponent('需求分析阶段.md'));assert.equal(review.status,200);
  const comment=await f.a.call('POST',f.path+'/document-review/comments',{action:'add',name:'需求分析阶段.md',contentHash:review.data.contentHash,anchor:{startLine:1,endLine:1,quote:'# 虚构需求'},text:'需要补充'});assert.equal(comment.status,200);
  let manager=(await f.a.call('GET',f.path+'/manager')).data.manager;
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('approve',manager.revision,{stage:'spec',reviewed:true,hashes:manager.review.stages.spec.hashes}))).status,409);
  assert.equal((await f.a.call('POST',f.path+'/document-review/comments',{action:'resolve',id:comment.data.id,revision:1})).status,200);
  assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('approve',manager.revision,{stage:'spec',reviewed:true,hashes:{}}))).status,409);
  const approved=await f.a.call('POST',f.path+'/manager/actions',action('approve',manager.revision,{stage:'spec',reviewed:true,hashes:manager.review.stages.spec.hashes}));assert.equal(approved.status,200);assert.equal(approved.data.manager.complete,true);
  await writeFile(join(dir,'需求分析阶段.md'),'# 已修改需求');
  manager=(await f.a.call('GET',f.path+'/manager')).data.manager;assert.equal(manager.complete,false);assert.equal(manager.nextStage,'spec');
  const stage=JSON.parse(await readFile(join(f.root,'.dsh/workbench/boards',f.project.id+'.json')));assert.equal(stage.stageData.spec.confirmed,false);assert.equal(stage.stageData.spec.needsReview,true);
});

test('learning plans run through the shared supervisor and progress cannot be promoted without reflection',async t=>{
  const raw=JSON.stringify({reply:'隔离计划夹具，不是实际模型教学。',proposal:null,plan:{title:'理解虚构项目',map:['产品用途'],lessons:[1,2,3].map(n=>({title:'第'+n+'课',objective:'解释产品用途',minutes:10,sourceIds:['S1'],question:'它解决什么问题？'}))}});
  const adapter={create:async b=>b.id,submit:async()=>{},read:async()=>({terminal:true,reason:'completed',text:raw}),cancel:async()=>{}};
  const f=await fixture(t,{runtime:{adapter}});await writeFile(join(f.root,'README.md'),'# 虚构产品\n记录预约。');
  assert.equal((await f.a.call('POST',f.path+'/learning/actions',action('learning-plan',0,{level:'zero',minutes:20,goal:'理解项目',paths:['README.md']}))).status,200);
  await f.app.managerCore.tick();await f.app.managerCore.tick();
  let manager=(await f.a.call('GET',f.path+'/manager')).data.manager;
  const plan=manager.learning.plan;assert.equal(plan.lessons.length,3);assert.equal(plan.evidence.sources[0].path,'README.md');
  const mark=(status,revision)=>action('learning-progress',revision,{planId:plan.id,lessonId:plan.lessons[0].id,status});
  assert.equal((await f.a.call('POST',f.path+'/learning/actions',mark('self-checked',manager.revision))).status,409);
  assert.equal((await f.a.call('POST',f.path+'/learning/actions',mark('read',manager.revision))).status,200);
  const record=JSON.parse(await readFile(join(f.root,'.dsh/workbench/changes',f.project.id,'manager.json')));
  assert.equal(record.learning.plan.lessons[0].status,'read');
});

test('invalid inherited mode names cannot persist a broken business contract',async t=>{
  const f=await fixture(t);
  for(const mode of ['constructor','__proto__','invalid'])assert.equal((await f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode,goal:'虚构需求'}))).status,409);
  assert.equal((await f.a.call('GET',f.path+'/manager')).data.manager.contract,null);
});
test('damaged stage records are preserved and supervisor rechecks server-side board bindings',async t=>{
  const submits=[];const adapter={create:async b=>b.id,submit:async b=>submits.push(b),read:async()=>({terminal:false}),cancel:async()=>{}};
  const f=await fixture(t,{runtime:{adapter}});
  await f.a.call('POST',f.path+'/manager/actions',action('configure',0,{mode:'requirements',goal:'虚构需求'}));
  await f.a.call('POST',f.path+'/manager/actions',action('message',1,{text:'提问'}));
  f.db.prepare('UPDATE projects SET board_id=? WHERE id=?').run('changed_board',f.project.id);
  await f.app.managerCore.tick();assert.equal(submits.length,0);
  f.db.prepare('UPDATE projects SET board_id=NULL WHERE id=?').run(f.project.id);
  const file=join(f.root,'.dsh/workbench/boards',f.project.id+'.json');await writeFile(file,'{');
  assert.equal((await f.a.call('GET',f.path+'/manager')).status,409);assert.equal(await readFile(file,'utf8'),'{');
});
