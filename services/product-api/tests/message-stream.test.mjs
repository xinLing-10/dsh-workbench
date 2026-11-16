
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openBudget} from '../src/model-budget.mjs';
import {openDatabase} from '../src/db.mjs';
import {budgetedMessage} from '../src/budgeted-model.mjs';
import {createMessageStream,streamMessages} from '../src/message-stream.mjs';
import {appendEvent} from '../src/app.mjs';
const body={model:'unit',max_tokens:100,stream:true,thinking:{type:'disabled'},messages:[{role:'user',content:'fictional'}]};
const frame=e=>'data: '+JSON.stringify(e)+'\r\n\r\n';
const start={type:'message_start',message:{id:'synthetic',usage:{input_tokens:5}}};
const delta=text=>({type:'content_block_delta',delta:{type:'text_delta',text}});
const end=[{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
function ledger(t){const dir=mkdtempSync(join(tmpdir(),'incremental-test-')),b=openBudget(join(dir,'budget.sqlite'));t.after(()=>{b.close();rmSync(dir,{recursive:true,force:true});});return b;}
test('text arrives before provider completion; split UTF8 and CRLF parse without duplication or private tool JSON',async t=>{
 const b=ledger(t);let controller,preview='',notify;const first=new Promise(r=>notify=r);let calls=0;
 const prefix=[start,delta('你好🙂'),{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning'}},{type:'content_block_delta',delta:{type:'input_json_delta',partial_json:'private tool JSON'}}].map(frame).join('');
 const pending=budgetedMessage({budget:b,body,id:'incremental',resolveToken:async()=>'synthetic',onText:text=>{preview+=text;notify();},fetchImpl:async()=>{calls++;return new Response(new ReadableStream({start(c){controller=c;const bytes=new TextEncoder().encode(prefix);for(const byte of bytes)c.enqueue(Uint8Array.of(byte));}}));}});
 await first;assert.equal(preview,'你好🙂');assert.ok(b.snapshot().held>0);assert.equal(b.snapshot().used,31);
 controller.enqueue(new TextEncoder().encode([delta('世界'),...end].map(frame).join('')));controller.close();
 const result=await pending;assert.equal(result.record.status,'completed');assert.equal(preview,'你好🙂世界');assert.equal(calls,1);assert.equal(b.snapshot().held,0);assert.equal(b.snapshot().used,38);
});
test('provider truncation keeps known usage and unknown hold, never fabricates completion or retries',async t=>{
 const b=ledger(t);let text='',calls=0;
 const result=await budgetedMessage({budget:b,body,id:'partial',resolveToken:async()=>'synthetic',onText:d=>text+=d,fetchImpl:async()=>{calls++;return new Response(frame(start)+frame(delta('未完成'))+'data: {"type":');}});
 assert.equal(text,'未完成');assert.equal(result.record.status,'unknown');assert.equal(result.record.complete,false);assert.equal(b.snapshot().frozen,true);assert.ok(b.snapshot().held>0);assert.equal(calls,1);
});
test('preview observer failure does not interrupt billing settlement',async t=>{
 const b=ledger(t);const result=await budgetedMessage({budget:b,body,id:'observer',resolveToken:async()=>'synthetic',onText:()=>{throw Error('view disconnected');},fetchImpl:async()=>new Response([start,delta('text'),...end].map(frame).join(''))});
 assert.equal(result.record.status,'completed');assert.equal(result.record.previewUnavailable,true);assert.equal(b.snapshot().held,0);
});
test('durable latest preview survives reopen, cancellation is incomplete, final receipt replaces preview',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'snapshot-test-')),path=join(dir,'db.sqlite');let db=openDatabase(path);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 db.prepare('INSERT INTO tenants VALUES(?,?,?)').run('ten','fixture','now');
 db.prepare('INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('prj','ten','fixture','prj','now','now');
 db.prepare("INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at) VALUES('op','ten','prj','send_message','req','h','running','now','now')").run();
 const run={tenant_id:'ten',project_id:'prj',operation_id:'op'};let allowed=true;const published=[];
 const observer=createMessageStream({db,run,requestId:'call',append:appendEvent,publish:e=>published.push(e),authorize:()=>{if(!allowed)throw Error('revoked');}});
 observer.text('第一段');observer.text('第二段');observer.close();assert.equal(published.length,2);assert.equal(streamMessages(db,'prj').length,1);
 assert.equal(streamMessages(db,'other').length,0);db.close();db=openDatabase(path);assert.equal(streamMessages(db,'prj')[0].text,'第一段第二段');
 const cursor=published[0].id;assert.equal(db.prepare('SELECT count(*) n FROM project_events WHERE id>?').get(cursor).n,1);
 db.prepare("UPDATE operations SET state='cancelled' WHERE id='op'").run();assert.equal(streamMessages(db,'prj')[0].streamState,'interrupted');
 appendEvent(db,{tenantId:'ten',projectId:'prj',operationId:'op',type:'message_completed',payload:{text:'final'}});assert.deepEqual(streamMessages(db,'prj'),[]);
 const revoked=createMessageStream({db,run,requestId:'call2',append:appendEvent,publish:e=>published.push(e),authorize:()=>{if(!allowed)throw Error('revoked');}});allowed=false;revoked.text('hidden');revoked.close();assert.equal(published.length,2);
});
