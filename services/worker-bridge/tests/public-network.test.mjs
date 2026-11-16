import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {mkdtemp,mkdir,readFile,rm,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {publicAddress,publicUrl,publicGet,createPublicNetwork,citeSources} from '../lib/public-network.mjs';
import {validateWorkerEvent} from '../../../packages/manager-contracts/worker.mjs';
test('public network refuses internal, mapped, reserved and credential-bearing targets',()=>{
 for(const address of ['127.0.0.1','10.0.0.2','172.16.0.1','192.168.1.1','169.254.169.254','100.100.100.200','168.63.129.16','198.18.0.1','203.0.113.1','::1','fe80::1','fc00::1','::ffff:8.8.8.8','2002:0808:0808::1','2001:db8::1','2001:0db8::1'])assert.equal(publicAddress(address),false,address);
 for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(publicAddress(address),true,address);
 for(const url of ['http://example.com','https://localhost/','https://127.1/','https://[::1]/','https://user:secret@example.com','https://example.com:444/','https://example.com/?token=sensitive'])assert.throws(()=>publicUrl(url));
});
function requestFactory(responses,seen){return (url,options,cb)=>{const req=new EventEmitter();req.end=()=>{options.lookup(url.hostname,{},(e,address,family)=>seen.push({url:url.href,address,family}));const res=new EventEmitter();Object.assign(res,responses.shift());res.resume=()=>{};res.destroy=()=>{};queueMicrotask(()=>{cb(res);if(res.statusCode===200){res.emit('data',Buffer.from(res.body||'sample'));res.emit('end');}});};return req;};}
test('broker pins DNS and revalidates every redirect; mixed public/private DNS fails closed',async()=>{
 const seen=[],request=requestFactory([{statusCode:302,headers:{location:'https://169.254.169.254/latest'}},{statusCode:200,headers:{}}],seen);
 await assert.rejects(()=>publicGet('https://example.com',{resolve:async()=>[{address:'8.8.8.8',family:4}],request}),/公网/);assert.equal(seen.length,1);assert.equal(seen[0].address,'8.8.8.8');
 await assert.rejects(()=>publicGet('https://example.com',{resolve:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request}),/内网/);
 await assert.rejects(()=>publicGet('https://registry.npmjs.org/file.tgz',{allowedHosts:['registry.npmjs.org'],resolve:async()=>[{address:'8.8.8.8',family:4}],request:requestFactory([{statusCode:302,headers:{location:'https://example.com/file.tgz'}}],[])}),/依赖文件源/);
});
test('bounded responses, cancellation and failed reads do not become citations',async()=>{
 const opts={resolve:async()=>[{address:'8.8.8.8',family:4}]};await assert.rejects(()=>publicGet('https://example.com',{...opts,maxBytes:3,request:requestFactory([{statusCode:200,headers:{},body:'too long'}],[])}),/大小/);
 const c=new AbortController();c.abort();await assert.rejects(()=>publicGet('https://example.com',{signal:c.signal}));
 const service=createPublicNetwork({enabled:true,get:async()=>({bytes:Buffer.from('<html><title>Guide</title><script>bad()</script><p>Useful text</p></html>'),url:'https://example.com/guide',type:'text/html'})});
 const page=await service.read('https://example.com/guide');assert.equal(page.title,'Guide');assert.ok(!page.text.includes('bad()'));assert.match(page.sha256,/^[a-f0-9]{64}$/);
 const failed=createPublicNetwork({enabled:true,get:async()=>{throw Error('Disconnected');}});await assert.rejects(()=>failed.read('https://example.com'));await assert.rejects(()=>createPublicNetwork().read('https://example.com'),/未启用/);
 const raw=JSON.stringify({documents:[{name:'需求.md',markdown:'# 需求'}],summary:'草稿'});assert.match(JSON.parse(citeSources(raw,[page])).documents[0].markdown,/内容来源/);
 const manager=JSON.stringify({version:2,blocks:[{type:'summary',text:'方案'}]});assert.equal(citeSources(manager,[page]),manager,'never corrupt structured replies');
});
test('dependency download verifies fixed source and digest, rejects symlinks; no installation occurs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'network-package-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'prj_a'));const bytes=Buffer.from('fictional archive, never executed'),hash=createHash('sha256').update(bytes).digest('hex');let requests=0;
 const service=createPublicNetwork({enabled:true,workspaceRoot:root,get:async(url)=>{requests++;return {bytes,url,type:'application/octet-stream'};}});
 await assert.rejects(()=>service.download({projectId:'prj_a',url:'https://evil.example/file.tgz',sha256:hash}));assert.equal(requests,0);
 await assert.rejects(()=>service.download({projectId:'prj_a',url:'https://registry.npmjs.org/pkg/-/pkg-1.0.tgz',sha256:'0'.repeat(64)}),/不一致/);
 const result=await service.download({projectId:'prj_a',url:'https://registry.npmjs.org/pkg/-/pkg-1.0.tgz',sha256:hash});assert.deepEqual(await readFile(join(root,'prj_a',result.path)),bytes);assert.match(result.note,/未解压/);
 await mkdir(join(root,'prj_b'));await symlink(join(root,'prj_a','manager-downloads'),join(root,'prj_b','manager-downloads'));await assert.rejects(()=>service.download({projectId:'prj_b',url:'https://registry.npmjs.org/pkg/-/pkg-1.0.tgz',sha256:hash}),/异常/);
});
test('source receipts reject malformed or executable links',()=>{
 const base={protocolVersion:1,engineId:'eng_a',eventId:'evt_a',sequence:1,type:'completed',endReason:'completed',artifactIds:[]};
 assert.throws(()=>validateWorkerEvent({...base,sources:[{url:'javascript:alert(1)',title:'fake',sha256:'a'.repeat(64),fetchedAt:new Date().toISOString()}]}));
});
import {createIsolatedRuntime} from '../lib/isolated-runtime.mjs';
function wire(name,input){return [{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'tool_'+name,name,input:{}}},{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(input)}},{type:'message_delta',delta:{stop_reason:'tool_use'}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');}
const done=[{type:'content_block_start',index:0,content_block:{type:'text',text:'# 虚构答复\n这是推断，资料见[1]。'}},{type:'message_delta',delta:{stop_reason:'end_turn'}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('');
async function runtimeFixture(t,allow,tool,input){const root=await mkdtemp(join(tmpdir(),'network-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'prj_a'));let calls=0,networkReads=0;const interactions=[];const page={title:'虚构参考',url:'https://example.com/guide',sha256:'a'.repeat(64),fetchedAt:new Date().toISOString(),text:'Untrusted page text'};
 const runtime=createIsolatedRuntime({sandbox:{close(){}},model:'fictional',workspaceRoot:root,network:{enabled:true,read:async()=>{networkReads++;return page;}}});
 const result=await runtime.execute({job:{projectId:'prj_a',engineId:'eng_a',text:'虚构需求'},onControl:()=>{},client:{modelMessage:async()=>({record:{status:calls++?'completed':'tool_requested'},wire:calls===1?wire(tool,input):done}),createInteraction:async q=>{interactions.push(q);return{id:'int_a'};},waitAnswer:async()=>({answer:allow})}});
 return {result,networkReads,interactions};}
test('network reads require explicit permission; genuine provenance accompanies completed receipt',async t=>{
 const denied=await runtimeFixture(t,'deny','read_public_web',{url:'https://example.com/guide'});assert.equal(denied.networkReads,0);assert.deepEqual(denied.result.sources,[]);
 const allowed=await runtimeFixture(t,'allow','read_public_web',{url:'https://example.com/guide'});assert.equal(allowed.networkReads,1);assert.equal(allowed.result.sources[0].title,'虚构参考');assert.equal(allowed.interactions[0].scope,'read_public_web');assert.equal(allowed.result.status,'completed');
});
test('isolated Worker sends grouped questions and forwards selected/custom answers in one turn',async t=>{
 const q=[{id:'user',question:'谁先使用？',options:[{label:'店主（推荐）'},{label:'顾客'}]},{id:'scope',question:'首期范围？',options:[{label:'预约（推荐）'},{label:'预约和支付'}]}];
 const f=await runtimeFixture(t,{answers:[{id:'user',selected:['店主（推荐）'],custom:'两个人使用'},{id:'scope',selected:['预约（推荐）']}]},'ask_user_question',{questions:q});
 assert.equal(f.interactions.length,1);assert.equal(f.interactions[0].questions.length,2);assert.equal(f.result.status,'completed');
});
test('a reused model tool id cannot reuse an already granted one-time permission',async()=>{
 let modelCalls=0,permissions=0,reads=0;const runtime=createIsolatedRuntime({sandbox:{close(){}},model:'fixture',workspaceRoot:'/tmp',network:{enabled:true,read:async()=>{reads++;return {url:'https://example.com',title:'sample',sha256:'a'.repeat(64),fetchedAt:new Date().toISOString(),text:'sample'};}}});
 const result=await runtime.execute({job:{text:'fictional',projectId:'prj_a'},onControl:()=>{},client:{modelMessage:async()=>{modelCalls++;return {record:{status:'tool_requested'},wire:wire('read_public_web',{url:'https://example.com'})};},createInteraction:async()=>{permissions++;return{id:'int_a'};},waitAnswer:async()=>({answer:'allow'})}});
 assert.equal(result.status,'failed');assert.equal(modelCalls,2);assert.equal(permissions,1);assert.equal(reads,1);
});
