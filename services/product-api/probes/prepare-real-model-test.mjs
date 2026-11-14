/** Offline only: prepare evidence folders and synthetic workspaces. Never calls a model. */
import {readFile,writeFile,mkdtemp,mkdir,cp,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createBridge} from '../src/bridge.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const docs=join(root,'dsh-workbench/docs');
const suite=JSON.parse(await readFile(join(docs,'real-model-test-cases.json'),'utf8'));
const ids=new Set();
if(suite.executionEnabled!==false || suite.approvedBudget!==null || suite.modelId!==null)throw Error('The checked-in suite must not authorize spending or hard-code deployment credentials');
for(const c of suite.cases){
 if(!/^RM-\d{2}$/.test(c.id)||ids.has(c.id)||c.status!=='not_run'||!c.prompt||!Array.isArray(c.steps)||c.steps.length<2||c.expected.length<3||c.evidence.length<2||typeof c.paid!=='boolean')throw Error('Invalid case '+c.id);
 ids.add(c.id);
}
if(ids.size!==24)throw Error('Expected 24 distinct formal cases');
if(process.argv.includes('--validate-only')){console.log(JSON.stringify({valid:true,cases:ids.size,modelRequests:0}));process.exit(0);}
const capabilities=createBridge({config:{simulate:false}}).capabilities();
const gates=[
 {id:'real-dispatch',status:capabilities.bridge?'unverified':'blocked',reason:'真实派发、执行结果查询和停止需要运行证据；当前适配器默认不可用'},
 {id:'real-provenance',status:'unverified',reason:'尚未记录真实模型 ID、上游调用、usage 与操作归属'},
 {id:'approved-budget',status:'unapproved',reason:'模型、硬预算、总调用限制及请求上限需用户确认并由网关落实'},
 {id:'native-approval',status:'unverified',reason:'真实工具许可拒绝与真实追问尚无本轮端到端证据'},
 {id:'workspace-isolation',status:'unverified',reason:'真实 Worker 需限定为测试副本，并验证插件保护与哨兵边界'},
];
let head='unavailable',dirty=true;
try{head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();dirty=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()!=='';}catch{}
const sourceHashes={};
for(const name of ['src/bridge.mjs','src/dispatcher.mjs','src/app.mjs'])sourceHashes[name]=createHash('sha256').update(await readFile(new URL('../'+name,import.meta.url))).digest('hex');
const preflight={schemaVersion:1,at:new Date().toISOString(),readiness:'blocked',realModelExecuted:false,modelRequests:0,head,dirty,sourceHashes,gates};
if(!process.argv.includes('--prepare')){console.log(JSON.stringify(preflight,null,2));process.exitCode=2;}
else{
 const directory=await mkdtemp(join(tmpdir(),'dsh-real-model-test-'));
 await mkdir(join(directory,'workspaces/new-blog'),{recursive:true});
 await cp(join(root,'fixtures/real-model/personal-blog-v0'),join(directory,'workspaces/existing-blog'),{recursive:true});
 const hashes={};for(const name of await readdir(join(directory,'workspaces/existing-blog')))hashes[name]=createHash('sha256').update(await readFile(join(directory,'workspaces/existing-blog',name))).digest('hex');
 await writeFile(join(directory,'fixture-baseline.json'),JSON.stringify(hashes,null,2));
 const record={runId:directory.split('/').pop(),status:'prepared_blocked',modelId:null,provider:null,approvedBudget:null,requestLimits:null,operatorApproval:null,preflight:'preflight.json',cases:suite.cases.map(c=>({id:c.id,title:c.title,status:'not_run',startedAt:null,endedAt:null,operationIds:[],workerIds:[],upstreamRequestIds:[],usage:null,cost:null,evidence:[],defects:[],notes:''}))};
 await writeFile(join(directory,'run-record.json'),JSON.stringify(record,null,2),{mode:0o600});
 await writeFile(join(directory,'preflight.json'),JSON.stringify(preflight,null,2),{mode:0o600});
 await cp(join(docs,'real-model-test-cases.json'),join(directory,'cases.json'));
 await cp(join(docs,'real-model-test-plan.md'),join(directory,'TEST-PLAN.md'));
 for(const c of suite.cases)await mkdir(join(directory,'evidence',c.id),{recursive:true});
 await writeFile(join(directory,'START-HERE.md'),'# 已准备，尚未执行真实模型测试\n\n先阅读 TEST-PLAN.md 和 preflight.json。当前真实执行接入被阻断，所有案例仍为 not_run。\n\n只允许测试 Worker 访问 workspaces 中相应项目，不可授予整个仓库或整台电脑。不得在 run-record.json 和证据中放密钥。模型和预算未经确认前不要发请求。\n');
 console.log(JSON.stringify({prepared:true,directory,readiness:'blocked',cases:ids.size,realModelExecuted:false,modelRequests:0},null,2));
}
