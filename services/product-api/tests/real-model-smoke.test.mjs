import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';
import{runSmokeOnce}from'../src/real-model-smoke.mjs';
const stream=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream','x-request-id':'fake-unit-request'}});
const events=[{type:'message_start',message:{id:'fake-unit-message',model:'unit-model',usage:{input_tokens:12}}},{type:'content_block_delta',delta:{type:'text_delta',text:'已收到个人博客真实模型测试。'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:8}},{type:'message_stop'}];
async function directory(){return mkdtemp(join(tmpdir(),'smoke-unit-'));}
test('smoke enforces one request, 1000 tokens, no tools, no redirects and no persisted credential',async()=>{
 const dir=await directory();let calls=0;const secret='synthetic-unit-token';
 const fetchImpl=async(url,init)=>{calls++;assert.equal(url,'https://api.deepseek.com/anthropic/v1/messages');assert.equal(init.redirect,'error');const body=JSON.parse(init.body);assert.equal(body.max_tokens,1000);assert.equal(body.tools,undefined);assert.equal(body.thinking.type,'disabled');return stream(events);};
 try{const result=await runSmokeOnce({directory:dir,model:'unit-model',resolveToken:async()=>secret,fetchImpl});assert.equal(result.status,'passed');assert.equal(result.transport,'injected-test');assert.equal(result.usage.output_tokens,8);assert.equal((await readFile(join(dir,'result.json'),'utf8')).includes(secret),false);await assert.rejects(runSmokeOnce({directory:dir,model:'unit-model',resolveToken:async()=>secret,fetchImpl}),{code:'EEXIST'});assert.equal(calls,1);}finally{await rm(dir,{recursive:true,force:true});}
});
test('unknown delivery is retained without retry',async()=>{
 const dir=await directory();let calls=0;try{const result=await runSmokeOnce({directory:dir,model:'unit-model',resolveToken:async()=>'synthetic-unit-token',fetchImpl:async()=>{calls++;throw Error('offline unit transport');}});assert.equal(result.status,'unknown');assert.equal(result.attempts,1);assert.equal(calls,1);assert.equal(result.cost,null);}finally{await rm(dir,{recursive:true,force:true});}
});
test('unexpected tool blocks never execute and require review',async()=>{
 const dir=await directory();try{const result=await runSmokeOnce({directory:dir,model:'unit-model',resolveToken:async()=>'synthetic-unit-token',fetchImpl:async()=>stream([...events.slice(0,1),{type:'content_block_start',content_block:{type:'tool_use',name:'ignored'}},...events.slice(1)])});assert.equal(result.status,'needs_review');assert.equal(result.toolBlocks,1);}finally{await rm(dir,{recursive:true,force:true});}
});
test('missing account authentication sends no request',async()=>{
 const dir=await directory();let calls=0;try{const result=await runSmokeOnce({directory:dir,model:'unit-model',resolveToken:async()=>undefined,fetchImpl:async()=>{calls++;return stream(events);}});assert.equal(result.status,'not_sent');assert.equal(result.attempts,0);assert.equal(calls,0);}finally{await rm(dir,{recursive:true,force:true});}
});
