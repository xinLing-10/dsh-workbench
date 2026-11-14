import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as core from './index.mjs';

test('every legacy business entry is the same implementation, not a second copy',async()=>{
  for(const name of await readdir(new URL('../../dsh-workbench/core/',import.meta.url))) {
    if(!name.endsWith('.js') || ['index.js','project-state.js','document-policy.js','board-records.js'].includes(name))continue;
    const canonical=await import('../../dsh-workbench/core/'+name);
    const legacy=await import('../../dsh-workbench/'+name);
    for(const key of Object.keys(canonical))assert.strictEqual(legacy[key],canonical[key],name+':'+key);
    const source=await readFile(new URL('../../dsh-workbench/'+name,import.meta.url),'utf8');
    assert.equal(source.trim().split('\n').length,2);
  }
});
test('project defaults are fresh and shared across adapters',()=>{
  const a=core.createProjectState(),b=core.createProjectState();a.stageData.build.confirmations[0].done=true;
  assert.equal(b.stageData.build.confirmations[0].done,false);assert.equal(b.version,3);
});
test('document acceptance requires current content and current version',()=>{
  const hash='a'.repeat(64);
  assert.doesNotThrow(()=>core.assertCurrentDocument({latestId:'v2',documentId:'v2',currentHash:hash,expectedHash:hash}));
  assert.throws(()=>core.assertCurrentDocument({latestId:'v2',documentId:'v1',currentHash:hash,expectedHash:hash}));
  assert.throws(()=>core.assertCurrentDocument({latestId:'v2',documentId:'v2',currentHash:hash,expectedHash:'b'.repeat(64)}));
});
test('packed plugin imports its shared kernel without the monorepo facade',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'manager-core-pack-'));
  try {
    const bundle=new URL('../../dsh-workbench/',import.meta.url).pathname;
    const meta=JSON.parse(execFileSync('npm',['pack','--ignore-scripts','--json','--pack-destination',dir],{cwd:bundle,encoding:'utf8'}))[0];
    execFileSync('tar',['-xzf',join(dir,meta.filename),'-C',dir]);
    execFileSync('ln',['-s',join(bundle,'node_modules'),join(dir,'package/node_modules')]);
    execFileSync(process.execPath,['--input-type=module','-e',`const c=await import(${JSON.stringify('file://'+join(dir,'package/core/index.js'))}); if(c.CORE_VERSION!=='1.0.0')process.exit(1); const h=await import(${JSON.stringify('file://'+join(dir,'package/index.js'))});`]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('successful request replay remains valid when a runtime policy later becomes unavailable',async()=>{
  const root=await mkdtemp(join(tmpdir(),'manager-core-replay-'));const id='board_replay';let blocked=false;
  const state=core.createProjectState();
  await core.documents.initializeArtifacts(root,id,state);
  const service=core.createProjectServices({adapter:()=>null,saveState:async()=>{},saveRegistry:async()=>{},beforeMutate:()=>{if(blocked)throw new Error('Runtime unavailable');}}).tasks;
  const body={action:'configure',requestId:'replay-request-001',revision:0,mode:'requirements',goal:'虚构项目'};
  try{
    const first=await service.mutate(root,id,state,body);blocked=true;
    const replay=await service.mutate(root,id,state,body);assert.equal(replay.revision,first.revision);
    await assert.rejects(service.mutate(root,id,state,{...body,requestId:'fresh-request-001',revision:replay.revision}),/Runtime unavailable/);
  }finally{service.dispose();await rm(root,{recursive:true,force:true});}
});
