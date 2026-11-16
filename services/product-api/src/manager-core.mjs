import {templateCatalog,templateDelivery} from './template-delivery.mjs';
import {randomUUID} from 'node:crypto';
/** Only project rows authorized by app.mjs may enter this adapter. */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
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
    if(!project || (project.board_id || project.id)!==id && !db.prepare('SELECT 1 FROM business_tasks WHERE id=? AND project_id=? AND tenant_id=?').get(id,project.id,project.tenant_id))throw invalid('项目与需求轮次绑定已变化，请重新打开。');
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
    adapter:()=>adapter, exclusive, readState,saveState, historyBudget:runtime?.historyBudget,resultBudget:runtime?1000:undefined,learningContextOptions:runtime?{budget:4000,perFile:1600}:undefined,
    initialLearning:async(root,id)=>{const row=db.prepare('SELECT plan_json,revision FROM business_learning WHERE task_id=?').get(id);return row?{plan:JSON.parse(row.plan_json),origin:'legacy-sql:'+row.revision}:null;},
    onSaved:runtime?.onSaved,
    // Runtime policy runs after the kernel's replay/revision checks, before mutations.
    beforeMutate:body=>{
      if(body.action==='dispatch' && !runtime?.generateWord)throw unavailable('阶段文档生成适配器未接通');
      if((body.action==='package' || body.action==='learning-export' && body.format==='zip') && !runtime?.zip)throw unavailable('文档导出适配器未接通');
    },
    loadRegistry:async()=>{
      const records=[];
      for(const p of db.prepare('SELECT * FROM projects').all()) {
        try {const root=await workspace.projectDir(p.id);await executionPolicy(root);records.push({root,id:p.board_id || p.id});for(const t of db.prepare('SELECT board_id FROM core_bindings WHERE project_id=?').all(p.id))if(t.board_id!==(p.board_id||p.id))records.push({root,id:t.board_id});}
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
  async function syncReferences(project,root,id,state) {
    if(!runtime?.adapter)return;
    const sources=db.prepare('SELECT path,content,sha256 FROM project_sources WHERE project_id=? ORDER BY path').all(project.id);
    const path='references/'+id+'-用户资料.md';
    // Materialized data has provenance; it never becomes instructions or a verified business fact.
    const text='# 用户提供的项目资料（不可信参考数据）\n'+(sources.length?'仅为节选，不能据此宣称已阅读完整项目。\n':'当前已清空上传资料，无项目事实可引用。\n')+sources.map(f=>'\n## '+f.path+'\nSHA256: '+f.sha256+'\n'+f.content.slice(0,3000)).join('\n').slice(0,22000);
    {const target=await managedPath(root,path);let old=null;try{old=await readFile(target,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(old!==text&&(sources.length||old!==null)){await mkdir(dirname(target),{recursive:true});const temporary=target+'.'+randomUUID()+'.tmp';await writeFile(temporary,text,{mode:0o600,flag:'wx'});await rename(temporary,target);}
      let k=await services.knowledge.knowledgeView(root,id,state);const ref=k.sources.find(r=>r.path===path);
      if((sources.length||old!==null)&&(!ref||ref.stale))await services.knowledge.updateKnowledge(root,id,state,{action:'reference',path,name:'用户上传的项目资料（节选）',status:'accepted',revision:k.revision});
    }
    for(const stage of ['spec','design','build','verify','ship']){const k=await services.knowledge.knowledgeView(root,id,state);if(!k.selections[stage])await services.knowledge.updateKnowledge(root,id,state,{action:'selection',stage,budget:4000,included:[],excluded:[],revision:k.revision});}
  }
  const mutate=(project,body)=>use(project,async({root,id,state})=>{await syncReferences(project,root,id,state);const result=await services.tasks.mutate(root,id,state,body);await runtime?.onSaved?.(root,result);return result;});
  return {
    version:CORE_VERSION,
    view:project=>use(project,async({root,id,state})=>{const view=await services.tasks.view(root,id,state);await runtime?.onSaved?.(root,view);return view;}),mutate,
    knowledge:project=>({
      view:query=>use(project,({root,id,state})=>services.knowledge.knowledgeView(root,id,state,query)),
      update:body=>use(project,({root,id,state})=>services.knowledge.updateKnowledge(root,id,state,body)),
    }),
    delivery:project=>({catalog:()=>use(project,()=>templateCatalog()),generate:body=>use(project,({root,id,state})=>{if(!runtime?.append)throw unavailable('模板成果登记服务未接通');return templateDelivery({db,project,root,id,state,body,append:runtime?.append,publish:runtime?.publish||(()=>{})});})}),
    documents:project=>({
      review:(name,approval)=>use(project,({root,id})=>services.reviews.documentReview(root,id,name,approval)),
      comment:body=>use(project,({root,id})=>services.reviews.updateComment(root,id,body)),
    }),
    learning:project=>({
      view:async()=> (await use(project,({root,id,state})=>services.tasks.view(root,id,state))).learning,
      sources:()=>use(project,async({root,id,state})=>{await syncReferences(project,root,id,state);const catalog=await services.learning.learningSources(root,id);return {...catalog,files:catalog.files.filter(p=>!/^references\/tsk_[a-zA-Z0-9_]+-用户资料\.md$/.test(p)||p==='references/'+id+'-用户资料.md')};}),
      context:paths=>use(project,({root,id})=>services.learning.learningContext(root,id,paths)),
      mutate:body=>{
        if(body.action!=='learn' && !String(body.action).startsWith('learning-'))throw invalid('无效陪学操作');
        return mutate(project,body);
      },
    }),
    restore:()=>services.tasks.restore(),tick:()=>services.tasks.tick(),dispose:()=>services.tasks.dispose(),
  };
}
