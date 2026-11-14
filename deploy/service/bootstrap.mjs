/** Creates synthetic acceptance tenants and private test logins. Never resolves a model credential. */
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';import {join,resolve} from 'node:path';import {randomBytes} from 'node:crypto';
import {openDatabase} from '../../services/product-api/src/db.mjs';import {createTenant,createInvite,redeemInvite} from '../../services/product-api/src/auth.mjs';import {registerWorker} from '../../services/product-api/src/workers.mjs';import {createServiceBudget} from '../../services/product-api/src/service-budget.mjs';import {setRunAuthorization} from '../../services/product-api/src/run-authorization.mjs';
const [base,model,image]=process.argv.slice(2);if(!base?.startsWith('/srv/manager-acceptance')||!model||!image)throw Error('bootstrap <acceptance root> <model> <pinned image>');
const privateDir=join(base,'private');if((await stat(privateDir)).mode&0o077)throw Error('Private directory permissions');
const authorization=JSON.parse(await readFile(join(privateDir,'authorization.json'),'utf8')),db=openDatabase(join(base,'data/control/product.sqlite'));
try{
 if(db.prepare('SELECT count(*) n FROM tenants').get().n)throw Error('Bootstrap requires empty acceptance database');setRunAuthorization(db,authorization);const budget=createServiceBudget({db}),accounts=[],pool=[];
 for(let i=0;i<3;i++){
  const tenant=createTenant(db,{name:'虚构验收租户 '+(i+1)}),invite=createInvite(db,{tenantId:tenant.id,ttlMs:60000});const email='acceptance-'+(i+1)+'@example.test',password=randomBytes(24).toString('base64url');const user=await redeemInvite(db,{token:invite.token,email,password});
  if(i===0)db.prepare('INSERT INTO platform_admins VALUES(?,?)').run(user.userId,new Date().toISOString());
  const workerId='wrk_acceptance_'+i,secret=randomBytes(32).toString('hex'),secretFile=join(privateDir,'worker-'+i+'.secret'),configFile=join(privateDir,'worker-'+i+'.json'),port=[8094,8097,8098][i];
  registerWorker(db,{workerId,tenantId:tenant.id,secret});await writeFile(secretFile,secret+'\n',{mode:0o600,flag:'wx'});const directory=join(base,'data/worker-journal',workerId);await mkdir(directory,{recursive:true,mode:0o700});
  await writeFile(configFile,JSON.stringify({formalService:true,workerId,tenantId:tenant.id,secretFile,directory,productApiUrl:'http://127.0.0.1:8099',workspaceRoot:join(base,'data/workspaces'),host:'127.0.0.1',port,model,maxCalls:4,maxOutputTokens:512,isolation:{image,uid:process.getuid(),gid:process.getgid(),cpus:0.5,memoryMb:128,pids:32,timeoutMs:15000}},null,2),{mode:0o600,flag:'wx'});
  pool.push({id:workerId,url:'http://127.0.0.1:'+port,configFile});accounts.push({userId:user.userId,tenantId:tenant.id,email,password,workerId});
 }
 budget.policy(accounts[0].userId,{scope:'global',scopeId:'*',limit:authorization.tokenLimit,window:'lifetime',revision:0,reason:'本轮独立服务器验收授权，保留历史预占'});
 for(const a of accounts)budget.policy(accounts[0].userId,{scope:'user',scopeId:a.userId,limit:authorization.tokenLimit,window:'lifetime',revision:0,reason:'虚构用户服务器验收'});
 await writeFile(join(privateDir,'accounts.json'),JSON.stringify(accounts,null,2),{mode:0o600,flag:'wx'});await writeFile(join(privateDir,'workers.json'),JSON.stringify(pool,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({created:true,tenants:accounts.length,users:accounts.length,workers:pool.length,tokenLimit:authorization.tokenLimit,maxRequests:authorization.maxRequests}));
}finally{db.close();}
