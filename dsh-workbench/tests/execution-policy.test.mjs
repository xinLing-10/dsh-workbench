import { __test as host } from '../index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { executionPolicy } from '../execution-policy.js';
import { buildContext } from '../knowledge.js';

test('execution rejects plugin roots, children, parents and symlink aliases',async()=>{
 const base=await mkdtemp(join(tmpdir(),'dsh-policy-'));
 try{
  const plugin=join(base,'plugins');await mkdir(join(plugin,'docs'),{recursive:true});
  const alias=join(base,'alias');await symlink(plugin,alias);
  for(const root of [plugin,join(plugin,'docs'),base,alias]){
   await assert.rejects(executionPolicy(root,[plugin]),/禁止启动 Agent/);
  }
  const project=join(base,'business');await mkdir(project);
  const prompt=await executionPolicy(project,[plugin]);
  assert.match(prompt,/不得修改、删除、移动、覆盖/);assert.match(prompt,/插件故障/);
  assert.ok(prompt.includes(project));assert.ok(prompt.includes(plugin));
 }finally{await rm(base,{recursive:true,force:true});}
});

test('versioned task context cannot launch execution against the plugin itself',async()=>{
 const bundle=dirname(dirname(fileURLToPath(import.meta.url)));
 await assert.rejects(buildContext(bundle,'blocked',{},'spec'),/禁止启动 Agent/);
});


test('Host rejects a protected execution request before creating board state',async()=>{
 const bundle=dirname(dirname(fileURLToPath(import.meta.url)));
 let payload='';const res={writeHead(code){this.statusCode=code;},end(body){payload=body;},setHeader(){}};
 const req={method:'POST',url:'/workbench/context',headers:{'x-workbench-root':encodeURIComponent(bundle)}};
 await host.contextHandler({get:()=>({defaultDirectory:bundle})},()=>false)(req,res);
 assert.equal(res.statusCode,409);assert.match(JSON.parse(payload).message,/禁止启动 Agent/);
});
