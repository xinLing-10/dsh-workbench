/** One-shot official-account smoke. No tools, retries, project context or credential persistence. */
import {mkdir,writeFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const SMOKE_PROMPT='请只回复：已收到个人博客真实模型测试。不要执行工具，不要生成文件。';
export async function runSmokeOnce({directory,model,resolveToken,attribution={},fetchImpl=globalThis.fetch}){
 if(!directory||typeof model!=='string'||!/^[a-zA-Z0-9_.-]{1,100}$/.test(model))throw Error('Invalid smoke configuration');
 await mkdir(directory,{recursive:true,mode:0o700});
 const lock=await open(join(directory,'attempt.lock'),'wx',0o600);await lock.close();
 const record={schemaVersion:1,id:randomUUID(),scope:'engine-only',transport:fetchImpl===globalThis.fetch?'provider-http':'injected-test',provider:'deepseek-account',endpoint:'https://api.deepseek.com/anthropic/v1/messages',modelRequested:model,modelReturned:null,requestLimit:1,attempts:0,maxOutputTokens:1000,toolsAllowed:false,retries:0,prompt:SMOKE_PROMPT,startedAt:new Date().toISOString(),status:'reserved',text:'',usage:null,cost:null,costStatus:'not_calculated',messageId:null,upstreamRequestId:null,toolBlocks:0,stopped:false};
 const save=()=>writeFile(join(directory,'result.json'),JSON.stringify(record,null,2),{mode:0o600});
 await save();
 try{
  const token=await resolveToken();
  if(typeof token!=='string'||!token||token.startsWith('dsh_mock_'))throw Error('Account token unavailable');
  record.attempts=1;record.status='sending';await save();
  const response=await fetchImpl(record.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),headers:{...attribution,'content-type':'application/json',accept:'text/event-stream','anthropic-version':'2023-06-01','x-dsh-auth-token':token},body:JSON.stringify({model,max_tokens:1000,stream:true,thinking:{type:'disabled'},messages:[{role:'user',content:[{type:'text',text:SMOKE_PROMPT}]}]})});
  record.httpStatus=response.status;
  record.upstreamRequestId=response.headers.get('x-request-id')||response.headers.get('request-id')||null;
  if(!response.ok){record.status='failed_http';await response.body?.cancel();}
  else{
   if(!response.body)throw Error('Response body unavailable');
   const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',bytes=0;
   const consume=frame=>{
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    const event=JSON.parse(data);
    if(event.type==='error')throw Error('Provider stream error');
    if(event.type==='message_start'){record.messageId=event.message?.id||null;record.modelReturned=event.message?.model||null;record.usage={...event.message?.usage};}
    if(event.type==='content_block_start'&&event.content_block?.type==='tool_use')record.toolBlocks++;
    if(event.type==='content_block_start'&&event.content_block?.type==='text')record.text+=event.content_block.text||'';
    if(event.type==='content_block_delta'&&event.delta?.type==='text_delta')record.text+=event.delta.text||'';
    if(event.type==='message_delta'){record.usage={...record.usage,...event.usage};record.stopReason=event.delta?.stop_reason||record.stopReason;}
    if(event.type==='message_stop')record.stopped=true;
   };
   try{
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2000000)throw Error('Response too large');buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');let index;while((index=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+2);}}
    buffer+=decoder.decode();if(buffer.trim())consume(buffer);
   }finally{await reader.cancel().catch(()=>{});}
   const output=record.usage?.output_tokens;
   record.status=record.stopped&&record.text.includes('个人博客真实模型测试')&&record.toolBlocks===0&&Number.isFinite(output)&&output<=1000?'passed':'needs_review';
   if(!Number.isFinite(output))record.costStatus='unknown_usage';
  }
 }catch(error){record.status=record.attempts?'unknown':'not_sent';record.errorKind=error.name||'Error';record.costStatus=record.attempts?'unknown_delivery_or_usage':'not_sent';}
 record.endedAt=new Date().toISOString();await save();return record;
}
