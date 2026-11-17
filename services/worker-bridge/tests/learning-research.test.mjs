import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createIsolatedRuntime} from '../lib/isolated-runtime.mjs';
import {validateJob,sameExecution} from '../lib/worker-contract.mjs';
const tool=(name,input,id)=>[{type:'content_block_start',index:0,content_block:{type:'tool_use',name,id,input}},{type:'message_delta',delta:{stop_reason:'tool_use'}}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('');
const done=[{type:'content_block_start',index:0,content_block:{type:'text',text:JSON.stringify({version:2,blocks:[{type:'summary',text:'虚构学习目录'}],proposal:null})}},{type:'message_delta',delta:{stop_reason:'end_turn'}}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('');
async function fixture(t,{deny,enabled=true,empty=false,error=false,ignoreChoice=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'learning-research-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'prj_a'));let searches=0,reads=0,calls=0;const decisions=[],choices=[];
 const runtime=createIsolatedRuntime({model:'fixture',workspaceRoot:dir,sandbox:{},network:{enabled,search:async()=>{searches++;if(error)throw Error('Synthetic outage');return {results:empty?[]:[{title:'可靠虚构教材',url:'https://example.com/guide'}]};},read:async()=>{reads++;return {title:'可靠虚构教材',url:'https://example.com/guide',sha256:'a'.repeat(64),fetchedAt:new Date().toISOString(),text:'额外领域知识'};}}});
 const result=await runtime.execute({job:{engineId:'eng_a',projectId:'prj_a',text:'制定学习计划和测试题',learning:{action:'plan',research:true}},onControl:()=>{},client:{
 modelMessage:async({body})=>{calls++;assert.ok(body.tools.every(t=>!['run_project_command','download_project_dependency'].includes(t.name)));choices.push(body.tool_choice);const name=ignoreChoice?null:body.tool_choice.type==='tool'?body.tool_choice.name:null;return {record:{status:name?'tool_requested':'completed'},wire:name?tool(name,name==='search_public_web'?{query:'公开领域基础'}:{url:'https://example.com/guide'},'tool_'+calls):done};},
 createInteraction:async q=>{decisions.push(q);return {id:q.scope};},waitAnswer:async id=>({answer:deny===id?'deny':'allow'})
 }});return {result,searches,reads,calls,decisions,choices};
}
test('a learning plan proactively searches then reads with separate explicit approvals',async t=>{
 const f=await fixture(t);assert.equal(f.result.status,'completed');assert.equal(f.searches,1);assert.equal(f.reads,1);assert.equal(f.calls,3);assert.deepEqual(f.decisions.map(q=>q.scope),['search_public_web','read_public_web']);assert.equal(f.result.sources.length,1);assert.equal(JSON.parse(f.result.text).version,2);
});
test('denied search never accesses the network and marks the plan preliminary',async t=>{
 const f=await fixture(t,{deny:'search_public_web'});assert.equal(f.searches,0);assert.equal(f.reads,0);assert.equal(f.calls,2);assert.match(JSON.parse(f.result.text).blocks[0].text,/未授权/);assert.deepEqual(f.result.sources,[]);
});
test('denied reading cannot convert search results into verified citations',async t=>{
 const f=await fixture(t,{deny:'read_public_web'});assert.equal(f.searches,1);assert.equal(f.reads,0);assert.equal(f.result.sources.length,0);assert.match(f.result.text,/初步版本/);
});
test('search failure, no hits and disabled network have bounded honest fallbacks',async t=>{
 for(const options of [{error:true},{empty:true},{enabled:false}]){const f=await fixture(t,options);assert.equal(f.result.status,'completed');assert.ok(f.calls<=2);assert.match(f.result.text,/初步版本/);assert.equal(f.reads,0);}
});
test('a provider ignoring mandatory research is not represented as successful research',async t=>{
 const f=await fixture(t,{ignoreChoice:true});assert.equal(f.result.status,'failed');assert.equal(f.searches,0);assert.equal(f.reads,0);
});
test('learning metadata is bounded and is part of execution replay identity',()=>{
 const job={protocolVersion:1,workerId:'wrk_a',tenantId:'ten_a',projectId:'prj_a',operationId:'op_a',leaseId:'lease_a',engineId:'eng_a',generation:1,payloadHash:'a'.repeat(64),text:'synthetic',deadline:new Date().toISOString(),learning:{action:'plan',research:true}};assert.equal(validateJob(job),job);assert.equal(sameExecution(job,{...job,learning:{action:'plan',research:false}}),false);assert.throws(()=>validateJob({...job,learning:{action:'plan',research:true,query:'untrusted'}}));
});
