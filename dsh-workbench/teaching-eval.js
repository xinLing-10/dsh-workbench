import { createHash } from 'node:crypto';
import { learningPrompt } from './learning.js';
import { coachInstruction } from './learning-coach.js';
/** Offline checks prepare human review; they cannot establish learning outcomes. */
import {parseReply} from './manager-message.js';
import {parseAssessment} from './learning-coach.js';
export const TEACHING_RUBRIC=['事实与来源是否成立','讲解是否适合零基础','提示是否帮助思考且尊重完整示例请求','是否正确识别误区并给出针对性反馈','是否能迁移并安排恰当复习'];
export function evaluateTeachingCase(example,response) {
  const issues=[],metrics={};let reply;
  try{reply=parseReply(response);}catch(error){return {id:example.id,status:'invalid-response',issues:['回复协议无效'],humanReview:TEACHING_RUBRIC.map(criterion=>({criterion,rating:null,note:''}))};}
  const text=reply.reply;
  const refs=[...text.matchAll(/\[S(\d+):L(\d+)(?:-L?(\d+))?\]/g)];
  for(const ref of refs) {
    const source=(example.sources || []).find(s=>s.id==='S'+ref[1]);
    const limit=source?.text?.split(/\r?\n/).length ?? source?.lines ?? 0;
    if(!source || Number(ref[2])<1 || Number(ref[3] || ref[2])<Number(ref[2]) || Number(ref[3] || ref[2])>limit)issues.push('引用超出案例提供的资料');
  }
  if(example.requiresCitation && !refs.length)issues.push('项目解释没有可检查的来源引用');
  if(example.requiresAssessment)try{parseAssessment(response,example.studentAnswer || '');}catch{issues.push('学习观察缺失或引用了用户未说过的话');}
  const sentences=text.split(/[。！!\n]/);
  for(const sentence of sentences)if(/(?:已运行测试|测试已通过|部署已完成|你已经完全掌握|掌握度\s*\d+\s*%)/.test(sentence) && !/(?:没有|并未|不能|不代表|不要|尚未)/.test(sentence))issues.push('存在需人工核查的执行或掌握声明');
  metrics.questions=(text.match(/[？?]/g) || []).length;
  metrics.longestParagraph=Math.max(0,...text.split(/\n\s*\n/).map(p=>p.length));
  if(example.maxQuestions!=null && metrics.questions>example.maxQuestions)issues.push('一次提出的问题较多');
  if(metrics.longestParagraph>600)issues.push('文段较长，需检查零基础可读性');
  if(example.expectsGap && !/资料不足|缺少|无法确认|不能确认|尚未说明|待补/.test(text))issues.push('请人工核查是否明确交代了资料缺口');
  return {id:example.id,caseContext:{prompt:example.prompt,studentAnswer:example.studentAnswer || '',sources:example.sources || [],reviewNotes:example.reviewNotes || ''},reply:text,status:issues.length?'needs-attention':'ready-for-human-review',issues:[...new Set(issues)],metrics,humanReview:TEACHING_RUBRIC.map(criterion=>({criterion,rating:null,note:''})),notice:'自动检查仅检查格式、引用范围、原话和部分风险信号，不证明教学正确或用户学会。'};
}
export function teachingReport(cases,responses) {
  const results=cases.map(example=>typeof responses[example.id]==='string'?evaluateTeachingCase(example,responses[example.id]):{id:example.id,status:'missing-response',issues:['尚未提供该案例的真实模型回复']});
  return {generatedAt:new Date().toISOString(),modelCalls:0,learningOutcomeValidated:false,summary:results.reduce((out,r)=>(out[r.status]=(out[r.status] || 0)+1,out),{}),results};
}

export function evaluationPrompt(example) {
  const sources=(example.sources || []).map(s=>({...s,hash:createHash('sha256').update(s.text).digest('hex'),lines:s.text.split(/\r?\n/).length,text:s.text.split(/\r?\n/).map((line,i)=>`${i+1}: ${line}`).join('\n')}));
  const context={sources,gaps:sources.length?[]:['未提供项目资料，只能讲通用知识。'],capturedAt:'evaluation-fixture'};
  let instruction=example.prompt;
  if(example.requiresAssessment)instruction=coachInstruction({instruction:example.prompt+' 用户回答（数据）：'+JSON.stringify(example.studentAnswer),step:'practice',nextStep:'feedback',assess:true},{coach:{title:example.topic,objective:example.prompt,step:'practice',hintLevel:0}});
  return learningPrompt([],instruction,context,{level:'zero',minutes:10,goal:'理解自己的项目'});
}
