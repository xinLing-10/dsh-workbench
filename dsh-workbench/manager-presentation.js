import { DOCUMENTS } from './artifacts.js';
const ACTIVE=new Set(['queued','creating','submitting','running','cancelling']);
const TITLES={spec:'需求说明书',design:'设计方案',build:'制作与运行说明',verify:'测试报告',ship:'交付清单'};
/** Read-only presentation, never an authorization or a second execution state machine. */
export function deriveManagerPresentation(view,state) {
  const result={schemaVersion:1,revision:view.revision,phase:'idle',title:'还想补充什么？',description:'把想法告诉管家，下一步安排会先请你决定。',primaryAction:{kind:'prepare_first',label:'帮我整理下一步',enabled:true},secondaryActions:[],blockingReasons:[],relatedJobId:null,relatedQuestionId:null};
  const set=(phase,title,description,action)=>Object.assign(result,{phase,title,description,primaryAction:{enabled:true,...action}});
  if(!view.contract){set('welcome','先告诉我你想完成什么','选择项目后，写下想法，再确定本次希望拿到的成果。',{kind:'open_setup',label:'填写我的想法'});return result;}
  const active=view.jobs.findLast(j=>ACTIVE.has(j.status)||j.status==='uncertain');
  const latest=view.jobs.at(-1);
  if(active){
    result.relatedJobId=active.id;
    const secondary=[];
    if(active.sessionId)secondary.push({kind:'open_session',label:'查看授权与处理详情',sessionId:active.sessionId});
    secondary.push({kind:'cancel',label:'停止这项工作',enabled:active.status!=='cancelling' && view.available,reason:!view.available?'请先恢复执行服务，再停止任务。':'停止请求已提交，请等待任务结束。'});
    result.secondaryActions=secondary;
    if(active.status==='uncertain')set('needs_recovery','这项工作需要先核对状态','不要重复开始；核对原会话后再继续。',{kind:'recheck',label:'重新检查状态',enabled:view.available,reason:'请先重启 DSH Host 恢复管家执行服务，再核对任务状态。'});
    else set('working',active.status==='cancelling'?'正在停止，请稍等':'管家正在准备成果','进度来自实际任务记录；需要权限时，请查看授权详情。',{kind:'show_progress',label:'查看进展'});
    return result;
  }
  // Reading and downloading already available documents does not require a model service.
  const stage=view.nextStage;
  const hashes=view.review?.stages[stage]?.hashes || {};
  const expected=stage ? (DOCUMENTS[stage] || []).filter(n=>n!=='现状基线.md' || state.flow==='incremental'):[];
  const missing=expected.filter(name=>!hashes[name]);
  const currentQuestions=view.messages.flatMap(m=>m.role==='assistant'?(m.blocks || []):[]).filter(b=>b.type==='question' && b.stage===(stage || 'ship') && !b.answer && !view.answers?.[b.id]);
  const question=currentQuestions[0];
  if(question && view.available){set('needs_info','有一件事想请你决定',`回答后我们再继续${currentQuestions.length>1?`，还有 ${currentQuestions.length-1} 个问题`:''}。`,{kind:'answer',label:'提交回答',questionId:question.id});result.question=question;result.relatedQuestionId=question.id;return result;}
  const proposal=view.proposal;
  // A fresh revision proposal takes precedence over files from the superseded approval.
  const pendingWork=view.jobs.findLast(j=>j.kind==='work' && j.stage===stage);
  const revising=proposal && stage && state.stageData[stage]?.needsReview;
  if(stage && expected.length && !missing.length && !revising && pendingWork?.status!=='needs_input'){
    set('needs_review',`${TITLES[stage]}准备好了，请你看看`,'核对目标、范围与完成条件；打开阅读不会自动确认。',{kind:'open_review',label:'查看并确认成果',stage});return result;
  }
  if(view.complete){set('ready_to_download','约定成果已确认，可以拿走了','完整文档始终保留；文档包不包含代码或运行环境。',view.delivery?{kind:'download_package',label:'下载交付文档包',deliveryId:view.delivery.id}:{kind:'package',label:'整理交付文档包'});return result;}
  if(!view.available){set('needs_recovery','管家执行服务尚未连接','可先阅读已有成果；请重启 DSH Host 后重新连接。',{kind:'reconnect',label:'重新连接'});result.blockingReasons=['管家执行服务尚未连接'];return result;}
  if(proposal && (proposal.stage===stage || (proposal.extend && !stage))){set('ready_to_start','这次准备这样做','请核对具体安排，同意后才开始执行。',{kind:'dispatch',label:proposal.extend?'扩展交付目标并开始':'同意并开始',proposalId:proposal.id});result.instruction=proposal.instruction;return result;}
  if(latest && ['failed','needs_input','cancelled'].includes(latest.status)){
    set('needs_recovery',latest.status==='needs_input'?'还需要补充内容':'这项工作暂时停下来了',latest.error || (missing.length?`还缺少 ${missing.length} 份文档，请告诉管家需要补充什么。`:'已生成文件保留，请核对后再安排下一步。'),{kind:latest.sessionId?'open_session':'compose',label:latest.sessionId?'查看处理记录':'告诉管家需要什么',...(latest.sessionId?{sessionId:latest.sessionId}:{})});
  }
  return result;
}
