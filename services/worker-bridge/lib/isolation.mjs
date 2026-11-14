/** Docker tool boundary. The trusted controller and model gateway remain outside the container. */
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpath,lstat} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const exec=promisify(execFile);
export function createDockerSandbox({image,workspaceRoot,docker='docker',cpus=1,memoryMb=256,pids=64,timeoutMs=30000,uid=1000,gid=1000,protectedRoots=[]}) {
 if(typeof image!=='string'||!(/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image)||/^sha256:[a-f0-9]{64}$/.test(image)))throw Error('Pin the sandbox image by digest, never a mutable tag');
 if(!workspaceRoot || !Number.isFinite(cpus)||cpus<=0||cpus>2||!Number.isInteger(memoryMb)||memoryMb<64||memoryMb>1024||!Number.isInteger(pids)||pids<8||pids>128||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('Invalid sandbox limits');
 if(!Number.isInteger(uid)||uid<1000||uid>65534||!Number.isInteger(gid)||gid<1000||gid>65534)throw Error('Use an explicit non-root service UID/GID');
 const live=new Set();
 async function check(){await exec(docker,['info','--format','{{.ServerVersion}}'],{timeout:5000});await exec(docker,['image','inspect',image],{timeout:5000,maxBuffer:65536});return {profile:'docker-v1',image,network:'none',readOnly:true,nonRoot:true,uid,gid,cpus,memoryMb,pids,timeoutMs};}
 async function directory(projectId){
  if(!/^[A-Za-z0-9_]+$/.test(projectId))throw Error('Invalid project identity');
  const base=await realpath(workspaceRoot),candidate=join(base,projectId);
  if((await lstat(candidate)).isSymbolicLink())throw Error('Symlink workspace refused');
  const dir=await realpath(candidate);if(!dir.startsWith(base+sep)||dir.includes(',')||dir.includes('\n'))throw Error('Workspace escaped');
  for(const item of protectedRoots){const protectedPath=await realpath(item);if(dir===protectedPath||dir.startsWith(protectedPath+sep)||protectedPath.startsWith(dir+sep))throw Error('Protected source tree cannot be mounted');}
  return dir;
 }
 async function run({projectId,command,signal}){
  if(typeof command!=='string'||!command.trim()||Buffer.byteLength(command)>4096)throw Error('Invalid bounded command');
  signal?.throwIfAborted();const dir=await directory(projectId);await check();signal?.throwIfAborted();
  const name='manager-isolated-'+randomUUID();live.add(name);
  const args=['run','--rm','--pull=never','--name',name,'--label','manager.isolation=docker-v1','--label','manager.instance='+createHash('sha256').update(workspaceRoot).digest('hex'),'--network=none','--read-only','--user',uid+':'+gid,'--cap-drop=ALL','--security-opt=no-new-privileges','--cpus',String(cpus),'--memory',memoryMb+'m','--memory-swap',memoryMb+'m','--pids-limit',String(pids),'--ulimit','nofile=128:128','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--mount','type=bind,src='+dir+',dst=/workspace','--workdir','/workspace','--env','HOME=/tmp','--entrypoint','/bin/sh',image,'-c',command];
  const child=spawn(docker,args,{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT,HOME:process.env.HOME}});
  let output='',overflow=false,terminated=false;
  const stop=()=>{if(terminated)return;terminated=true;void exec(docker,['rm','-f',name],{timeout:10000}).catch(()=>{});child.kill('SIGTERM');};
  const collect=b=>{if(Buffer.byteLength(output)+b.length>16384){overflow=true;stop();return;}output+=b.toString();};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const timer=setTimeout(stop,timeoutMs);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
  try{const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res);});return {code,output,truncated:overflow,stopped:terminated};}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);await exec(docker,['rm','-f',name],{timeout:10000}).catch(()=>{});live.delete(name);}
 }
 return {check,run,async prepare({projectId}){const result=await run({projectId,command:'test -r . && test -w .'});if(result.code!==0 || result.stopped)throw Error('Project sandbox is not writable by configured service UID');return true;},async close(){await Promise.allSettled([...live].map(name=>exec(docker,['rm','-f',name],{timeout:10000})));}};
}
