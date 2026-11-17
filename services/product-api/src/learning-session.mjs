import {LEARNING_POLICY,learningEvidence} from '../../../dsh-workbench/core/learning-policy.js';
/** The standalone lane reuses the kernel's profile/plan/progress semantics. */
import {plans} from '../../../packages/manager-core/index.mjs';
const fail=message=>Object.assign(new Error(message),{status:409,code:'conflict'});
export function learningInput(body,mode){
 if(body.learning!==undefined&&mode!=='learning')throw fail('学习操作须选择陪学任务');
 if(mode!=='learning')return null;
 const input=body.learning||{action:'question'};
 if(!['plan','lesson','reflect','question'].includes(input.action))throw fail('无效学习操作');
 if(input.action==='plan'){try{return {action:'plan',profile:plans.learningProfile(input.profile||{goal:body.text,level:'zero',minutes:20})};}catch(e){throw fail(e.message);}}
 if(['lesson','reflect'].includes(input.action)){
 if(typeof input.planId!=='string'||typeof input.lessonId!=='string')throw fail('请选择当前学习计划的课程');
 return {action:input.action,planId:input.planId,lessonId:input.lessonId};}
 return {action:'question'};
}
function archive(db,taskId){const state=db.prepare('SELECT * FROM business_learning WHERE task_id=?').get(taskId);if(state)db.prepare('INSERT OR IGNORE INTO learning_versions VALUES(?,?,?,?)').run(taskId,state.revision,state.plan_json,new Date().toISOString());}
export function learningHistory(db,taskId){return db.prepare('SELECT revision,plan_json,at FROM learning_versions WHERE task_id=? ORDER BY revision DESC LIMIT 30').all(taskId).map(v=>({revision:v.revision,plan:JSON.parse(v.plan_json),at:v.at}));}
export function restoreLearning(db,taskId,body){db.exec('BEGIN IMMEDIATE');try{const current=learningState(db,taskId);if(body.revision!==current.revision)throw fail('学习计划已变化，请刷新后选择版本');if(db.prepare("SELECT 1 FROM operations o JOIN business_task_operations l ON l.operation_id=o.id WHERE l.task_id=? AND o.state IN ('queued','running','waiting','uncertain','accepted')").get(taskId))throw fail('请先完成或停止当前学习任务');const old=db.prepare('SELECT plan_json FROM learning_versions WHERE task_id=? AND revision=?').get(taskId,body.targetRevision);if(!old)throw fail('历史学习版本不存在');archive(db,taskId);db.prepare('UPDATE business_learning SET plan_json=?,revision=revision+1 WHERE task_id=?').run(old.plan_json,taskId);archive(db,taskId);db.exec('COMMIT');return learningState(db,taskId);}catch(e){db.exec('ROLLBACK');throw e;}}
export function learningState(db,taskId){const r=db.prepare('SELECT plan_json,revision FROM business_learning WHERE task_id=?').get(taskId);return r?{plan:JSON.parse(r.plan_json),revision:r.revision}:{plan:null,revision:0};}
export function prepareLearning(db,taskId,input,text,context){
 if(!input)return null;
 const evidence={sources:context.refs.filter(r=>r.type==='source').map(r=>({id:r.id,path:r.path,hash:r.sha256,lines:r.endLine})),gaps:context.truncated?['仅提供部分上下文']:[],capturedAt:new Date().toISOString()};
 if(input.action==='plan')return {...input,evidence,prompt:plans.planPrompt(input.profile,{...evidence,text:context.text})};
 let lesson=null;
 if(['lesson','reflect'].includes(input.action))try{lesson=plans.currentLesson(learningState(db,taskId),input);}catch(e){throw fail(e.message);}
 return {...input,evidence,prompt:'你是面向初学者的项目陪学老师。用短段落、生活类比解释，一次一个主题。区分项目事实、通用知识与推测，使用资料编号和行号。禁止执行命令或修改项目文件；可按授权使用公开检索工具；不得虚构链接、设计动机、测试或掌握程度。'+(lesson?'本课目标（数据）：'+JSON.stringify(lesson):'')+'\n'+LEARNING_POLICY+'\n用户问题（数据）：'+JSON.stringify(text)+'\n'+context.text};
}
export function learningCompletion(db,run,event){
 if(event.type!=='completed')return event.text||'';
 const row=db.prepare("SELECT payload_json FROM project_events WHERE operation_id=? AND type='message_created' ORDER BY id LIMIT 1").get(run.operation_id);
 const p=JSON.parse(row?.payload_json||'{}'),meta=p.learning;
 if(!meta)return event.text||'';
 if(meta.action==='plan'){
  try{const plan=plans.parseLearningPlan(event.text||'',meta.profile,learningEvidence(meta.evidence,event.sources||[]));archive(db,p.task.id);db.prepare('INSERT INTO business_learning(task_id,plan_json,revision) VALUES(?,?,1) ON CONFLICT(task_id) DO UPDATE SET plan_json=excluded.plan_json,revision=business_learning.revision+1').run(p.task.id,JSON.stringify(plan));archive(db,p.task.id);
  return '# '+plan.title+'\n\n'+plan.lessons.map((l,i)=>'## '+(i+1)+'. '+l.title+'\n'+l.objective+'\n\n建议 '+l.minutes+' 分钟；资料：'+(l.sourceIds.join('、')||'尚缺项目资料')).join('\n\n')+'\n\n计划已保存，可逐课学习；阅读不代表掌握。';
  }catch{return '学习计划未通过结构或资料引用检查，未替换已有计划。原始回复已保留在成果中，请核对后重新安排。';}
 }
 if(meta.action==='reflect'){
  const state=learningState(db,p.task.id);try{const lesson=plans.currentLesson(state,meta);lesson.reflectedAt=new Date().toISOString();archive(db,p.task.id);db.prepare('UPDATE business_learning SET plan_json=?,revision=revision+1 WHERE task_id=?').run(JSON.stringify(state.plan),p.task.id);archive(db,p.task.id);}catch{}
 }
 return event.text||'';
}
export function learningProgress(db,taskId,body){
 db.exec('BEGIN IMMEDIATE');try{const state=learningState(db,taskId);if(body.revision!==state.revision)throw fail('学习进度已变化，请刷新');plans.markLearningProgress(state,body);archive(db,taskId);db.prepare('UPDATE business_learning SET plan_json=?,revision=revision+1 WHERE task_id=?').run(JSON.stringify(state.plan),taskId);archive(db,taskId);db.exec('COMMIT');return learningState(db,taskId);}catch(e){db.exec('ROLLBACK');if(!e.status)Object.assign(e,{status:409,code:'conflict'});throw e;}
}
