/** Explicit one-shot CLI. Reads current account credential only in memory. */
import {readFile,stat,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {runSmokeOnce} from '../src/real-model-smoke.mjs';
const installation='/Users/xinlin/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(installation+'/package.json');const {parse}=require('yaml');
const profile='/Users/xinlin/.dsh/profiles/web';
const patch=parse(await readFile(profile+'/cordis.patch.yml','utf8'));
const current=patch.find(item=>item.id==='agent-default-model')?.config;
if(current?.provider!=='deepseek-account'||typeof current.model!=='string')throw Error('Current default is not a supported DeepSeek account route');
// Refuse endpoint changes instead of forwarding an account credential elsewhere.
for(const file of ['cordis.yml','cordis.patch.yml']){
 const data=parse(await readFile(profile+'/'+file,'utf8'));
 const walk=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(key==='baseURL'&&typeof item==='string'&&item!=='https://api.deepseek.com/anthropic'&&item!=='https://api.deepseek.com/anthropic/v1')throw Error('Custom endpoint requires separate review');if(typeof item==='object')walk(item);}};walk(data);
}
if(process.env.DEEPSEEK_BASE_URL&&process.env.DEEPSEEK_BASE_URL!=='https://api.deepseek.com/anthropic')throw Error('Custom environment endpoint requires separate review');
if(process.argv.includes('--prepare')){
 const base=join(root,'services/product-api/control-data');await mkdir(base,{recursive:true,mode:0o700});
 const directory=await mkdtemp(join(base,'real-smoke-'));
 await writeFile(join(directory,'authorization.json'),JSON.stringify({scope:'engine-only',provider:current.provider,model:current.model,requests:1,maxOutputTokens:1000,tools:false,retries:0,authorization:'User explicitly approved current DeepSeek account, one tool-free smoke request capped at 1000 output tokens.'},null,2),{mode:0o600});
 console.log(JSON.stringify({prepared:true,directory,model:current.model,requests:0}));
}else{
 const index=process.argv.indexOf('--execute-once');if(index<0||!process.argv[index+1])throw Error('Use --prepare or --execute-once <prepared-directory>');
 const directory=process.argv[index+1];const approval=JSON.parse(await readFile(join(directory,'authorization.json'),'utf8'));
 if(approval.requests!==1||approval.maxOutputTokens!==1000||approval.tools!==false||approval.retries!==0||approval.model!==current.model)throw Error('Authorization mismatch');
 const {attributionHeaders}=await import(installation+'/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
 const resolveToken=async()=>{
  const filename='/Users/xinlin/.dsh/.credentials.yaml';if((await stat(filename)).mode&0o077)throw Error('Credential permissions are too broad');
  const document=parse(await readFile(filename,'utf8'));const record=document.records?.['deepseek-account-platform/default'];
  if(record?.kind!=='grant'||record.payload?.issuer!=='https://platform.deepseek.com')throw Error('Expected official account grant is unavailable');
  return record.payload.token;
 };
 const result=await runSmokeOnce({directory,model:current.model,resolveToken,attribution:attributionHeaders()});
 console.log(JSON.stringify({directory,status:result.status,attempts:result.attempts,modelRequested:result.modelRequested,modelReturned:result.modelReturned,usage:result.usage,text:result.text,scope:result.scope,costStatus:result.costStatus}));
 if(result.status!=='passed')process.exitCode=2;
}
