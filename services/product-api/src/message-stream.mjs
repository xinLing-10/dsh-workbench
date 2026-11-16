/** Durable, bounded preview snapshots. They never constitute an execution receipt. */
export function createMessageStream({db,run,requestId,append,publish,authorize}) {
 let text='',dirty=false,timer,lastAt=0,closed=false;
 const flush=()=>{
  clearTimeout(timer);timer=undefined;if(!dirty)return;
  try{authorize();}catch{dirty=false;return;}
  const event=append(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'message_stream',payload:{requestId,text,preview:true}});
  dirty=false;lastAt=Date.now();publish(event);
 };
 return {
  text(delta){if(closed)return;text=(text+delta).slice(0,200000);dirty=true;if(!lastAt||Date.now()-lastAt>=200)flush();else if(!timer){timer=setTimeout(()=>{try{flush();}catch{}},200);timer.unref?.();}},
  close(){closed=true;flush();}
 };
}
/** One latest snapshot per operation, suppressed by an authoritative final reply. */
export function streamMessages(db,projectId) {
 return db.prepare("SELECT e.*,o.state FROM project_events e JOIN operations o ON o.id=e.operation_id WHERE e.project_id=? AND NOT EXISTS(SELECT 1 FROM core_sessions c WHERE c.operation_id=e.operation_id) AND e.type='message_stream' AND e.id=(SELECT MAX(s.id) FROM project_events s WHERE s.operation_id=e.operation_id AND s.type='message_stream') AND NOT EXISTS(SELECT 1 FROM project_events f WHERE f.operation_id=e.operation_id AND f.type='message_completed') ORDER BY e.id").all(projectId).map(row=>{
  const p=JSON.parse(row.payload_json);
  return {id:row.id,operationId:row.operation_id,role:'system',kind:'message_stream',text:p.text,at:row.at,preview:true,streamState:['failed','cancelled','uncertain'].includes(row.state)?'interrupted':row.state==='waiting'?'waiting':'generating'};
 });
}
