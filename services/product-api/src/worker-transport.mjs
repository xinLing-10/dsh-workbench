import {randomUUID} from 'node:crypto';
import {signToken,bodyDigest} from '../../../packages/manager-contracts/tokens.mjs';
/** Explicit configured destination only. Do not accept worker URLs from the browser. */
export function createWorkerTransport({url,secret,workerId,fetchImpl=globalThis.fetch}) {
 const base=new URL(url);
 if(base.username || base.password || base.search || base.hash || base.pathname!=='/' || (base.protocol!=='https:' && !(base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))))throw new Error('Worker URL must be HTTPS or loopback HTTP');
 async function call(method,body){const target='/worker/v1/'+method;
  const token=signToken({aud:'manager-worker',sub:'product-api',workerId,...Object.fromEntries(['tenantId','projectId','operationId','leaseId','generation','engineId','payloadHash'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]])),method:'POST',target,jti:randomUUID(),body:bodyDigest(body)},secret,60);
  const response=await fetchImpl(new URL(target,base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(method==='stop'?20000:5000),headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
  const text=await response.text();if(text.length>1024*1024)throw Error('Worker response too large');const result=JSON.parse(text);if(!response.ok || !result.ok)throw Error('Worker RPC failed');return result.data;
 }
 const transport={isolated:false,handshake:async id=>{try{const h=await call('handshake',{workerId:id});transport.isolated=h.isolation?.profile==='docker-v1';return h.workerId===id && h.protocolVersion===1 && h.questions===true && h.approvals===true && h.nativeStop===true;}catch{transport.isolated=false;return false;}},dispatch:job=>call('dispatch',job),observe:job=>call('observe',job),stop:job=>call('stop',job)};return transport;
}
