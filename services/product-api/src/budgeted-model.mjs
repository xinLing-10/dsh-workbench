import {randomUUID} from 'node:crypto';
export const OFFICIAL_MESSAGES='https://api.deepseek.com/anthropic/v1/messages';
/** One HTTP attempt; journal committed before credential resolution or dispatch. */
export async function budgetedMessage({budget,id=randomUUID(),body,resolveToken,attribution={},fetchImpl=globalThis.fetch,toolNames=[],signal,authorizeDispatch=()=>{}}){
 const reservation=budget.reserve(id,body,{toolNames});const record={id,transport:fetchImpl===globalThis.fetch?'provider-http':'injected-test',model:body.model,status:'unknown',usage:null,text:'',toolBlocks:0,toolCalls:[],complete:false,reservation:reservation.amount};
 let wire='';
 try{
  const token=await resolveToken();if(typeof token!=='string'||!token||token.startsWith('dsh_mock_'))throw Error('Missing account token');
  signal?.throwIfAborted();authorizeDispatch();budget.beforeDispatch?.(id);
  const response=await fetchImpl(OFFICIAL_MESSAGES,{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000),headers:{...attribution,'content-type':'application/json',accept:'text/event-stream','anthropic-version':'2023-06-01','x-dsh-auth-token':token},body:JSON.stringify(body)});
  record.httpStatus=response.status;record.requestId=response.headers.get('x-request-id')||response.headers.get('request-id')||null;
  if(!response.ok){
   const reader=response.body?.getReader();let bytes=0,raw='';
   if(reader)try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8192)break;raw+=new TextDecoder().decode(value);}}finally{await reader.cancel().catch(()=>{});}
   try{const e=JSON.parse(raw).error;const safe=v=>typeof v==='string'?v.replaceAll(token,'[redacted]').slice(0,800):undefined;record.providerError={type:safe(e?.type),code:safe(e?.code),message:safe(e?.message)};}catch{}
   throw Error('Upstream HTTP failure');
  }
  if(!response.body)throw Error('Missing upstream body');
  const reader=response.body.getReader(),decoder=new TextDecoder();let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2000000)throw Error('Response too large');wire+=decoder.decode(value,{stream:true});}wire+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  for(const frame of wire.replace(/\r\n/g,'\n').split('\n\n')){
   const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')continue;const e=JSON.parse(data);
   if(e.type==='error')throw Error('Stream error');
   if(e.type==='message_start'){record.modelReturned=e.message?.model;record.messageId=e.message?.id;record.usage={...e.message?.usage};}
   if(e.type==='content_block_start'&&e.content_block?.type==='tool_use'){record.toolBlocks++;record.toolCalls.push({id:e.content_block.id,name:e.content_block.name});}
   if(e.type==='content_block_start'&&e.content_block?.type==='text')record.text+=e.content_block.text||'';
   if(e.type==='content_block_delta'&&e.delta?.type==='text_delta')record.text+=e.delta.text||'';
   if(e.type==='message_delta'){record.usage={...record.usage,...e.usage};record.stopReason=e.delta?.stop_reason;}
   if(e.type==='message_stop')record.complete=true;
  }
  const settled=budget.settle(id,{usage:record.usage,complete:record.complete,outputLimit:body.max_tokens,evidence:{requestId:record.requestId,messageId:record.messageId,modelReturned:record.modelReturned}});
  record.status=!settled?'unknown':record.toolBlocks===0&&record.stopReason==='end_turn'?'completed':record.toolBlocks>0&&record.stopReason==='tool_use'&&record.toolCalls.every(t=>toolNames.includes(t.name))?'tool_requested':'needs_review';
 }catch(error){record.errorKind=error.name;budget.settle(id,{usage:record.usage,complete:false,outputLimit:body.max_tokens,evidence:{errorKind:error.name,httpStatus:record.httpStatus,requestId:record.requestId,messageId:record.messageId,modelReturned:record.modelReturned}});}
 return {record,wire};
}
