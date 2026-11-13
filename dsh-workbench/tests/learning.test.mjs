import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {learningSources,learningContext,learningPrompt,learningReply} from '../learning.js';
const root=await mkdtemp(join(tmpdir(),'dsh-learning-'));
test.after(()=>rm(root,{recursive:true,force:true}));
test('catalog and selected context exclude hidden, credentials, dependencies and symlinks',async()=>{
 await writeFile(join(root,'README.md'),'# 预约工具\n用户可以预约。');
 await writeFile(join(root,'.env'),'DO_NOT_SEND=secret');
 await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','dep.js'),'dependency');
 await symlink('/etc/passwd',join(root,'alias.txt'));
 await writeFile(join(root,'config.json'),'"api_key": "sk-example0123456789012345"');
 const catalog=await learningSources(root,'test');
 assert.ok(catalog.files.includes('README.md'));assert.ok(!catalog.files.some(p=>/alias|node_modules|env/.test(p)));
 for(const path of ['../README.md','.env','/etc/passwd','node_modules/dep.js','alias.txt'])await assert.rejects(learningContext(root,'test',[path]));
 const context=await learningContext(root,'test',['config.json','README.md']);
 assert.equal(context.sources.length,1);assert.equal(context.sources[0].path,'README.md');assert.equal(context.gaps.length,1);
 assert.match(context.sources[0].text,/1: # 预约工具/);assert.equal(context.sources[0].hash.length,64);
});
test('context is bounded, tracks changes and names missing evidence',async()=>{
 await writeFile(join(root,'large.js'),Array.from({length:1000},(_,i)=>`const item${i} = ${i};`).join('\n'));
 const c=await learningContext(root,'test',['large.js','missing.md']);
 assert.ok(c.sources[0].truncated);assert.ok(c.sources[0].text.length<16000);assert.ok(c.gaps.some(g=>g.includes('missing.md')));
 const before=c.sources[0].hash;await writeFile(join(root,'large.js'),'changed');
 assert.notEqual((await learningContext(root,'test',['large.js'])).sources[0].hash,before);
 assert.ok((await learningContext(root,'test',[])).gaps.length);
 await assert.rejects(learningContext(root,'test',Array(13).fill('README.md')));
});
test('tutor prompt distinguishes evidence from inference and rejects impossible citation ranges',()=>{
 const c={sources:[{id:'S1',path:'README.md',lines:3}],gaps:[]};
 const prompt=learningPrompt([], '原理导读', c);assert.match(prompt,/不执行任何工具/);assert.match(prompt,/历史回答不是本轮事实依据/);
 const reply=learningReply(JSON.stringify({reply:'事实 [S1:L1-L3]；伪造 [S2:L1]；越界 [S1:L2-L20]',proposal:{stage:'build',instruction:'修改代码'}}),c);
 assert.match(reply.text,/\[S1:L1-L3\]/);assert.equal(reply.text.match(/引用超出/g).length,2);assert.equal(reply.proposal,undefined);
});
