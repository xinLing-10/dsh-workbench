/** Bounded text/tool loop. No provider credentials and no host command execution. */
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const tools=[
 {name:'ask_user_question',description:'Ask the user a short clarifying question.',input_schema:{type:'object',properties:{question:{type:'string'}},required:['question'],additionalProperties:false}},
 {name:'run_project_command',description:'Request permission to run a shell command inside the project sandbox. No network, no host files.',input_schema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false}}
];
export function parseModelWire(wire){
 const blocks=[];let reason;
 for(const frame of wire.replace(/\r\n/g,'\n').split('\n\n')){
  const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')continue;const e=JSON.parse(data);
  if(e.type==='content_block_start')blocks[e.index]={...e.content_block,json:''};
  if(e.type==='content_block_delta'){const b=blocks[e.index];if(!b)throw Error('Invalid model stream');if(e.delta.type==='text_delta')b.text=(b.text||'')+e.delta.text;if(e.delta.type==='input_json_delta')b.json+=e.delta.partial_json;}
  if(e.type==='message_delta')reason=e.delta?.stop_reason;
 }
 return {reason,content:blocks.filter(Boolean).map(({json,...b})=>b.type==='tool_use'?{...b,input:json?JSON.parse(json):b.input}:b)};
}
export function createIsolatedRuntime({sandbox,model,workspaceRoot,maxOutputTokens=1024,maxCalls=8}){
 if(!model||!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>8||!Number.isInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>2048)throw Error('Invalid isolated model limits');
 return {async execute({job,client,onControl}){
  const controller=new AbortController();onControl({cancel:()=>controller.abort()});const messages=[{role:'user',content:job.text}];
  try{
   if(sandbox.prepare)try{await sandbox.prepare({projectId:job.projectId});}catch{if(controller.signal.aborted)throw Error('aborted');return {status:'failed',reason:{kind:'failed'},text:'隔离执行环境或项目目录尚未就绪，未发起模型调用。'};}
   for(let turn=0;turn<maxCalls;turn++){
   controller.signal.throwIfAborted();
   const response=await client.modelMessage({id:'call_'+randomUUID(),body:{model,max_tokens:maxOutputTokens,stream:true,thinking:{type:'disabled'},system:'你是项目管家。仅处理当前项目；先解释再请求操作授权。命令只能在隔离环境执行，无网络，不能访问其他项目或凭据。工具失败应如实说明。',messages,tools,tool_choice:{type:'auto'}}},{signal:controller.signal});
   if(!['completed','tool_requested'].includes(response.record.status))return {status:'uncertain'};
   const result=parseModelWire(response.wire);messages.push({role:'assistant',content:result.content});
   if(result.reason==='end_turn'){
    controller.signal.throwIfAborted();const text=result.content.filter(b=>b.type==='text').map(b=>b.text).join('\n\n');
    const relativePath='reply-'+job.engineId+'.md',bytes=Buffer.from(text);await writeFile(join(workspaceRoot,job.projectId,relativePath),bytes,{flag:'wx',mode:0o600});
    return {status:'completed',reason:{kind:'completed'},text,artifacts:[{relativePath,sha256:createHash('sha256').update(bytes).digest('hex')}]};
   }
   if(result.reason!=='tool_use')return {status:'uncertain'};
   const replies=[];
   for(const t of result.content.filter(b=>b.type==='tool_use')){
    controller.signal.throwIfAborted();let value;
    if(t.name==='ask_user_question' && typeof t.input?.question==='string'){
     const q=await client.createInteraction({kind:'question',prompt:t.input.question,requestKey:'question_'+t.id});const answer=await client.waitAnswer(q.id,{signal:controller.signal});if(!answer)return {status:'uncertain'};value=JSON.stringify(answer.answer);
    }else if(t.name==='run_project_command' && typeof t.input?.command==='string' && t.input.command.length<=4096){
     const q=await client.createInteraction({kind:'permission',prompt:'是否允许在当前项目隔离环境执行以下命令？\n'+t.input.command,scope:'run_project_command',requestKey:'permission_'+t.id});
     const answer=await client.waitAnswer(q.id,{signal:controller.signal});if(!answer)return {status:'uncertain'};
     if(['allow','allowed','allowed-once','同意','允许','允许一次'].includes(String(answer.answer).toLowerCase()))value=JSON.stringify(await sandbox.run({projectId:job.projectId,command:t.input.command,signal:controller.signal}));else value='用户拒绝，命令未执行。';
    }else throw Error('Unsupported tool input');
    replies.push({type:'tool_result',tool_use_id:t.id,content:value});
   }
   if(!replies.length)return {status:'uncertain'};messages.push({role:'user',content:replies});
  }return {status:'failed',reason:{kind:'failed'},text:'已达到本轮最大模型调用次数，未继续执行。'};
  }catch(error){if(!controller.signal.aborted && ['capability_unavailable','validation'].includes(error.code))return {status:'failed',reason:{kind:'failed'},text:'本轮未继续执行：'+error.message};if(controller.signal.aborted)return {status:'cancelled',reason:{kind:'aborted'},text:''};return {status:'uncertain'};}
 },close:()=>sandbox.close()};
}
