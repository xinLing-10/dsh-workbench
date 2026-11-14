/** Read-only owner-side account access. Never export this module to a Worker/browser. */
import{readFile,stat}from'node:fs/promises';import{createRequire}from'node:module';
export const installation='/Users/xinlin/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh';
export async function currentAccount(){
 const require=createRequire(installation+'/package.json'),{parse}=require('yaml');const profile='/Users/xinlin/.dsh/profiles/web';
 const patch=parse(await readFile(profile+'/cordis.patch.yml','utf8'));const current=patch.find(v=>v.id==='agent-default-model')?.config;
 if(current?.provider!=='deepseek-account'||typeof current.model!=='string')throw Error('Unsupported current provider');
 for(const file of ['cordis.yml','cordis.patch.yml']){
  const walk=v=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(k==='baseURL'&&typeof x==='string'&&!['https://api.deepseek.com/anthropic','https://api.deepseek.com/anthropic/v1'].includes(x))throw Error('Custom endpoint blocked');if(x&&typeof x==='object')walk(x);}};walk(parse(await readFile(profile+'/'+file,'utf8')));
 }
 if(process.env.DEEPSEEK_BASE_URL&&!['https://api.deepseek.com/anthropic','https://api.deepseek.com/anthropic/v1'].includes(process.env.DEEPSEEK_BASE_URL))throw Error('Custom endpoint blocked');
 const{attributionHeaders}=await import(installation+'/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
 return {model:current.model,attribution:attributionHeaders(),resolveToken:async()=>{const name='/Users/xinlin/.dsh/.credentials.yaml';if((await stat(name)).mode&0o077)throw Error('Credential permissions');const c=parse(await readFile(name,'utf8'));const record=c.records?.['deepseek-account-platform/default'];if(record?.kind!=='grant'||record.payload?.issuer!=='https://platform.deepseek.com')throw Error('Invalid account grant');return record.payload.token;}};
}
