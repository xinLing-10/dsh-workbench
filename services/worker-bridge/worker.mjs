/** Explicit private Worker daemon. Engine module and credentials are operator configuration. */
import {existsSync} from 'node:fs';
import {readFile,stat} from 'node:fs/promises';import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';
import {createDockerSandbox} from './lib/isolation.mjs';
import {createIsolatedRuntime} from './lib/isolated-runtime.mjs';
import {createWorkerRunner} from './lib/runner.mjs';import {createWorkerServer} from './lib/server.mjs';
if(!process.argv.includes('--config'))throw Error('Explicit --config file required');
const configFile=resolve(process.argv[process.argv.indexOf('--config')+1] || '');
if((await stat(configFile)).mode&0o077)throw Error('Worker configuration must be private (0600)');
const config=JSON.parse(await readFile(configFile,'utf8'));
if(!['127.0.0.1','::1','localhost'].includes(config.host || '127.0.0.1'))throw Error('Bind Worker to loopback; use a separate HTTPS ingress for remote transport');
if((await stat(config.secretFile)).mode&0o077)throw Error('Worker secret must be private (0600)');
const secret=(await readFile(config.secretFile,'utf8')).trim();if(secret.length<32)throw Error('Invalid Worker secret');
let runtime,isolation,isolationCheck;
if(config.formalService===true){
 const candidateRoot=resolve(import.meta.dirname,'../..');
 const protectedRoots=[existsSync(resolve(candidateRoot,'dsh-workbench'))?candidateRoot:import.meta.dirname,...(config.isolation?.protectedRoots || [])];
 const sandbox=createDockerSandbox({...config.isolation,workspaceRoot:config.workspaceRoot,protectedRoots});
 isolationCheck=()=>sandbox.check();isolation=await isolationCheck();runtime=createIsolatedRuntime({...config,sandbox});
}else{
 if(typeof config.engineModule!=='string' || !config.engineModule.startsWith('/'))throw Error('Use an explicit trusted engine module absolute path');
 const {createRuntime}=await import(pathToFileURL(config.engineModule));runtime=await createRuntime(config);
}
const runner=createWorkerRunner({...config,secret,execute:runtime.execute,isolation,isolationCheck});
const server=createWorkerServer({runner,workerId:config.workerId,secret,nonceDirectory:resolve(config.directory,'control-nonces')});
await new Promise(r=>server.listen(config.port || 8094,config.host || '127.0.0.1',r));
console.log(JSON.stringify({ready:true,protocolVersion:1,workerId:config.workerId,port:server.address().port}));
let stopped=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(stopped)return;stopped=true;await runner.close();await runtime.close?.();server.close(()=>process.exit(0));});
