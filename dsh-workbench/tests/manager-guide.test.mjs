import test from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {__test as host} from '../index.js';
async function call(method='GET',deny=false){
 const chunks=[],headers={};const res=new Writable({write(chunk,enc,next){chunks.push(Buffer.from(chunk));next();}});res.setHeader=(k,v)=>headers[k]=v;const done=new Promise(r=>res.on('finish',r));
 const handler=host.guideHandler((req,res)=>{if(!deny)return false;res.statusCode=401;res.end();return true;});
 await handler({method,url:'/workbench/guide?path=/etc/passwd'},res);await done;
 return {status:res.statusCode,headers,text:Buffer.concat(chunks).toString()};
}
test('bundled guide is authenticated, self-contained and ignores arbitrary path parameters',async()=>{
 const result=await call();assert.equal(result.status,200);assert.ok(result.text.includes('项目管家使用手册'));assert.ok(result.text.includes('data:image/png;base64,'));assert.equal(result.headers['x-content-type-options'],'nosniff');assert.ok(!result.text.includes('root:x:'));
 assert.equal((await call('GET',true)).status,401);assert.equal((await call('POST')).status,405);assert.equal((await call('HEAD')).text,'');
});
