/** Native DSH process smoke, with no tool schemas forwarded to the provider. */
import{createServer}from'node:http';import{spawn}from'node:child_process';import{readFile,writeFile,mkdir,open}from'node:fs/promises';import{join}from'node:path';import{fileURLToPath}from'node:url';import{randomBytes}from'node:crypto';import{openBudget}from'../src/model-budget.mjs';import{budgetedMessage}from'../src/budgeted-model.mjs';import{currentAccount,installation}from'../src/current-deepseek-account.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));const directory=join(root,'services/product-api/control-data/authorized-20261114-200k');
const auth=JSON.parse(await readFile(join(directory,'authorization.json'),'utf8'));if(auth.tokenLimit!==200000)throw Error('Authorization missing');
const budget=openBudget(join(directory,'budget.sqlite'));const account=await currentAccount();if(account.model!==auth.model)throw Error('Model changed');
const lock=await open(join(directory,'native-attempt.lock'),'wx',0o600);await lock.close();
const home=join(directory,'native-home'),workspace=join(directory,'native-workspace');await mkdir(workspace,{recursive:true,mode:0o700});await mkdir(join(home,'profiles/headless'),{recursive:true,mode:0o700});
const localToken=randomBytes(32).toString('hex');let attempts=0;let evidence=null;
const cleanText=v=>{if(typeof v==='string')return v;if(Array.isArray(v)&&v.every(b=>b?.type==='text'&&typeof b.text==='string'))return v.map(b=>({type:'text',text:b.text}));throw Error('Only text accepted');};
const server=createServer(async(req,res)=>{
 try{
  if(req.method!=='POST'||req.url!=='/v1/messages'||req.headers['x-api-key']!==localToken||attempts)throw Error('Denied');
  let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>200000)throw Error('Too large');}
  const b=JSON.parse(raw);const body={model:account.model,max_tokens:2048,stream:true,thinking:{type:'disabled'},messages:b.messages.map(m=>({role:m.role,content:cleanText(m.content)}))};if(b.system)body.system=cleanText(b.system);
  attempts++;
  const out=await budgetedMessage({budget,id:'native-dsh-smoke',body,...account});evidence=out.record;
  await writeFile(join(directory,'native-model-evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600});
  if(evidence.status!=='completed')throw Error('Uncertain model outcome');
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(out.wire);
 }catch{res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'permission_error',message:'Bounded smoke gateway refused request; no retry permitted'}}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
const patch=[{id:'agent-default-model',config:{provider:'deepseek-official',model:account.model,reasoningEffort:'off'}},{id:'llm-deepseek',config:{baseURL:'http://127.0.0.1:'+port,maxTokens:2048,thinking:'disabled',reasoningEffort:'off',retryPolicy:{mode:'normal',maxRetries:0}}},{id:'llm-retry',disabled:true}];
const patchFile=join(directory,'native-overlay.json');await writeFile(patchFile,JSON.stringify(patch),{mode:0o600});
const prompt='这是受预算限制的原生 DSH 无工具测试。不要调用任何工具，不要访问或修改文件，不要创建子代理。请只回复：原生DSH预算测试已完成。';
let stdout='',stderr='',timedOut=false;
try{
 const child=spawn(process.execPath,[join(installation,'lib/bin.js'),'headless','--patch',patchFile,'--json','-'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR||'/tmp',DSH_HOME:home,DEEPSEEK_API_KEY:localToken,DEEPSEEK_BASE_URL:'http://127.0.0.1:'+port},stdio:['pipe','pipe','pipe']});
 child.stdin.end(prompt);child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1000000)child.kill('SIGTERM');});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>100000)child.kill('SIGTERM');});
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},150000);
 const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
 const events=stdout.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {type:'invalid_line'};}});const final=events.findLast(e=>e.type==='final');
 const report={scope:'native-dsh-engine-only',status:exit.code===0&&evidence?.status==='completed'&&JSON.stringify(final).includes('原生DSH预算测试已完成')&&!events.some(e=>e.type==='tool_call')?'passed':'needs_review',exit,timedOut,attempts,events,stderr:stderr.replaceAll(localToken,'[redacted]'),budget:budget.snapshot(),productAcceptance:false};
 await writeFile(join(directory,'native-result.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({directory,status:report.status,exit,attempts,budget:report.budget,stderr:report.stderr.slice(0,3000)}));
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));budget.close();}
