/** Bounded lexical/concept retrieval. Historic learning records never become current project evidence. */
const compact=s=>String(s || '').replace(/\[S\d+:L\d+(?:-L?\d+)?\]/g,'〔历史资料引用〕').slice(0,1600);
function tokens(text) {
  const value=String(text || '').toLowerCase().slice(0,1200);
  const words=value.match(/[a-z0-9_]{2,}/g) || [];
  for(const run of value.match(/[\u3400-\u9fff]+/g) || [])for(let i=0;i<run.length-1;i++)words.push(run.slice(i,i+2));
  return [...new Set(words)].filter(w=>!['什么','这个','那个','如何','请问','一下','学习','问题','继续','我们'].includes(w));
}
function score(query,text) {const set=new Set(tokens(text));return query.reduce((n,t)=>n+(set.has(t)?1:0),0);}
export function retrieveLearningMemory(learning,question,history=[]) {
  if(learning.memoryEnabled===false)return {observations:[],exchanges:[],preferences:{},disabled:true};
  const query=tokens(question),coach=learning.coach;
  const observations=(learning.observations || []).map((o,i)=>{
    const clean={id:o.id,conceptId:o.conceptId,title:o.title,understood:o.corrected?[]:o.understood,misconceptions:o.corrected?[]:o.misconceptions,certainty:o.certainty,next:o.corrected?'以用户纠正为准，重新确认需要帮助的部分。':o.next,corrected:o.corrected,correction:o.correction || '',time:o.time};
    return {clean,rank:score(query,JSON.stringify(clean))+(coach && coach.conceptId===o.conceptId && score(query,coach.title)>0?3:0),i};
  }).filter(v=>v.rank>0).sort((a,b)=>b.rank-a.rank || b.i-a.i).slice(0,5).map(v=>v.clean);
  const exchanges=[];const corrected=new Set((learning.observations || []).filter(o=>o.corrected).map(o=>o.messageId));
  for(let i=0;i<history.length-12;i++) {
    const user=history[i],answer=history[i+1];
    if(corrected.has(user.id) || user.role!=='user' || answer?.role!=='assistant' || !answer.evidence)continue;
    const rank=score(query,user.text+' '+answer.text)+(learning.helpfulMessages?.includes(answer.id)?2:0);
    if(rank<=0)continue;
    exchanges.push({userId:user.id,assistantId:answer.id,question:compact(user.text),answer:compact(answer.text),time:answer.time,helpful:!!learning.helpfulMessages?.includes(answer.id),rank});
  }
  return {observations,exchanges:exchanges.sort((a,b)=>b.rank-a.rank || String(b.time).localeCompare(String(a.time))).slice(0,4).map(({rank,...e})=>e),preferences:learning.preferences || {},notice:'仅用于了解学习过程；历史回答的项目结论需由本轮资料重新确认。'};
}
export function memorySummary(memory) {
  return {disabled:!!memory.disabled,observations:memory.observations.map(o=>({id:o.id,title:o.title,corrected:o.corrected})),exchanges:memory.exchanges.map(e=>({userId:e.userId,assistantId:e.assistantId,question:e.question.slice(0,160),helpful:e.helpful})),gap:memory.gap || ''};
}
