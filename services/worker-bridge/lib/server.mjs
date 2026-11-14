/** Private Worker RPC: signed control requests only; not a browser endpoint. */
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {verifyToken} from './token-contract.mjs';
export function createWorkerServer({runner,workerId,secret,nonceDirectory}) {
 return createServer(async(req,res)=>{
  try{
   if(req.method!=='POST' || !['/worker/v1/handshake','/worker/v1/dispatch','/worker/v1/observe','/worker/v1/stop'].includes(req.url))throw Object.assign(new Error('Unknown RPC'),{status:404});
   let raw='';for await(const part of req){raw+=part;if(Buffer.byteLength(raw)>65536)throw Object.assign(new Error('Body too large'),{status:413});}
   const body=JSON.parse(raw || '{}'),token=String(req.headers.authorization || '').replace(/^Bearer /,'');
   const verified=verifyToken(token,secret,{audience:'manager-worker',body,skewSeconds:0}),c=verified.claims;
   if(!verified.ok || c.sub!=='product-api' || c.workerId!==workerId || c.method!==req.method || c.target!==req.url || c.exp<=Math.floor(Date.now()/1000) || c.exp-c.iat>90 || !/^[A-Za-z0-9_-]{8,128}$/.test(c.jti || ''))throw Object.assign(new Error('Worker authentication failed'),{status:403});
   if(req.url!=='/worker/v1/handshake' && ['tenantId','projectId','operationId','leaseId','generation','engineId','payloadHash'].some(k=>c[k]!==body[k]))throw Object.assign(new Error('Execution scope mismatch'),{status:403});
   await mkdir(nonceDirectory,{recursive:true,mode:0o700});try{await writeFile(join(nonceDirectory,c.jti),'',{flag:'wx',mode:0o600});}catch{throw Object.assign(new Error('Control request replay'),{status:403});}
   const method=req.url.split('/').at(-1);const data=method==='handshake'?(runner.health?await runner.health():runner.capabilities):await runner[method](body);
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data}));
  }catch(error){res.writeHead(error.status || 409,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:'conflict',message:error.message}}));}
 });
}
