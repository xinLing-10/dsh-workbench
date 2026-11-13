import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPractice,openPractice,savePractice,practiceContext} from '../learning-practice.js';
import {parseMaterials,learningDocuments,offlineLearningHtml} from '../learning-materials.js';
const root=await mkdtemp(join(tmpdir(),'dsh-practice-'));
test.after(()=>rm(root,{recursive:true,force:true}));
test('practice creation requires explicit confirmation and copies only selected safe files',async()=>{
 await writeFile(join(root,'app.js'),'export const message = "hello";');
 await assert.rejects(createPractice(root,'test',{paths:['app.js']}),/确认/);
 const practice=await createPractice(root,'test',{confirmed:true,paths:['app.js']});assert.equal(practice.files.length,1);
 assert.ok(practice.files[0].path.startsWith('.dsh/workbench/changes/test/learning/practices/'));
 assert.equal(await readFile(join(root,practice.files[0].path),'utf8'),'export const message = "hello";');
});
test('practice editing leaves source intact and rejects stale hashes, other paths and secrets',async()=>{
 const practice=await createPractice(root,'test',{confirmed:true,paths:['app.js']}),learning={practice};
 const body={practiceId:practice.id,path:'app.js'},opened=await openPractice(root,learning,body);
 await assert.rejects(savePractice(root,learning,{...body,baseHash:'old',content:'bad'}),/已变化/);
 await assert.rejects(openPractice(root,learning,{...body,path:'../app.js'}),/清单/);
 await assert.rejects(savePractice(root,learning,{...body,baseHash:opened.hash,content:'api_key="sk-example0123456789012345"'}),/凭据/);
 const saved=await savePractice(root,learning,{...body,baseHash:opened.hash,content:'export const message = "你好";'});
 assert.notEqual(saved.hash,opened.hash);assert.equal(await readFile(join(root,'app.js'),'utf8'),'export const message = "hello";');
 const context=await practiceContext(root,learning,body);assert.match(context.sources[0].path,/学习副本/);assert.match(context.gaps[0],/没有执行代码/);
});
test('materials reject fabricated source IDs and offline HTML escapes raw HTML without loading images',()=>{
 const evidence={sources:[{id:'S1'}]};
 const raw={materials:{overview:'# 项目导读\n\n页面提交预约 [S1:L1]。',glossary:[{term:'接口',meaning:'两个模块沟通的约定',sourceIds:['S1']}]}};
 assert.equal(parseMaterials(JSON.stringify(raw),evidence).glossary[0].term,'接口');
 raw.materials.glossary[0].sourceIds=['S99'];assert.throws(()=>parseMaterials(JSON.stringify(raw),evidence));
 const html=offlineLearningHtml('<script>alert(1)</script>\n\n![image](https://example.org/image.png)');
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes("default-src 'none'"));
});
test('learning documents explicitly distinguish self assessment from execution and export no editor source',()=>{
 const entries=learningDocuments({messages:[{role:'user',time:'now',text:'什么是页面？'}],editor:{content:'PRIVATE_SOURCE_NOT_FOR_EXPORT'}});
 assert.equal(entries.length,5);assert.ok(!JSON.stringify(entries).includes('PRIVATE_SOURCE_NOT_FOR_EXPORT'));
 assert.ok(JSON.stringify(entries).includes('没有自动执行代码'));
});
