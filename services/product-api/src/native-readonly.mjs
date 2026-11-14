/** Isolated DSH headless execution with all tool declarations removed at the gateway.
 * A text-only test adapter, not the production Worker/approval bridge.
 */
import{createServer}from'node:http';import{spawn}from'node:child_process';import{writeFile,mkdir,open}from'node:fs/promises';import{join}from'node:path';import{randomBytes}from'node:crypto';import{budgetedMessage}from'./budgeted-model.mjs';import{installation}from'./current-deepseek-account.mjs';
export async function executeNativeReadonly({directory,callId,prompt,budget,account}){
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(callId)||typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt)>16000)throw Error('Invalid native task');
 const runDirectory=join(directory,'native-runs',callId);await mkdir(runDirectory,{recursive:true,mode:0o700});const lock=await open(join(runDirectory,'attempt.lock'),'wx',0o600);await lock.close();
 const home=join(runDirectory,'home'),workspace=join(runDirectory,'workspace');await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(join(home,'profiles/headless'),{recursive:true,mode:0o700});
const localToken=randomBytes(32).toString('hex');let attempts=0;let evidence=null;
const cleanText=v=>{if(typeof v==='string')return v;if(Array.isArray(v)&&v.every(b=>b?.type==='text'&&typeof b.text==='string'))return v.map(b=>({type:'text',text:b.text}));throw Error('Only text accepted');};
const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'||req.url!=='/v1/messages'||req.headers['x-api-key']!==localToken||attempts)throw Error('Denied');
  let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>200000)throw Error('Too large');}
  const b=JSON.parse(raw);const body={model:account.model,max_tokens:2048,stream:true,thinking:{type:'disabled'},messages:b.messages.map(m=>({role:m.role,content:cleanText(m.content)}))};if(b.system)body.system=cleanText(b.system);
  attempts++;
  const out=await budgetedMessage({budget,id:callId,body,...account});evidence=out.record;
  await writeFile(join(runDirectory,'model-evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600});
  if(evidence.status!=='completed')throw Error('Uncertain model outcome');
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(out.wire);
 }catch{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'permission_error',message:'Bounded smoke gateway refused request; no retry permitted'}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
const patch=[{id:'agent-default-model',config:{provider:'deepseek-official',model:account.model,reasoningEffort:'off'}},{id:'llm-deepseek',config:{baseURL:'http://127.0.0.1:'+port,maxTokens:2048,thinking:'disabled',reasoningEffort:'off',retryPolicy:{mode:'normal',maxRetries:0}}},{id:'llm-retry',disabled:true}];
const patchFile=join(runDirectory,'overlay.json');await writeFile(patchFile,JSON.stringify(patch),{mode:0o600});

let stdout='',stderr='',timedOut=false,child,timer;
try{
 child=spawn(process.execPath,[join(installation,'lib/bin.js'),'headless','--patch',patchFile,'--json','-'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',DSH_HOME:home,DEEPSEEK_API_KEY:localToken,DEEPSEEK_BASE_URL:'http://127.0.0.1:'+port},stdio:['pipe','pipe','pipe']});
 child.stdin.end('你是面向零基础用户的管家。当前为真实模型只读答疑验证，不能调用工具、访问文件、修改项目、创建子代理或部署；只能使用用户给出的文本资料。先直接回答，再用短段落说明重点，不编造执行结果。\n\n'+prompt);child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1000000)child.kill('SIGTERM');});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>100000)child.kill('SIGTERM');});
 timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},150000);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});
 const events=stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {type:'invalid_line'};}});const final=events.findLast(e=>e.type==='final');
 const completed=exit.code===0&&evidence?.status==='completed'&&final&&!events.some(e=>e.type==='tool_call');
 const text=typeof final?.text==='string'?final.text:typeof final?.answer==='string'?final.answer:evidence?.text||'';
 const report={scope:'native-dsh-readonly',status:completed&&text?'completed':'uncertain',exit,timedOut,attempts,text,events,modelEvidence:evidence,stderr:stderr.replaceAll(localToken,'[redacted]'),productFullAcceptance:false};
 await writeFile(join(runDirectory,'result.json'),JSON.stringify(report,null,2),{mode:0o600});return report;
}finally{clearTimeout(timer);if(child&&child.exitCode===null)child.kill('SIGTERM');server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
