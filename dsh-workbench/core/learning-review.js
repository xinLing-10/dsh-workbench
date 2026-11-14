/** Transparent review rules, not a calibrated mastery or forgetting model. */
import {randomUUID} from 'node:crypto';
import {conceptKey} from './learning-coach.js';
const DAY=86400000;
function put(learning,record,days,time) {
  learning.reviews ||= [];
  let item=learning.reviews.find(r=>r.conceptId===record.conceptId);
  if(!item){item={id:randomUUID(),conceptId:record.conceptId,title:record.title,attempts:0};learning.reviews.push(item);}
  const paused=item.status==='paused';
  Object.assign(item,record,{intervalDays:days,dueAt:new Date(time+days*DAY).toISOString(),status:paused?'paused':'scheduled',updatedAt:new Date(time).toISOString()});
  return item;
}
export function scheduleObservation(learning,observation,job,time=Date.now()) {
  const previous=learning.reviews?.find(r=>r.conceptId===observation.conceptId);
  const supported=observation.certainty==='supported' && observation.understood.length>0 && !observation.misconceptions.length;
  const days=supported?(job.coachTurn?.isReview?Math.min(14,Math.max(3,(previous?.intervalDays || 1)*2)):3):1;
  const reason=observation.misconceptions.length?'这次回答有待澄清的部分，建议明天再看。':supported?'这次回答有理解依据，过几天换个场景再确认。':'本次理解仍不确定，建议明天用小问题再确认。';
  const item=put(learning,{conceptId:observation.conceptId,title:observation.title,observationId:observation.id,basis:'model-observation',reason},days,time);
  item.attempts++;item.lastAnsweredAt=new Date(time).toISOString();return item;
}
export function scheduleSelfReview(learning,lesson,time=Date.now()) {
  const key=conceptKey(lesson.title);
  if(learning.reviews?.some(r=>r.conceptId===key && r.basis==='model-observation'))return;
  return put(learning,{conceptId:key,title:lesson.title,basis:'self-report',reason:'你记录了自评理解，明天可以用一个小问题回顾；自评不是掌握证明。'},1,time);
}
function find(learning,id) {const r=learning?.reviews?.find(r=>r.id===id);if(!r)throw new Error('复习安排已变化，请查看当前列表。');return r;}
export function deferReview(learning,body,time=Date.now()) {
  if(![1,3,7].includes(body.days))throw new Error('请选择推迟 1、3 或 7 天。');
  const r=find(learning,body.reviewId);r.dueAt=new Date(time+body.days*DAY).toISOString();r.status='scheduled';r.reason='按你的选择安排回顾。';
}
export function pauseReview(learning,body) {const r=find(learning,body.reviewId);r.status='paused';}
export function invalidateReview(learning,observationId) {
  for(const r of learning.reviews || [])if(r.observationId===observationId){r.status='needs-confirmation';r.reason='你已纠正相关学习观察，先重新确认，不沿用旧误区提醒。';}
}
export function reviewTarget(learning,body) {
  const item=find(learning,body.reviewId);
  return {id:item.id,title:item.title,objective:'通过一个不同的小问题回顾「'+item.title+'」，先不提供答案。',reviewId:item.id};
}
export function reviewPresentation(learning={},time=Date.now()) {
  const items=[...(learning.reviews || [])].sort((a,b)=>String(a.dueAt).localeCompare(String(b.dueAt)));
  const enabled=learning.reviewReminders!==false;
  const due=items.filter(r=>r.status==='scheduled' && Date.parse(r.dueAt)<=time);
  return {enabled,dueCount:enabled?due.length:0,nextDueId:enabled?due[0]?.id || null:null,items};
}
