/** Only project rows authorized by app.mjs may enter this adapter. */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { createProjectServices, createProjectState, persistBoardRecord, CORE_VERSION } from '../../../packages/manager-core/index.mjs';
import { boardDirectory, managedPath, initializeArtifacts, reconcileArtifacts } from '../../../dsh-workbench/core/artifacts.js';
import { executionPolicy } from '../../../dsh-workbench/core/execution-policy.js';
const unavailable = message => Object.assign(new Error(message), {status:409,code:'capability_unavailable'});
const invalid = message => Object.assign(new Error(message), {status:409,code:'conflict'});

export function createProductManager({db, workspace, runtime = null}) {
  const locks = new Map();
  const adapter = runtime?.adapter && ['create','submit','read','cancel'].every(key=>typeof runtime.adapter[key]==='function') ? runtime.adapter : null;
  // Single process owns a project workspace; this is not a distributed lock.
  async function exclusive(root, action) {
    const previous = locks.get(root) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);locks.set(root,current);
    try {return await current;}finally{if(locks.get(root)===current)locks.delete(root);}
  }
  const boardFile = (root,id) => managedPath(root, `.dsh/workbench/boards/${id}.json`);
  async function assertBinding(root,id) {
    const project=db.prepare('SELECT * FROM projects WHERE id=?').get(basename(root));
    if(!project || (project.board_id || project.id)!==id)throw invalid('项目与需求轮次绑定已变化，请重新打开。');
    if(await workspace.projectDir(project.id)!==root)throw invalid('项目工作区绑定已变化，请重新打开。');
    try{await executionPolicy(root);}catch(error){throw invalid(error.message);}
  }
  async function saveState(root,id,state) {
    await assertBinding(root,id);
    let index;
    try {index=JSON.parse(await readFile(await managedPath(root,'.dsh/workbench/boards.json'),'utf8'));}
    catch(error){if(error.code!=='ENOENT')throw invalid('需求目录记录损坏，已保留原文件，请先修复。');index={version:1,activeId:id,boards:[]};}
    await persistBoardRecord(root,index,id,state);
  }
  async function readState(root,id,projectName='') {
    await assertBinding(root,id);
    let state;
    try {state=JSON.parse(await readFile(await boardFile(root,id),'utf8'));}
    catch(error) {
      if(error instanceof SyntaxError)throw invalid('项目阶段记录损坏，已保留原文件，请先修复。');
      if(error.code!=='ENOENT')throw error;
      state=createProjectState();state.project.name=projectName;state.project.createdAt=new Date().toISOString();
      await initializeArtifacts(root,id,state);await saveState(root,id,state);
    }
    if(state.version!==3 || !state.project || !state.stageSessions || !['spec','design','build','verify','ship'].every(s=>state.stageData?.[s]))
      throw invalid('项目阶段记录不兼容，已保留原文件，请先迁移或修复。');
    const initialized=await initializeArtifacts(root,id,state);
    if(await reconcileArtifacts(root,id,state) || initialized)await saveState(root,id,state);
    return state;
  }
  const services=createProjectServices({
    adapter:()=>adapter, exclusive, readState,saveState,
    // Runtime policy runs after the kernel's replay/revision checks, before mutations.
    beforeMutate:body=>{
      if(body.action==='dispatch' && !runtime?.generateWord)throw unavailable('阶段文档生成适配器未接通');
      if((body.action==='package' || body.action==='learning-export' && body.format==='zip') && !runtime?.zip)throw unavailable('文档导出适配器未接通');
    },
    loadRegistry:async()=>{
      const records=[];
      for(const p of db.prepare('SELECT * FROM projects').all()) {
        try {const root=await workspace.projectDir(p.id);await executionPolicy(root);records.push({root,id:p.board_id || p.id});}
        catch(error){if(error.code!=='not_found' && error.code!=='capability_unavailable')throw error;}
      }
      return records;
    },
    // SQLite's authorized project roster is the registry, not another JSON copy.
    saveRegistry:async()=>{},onError:error=>console.warn('[manager-core]',error.message),
    ensureParent:file=>mkdir(dirname(file),{recursive:true}),
    zip:entries=>{if(!runtime?.zip)throw unavailable('文档打包适配器未接通');return runtime.zip(entries);},
    generateWord:async(...args)=>{if(!runtime?.generateWord)throw unavailable('Word 生成适配器未接通');return runtime.generateWord(...args);},
  });
  async function use(project, callback) {
    if(!workspace.configured)throw unavailable('尚未配置共享项目工作区');
    const root=await workspace.projectDir(project.id);
    try{await executionPolicy(root);}catch(error){throw invalid(error.message);}
    const id=project.board_id || project.id;boardDirectory(id);
    return exclusive(root,async()=>{
      try{const state=await readState(root,id,project.name);return await callback({root,id,state});}
      catch(error){if(!error.status)Object.assign(error,{status:409,code:'conflict'});throw error;}
    });
  }
  const mutate=(project,body)=>use(project,({root,id,state})=>services.tasks.mutate(root,id,state,body));
  return {
    version:CORE_VERSION,
    view:project=>use(project,({root,id,state})=>services.tasks.view(root,id,state)),mutate,
    knowledge:project=>({
      view:query=>use(project,({root,id,state})=>services.knowledge.knowledgeView(root,id,state,query)),
      update:body=>use(project,({root,id,state})=>services.knowledge.updateKnowledge(root,id,state,body)),
    }),
    documents:project=>({
      review:(name,approval)=>use(project,({root,id})=>services.reviews.documentReview(root,id,name,approval)),
      comment:body=>use(project,({root,id})=>services.reviews.updateComment(root,id,body)),
    }),
    learning:project=>({
      view:async()=> (await use(project,({root,id,state})=>services.tasks.view(root,id,state))).learning,
      sources:()=>use(project,({root,id})=>services.learning.learningSources(root,id)),
      context:paths=>use(project,({root,id})=>services.learning.learningContext(root,id,paths)),
      mutate:body=>{
        if(body.action!=='learn' && !String(body.action).startsWith('learning-'))throw invalid('无效陪学操作');
        return mutate(project,body);
      },
    }),
    restore:()=>services.tasks.restore(),tick:()=>services.tasks.tick(),dispose:()=>services.tasks.dispose(),
  };
}
