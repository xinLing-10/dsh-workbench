import {createWorkerPool} from './src/worker-pool.mjs';
import {setRunAuthorization} from './src/run-authorization.mjs';
import {createServiceBudget} from './src/service-budget.mjs';
import {createModelGateway} from './src/model-gateway.mjs';
import {readFile,stat} from 'node:fs/promises';
import { createWorkerCoordinator } from './src/worker-executions.mjs';
import { createWorkerTransport } from './src/worker-transport.mjs';
import { createDispatcher } from './src/dispatcher.mjs';
import { createServer } from 'node:http';
import { loadConfig } from './src/config.mjs';
import { openDatabase } from './src/db.mjs';
import { createApp, appendEvent } from './src/app.mjs';
import { createBridge } from './src/bridge.mjs';
import { createInvite, createTenant } from './src/auth.mjs';

const config = loadConfig();
const db = openDatabase(config.dbPath);
if(config.simulate && config.workerProtocol)throw Error('Choose simulation or Worker v1, never both');
let coordinator=null;
const bridge = config.workerProtocol ? {capabilities:()=>({...coordinator?.capabilities(),paused:config.modelCallsPaused||false}),cancel:body=>coordinator.cancel(body),recoverOperation:body=>coordinator.recoverOperation(body),workerCapabilities:id=>coordinator?.workerCapabilities?coordinator.workerCapabilities(id):coordinator?.capabilities()||{}} : createBridge({ config });
if(process.env.PRODUCT_API_ACCEPTANCE_AUTHORIZATION_FILE){const file=process.env.PRODUCT_API_ACCEPTANCE_AUTHORIZATION_FILE;if((await stat(file)).mode&0o077)throw Error('Acceptance authorization file must be private');setRunAuthorization(db,JSON.parse(await readFile(file,'utf8')));}
const serviceBudget=createServiceBudget({db});
let modelGateway=null;
if(config.formalService && (!config.workerProtocol || config.simulate))throw Error('Formal service requires Worker protocol');
if(config.formalService && !config.modelCallsPaused){
 if(!config.workerProtocol || config.simulate)throw Error('Formal service requires isolated Worker protocol, never simulation');
 const file=process.env.PRODUCT_API_MODEL_CREDENTIAL_FILE,model=process.env.PRODUCT_API_MODEL;
 if(!file||!model)throw Error('Explicit private model credential file and model required');
 const meta=await stat(file);if(!meta.isFile() || meta.mode&0o077)throw Error('Model credential file must be private (0600)');
 modelGateway=createModelGateway({budget:serviceBudget,model,attribution:process.env.PRODUCT_API_MODEL_USER_AGENT?{'user-agent':process.env.PRODUCT_API_MODEL_USER_AGENT}:{},resolveToken:async()=>{if((await stat(file)).mode&0o077)throw Error('Credential file permission changed');return (await readFile(file,'utf8')).trim();}});
 serviceBudget.expireHolds();
}
const app = createApp({ db, config, bridge, modelGateway });

// `node server.mjs --check-invite <token>` verifies a token against this database.
if (process.argv.includes('--check-invite')) {
  const token = process.argv[process.argv.indexOf('--check-invite') + 1] || '';
  const { createHash } = await import('node:crypto');
  const row = token
    ? db.prepare('SELECT id, tenant_id, created_at, expires_at, redeemed_at FROM invites WHERE token_hash = ?')
        .get(createHash('sha256').update(token.trim()).digest('hex'))
    : undefined;
  console.log(JSON.stringify({
    database: config.dbPath,
    found: Boolean(row),
    redeemed: Boolean(row && row.redeemed_at),
    expired: Boolean(row && Date.parse(row.expires_at) < Date.now()),
    tenantId: row ? row.tenant_id : null,
    expiresAt: row ? row.expires_at : null,
  }, null, 2));
  process.exit(row ? 0 : 1);
}

// `node server.mjs --invite "<tenant name>"` prints one invitation token and exits.
if (process.argv.includes('--invite')) {
  const name = process.argv[process.argv.indexOf('--invite') + 1] || '个人租户';
  const tenant = createTenant(db, { name });
  const invite = createInvite(db, { tenantId: tenant.id, ttlMs: config.inviteTtlMs });
  console.log(JSON.stringify({ tenantId: tenant.id, token: invite.token, expiresAt: invite.expiresAt }));
  process.exit(0);
}

if(config.workerProtocol){
  let configured=[{id:config.workerId,url:config.workerBaseUrl}];
  if(config.workerPoolFile){if((await stat(config.workerPoolFile)).mode&0o077)throw Error('Worker pool config must be private');configured=JSON.parse(await readFile(config.workerPoolFile,'utf8'));}
  const workers=configured.map(item=>{const w=db.prepare("SELECT * FROM workers WHERE id=? AND status='active'").get(item.id);if(!w)throw Error('Register every configured Worker first');return {id:w.id,transport:createWorkerTransport({url:item.url,workerId:w.id,secret:w.secret})};});
  coordinator=config.workerPoolFile?createWorkerPool({db,workers,append:appendEvent,publish:app.publish,budget:config.formalService?serviceBudget:null,requireIsolation:config.formalService,paused:()=>config.modelCallsPaused}):createWorkerCoordinator({db,workerId:workers[0].id,transport:workers[0].transport,append:appendEvent,publish:app.publish,budget:config.formalService?serviceBudget:null,requireIsolation:config.formalService,paused:()=>config.modelCallsPaused});
}

const server = createServer((req, res) => {
  app.handle(req, res).catch((error) => {
    console.error('[product-api]', error);
    if (!res.headersSent) res.writeHead(500).end();
  });
});

let pendingTick = Promise.resolve();
let stopped = false;
let dispatching = false;
const dispatcher = config.simulate ? createDispatcher({ db, enabled: true, interactive: config.simulationFlow, publish: app.publish }) : coordinator;
const interval = dispatcher ? setInterval(() => {
  if (stopped || dispatching) return;
  dispatching = true;
  pendingTick = dispatcher.tick().catch(() => console.error('[product-api] dispatch failed; check persisted operation state')).finally(() => { dispatching = false; });
}, 1000) : null;
interval?.unref();

server.listen(config.port, config.host, () => {
  console.log(`[product-api] listening on http://${config.host}:${config.port} (db: ${config.dbPath})`);
  console.log('[product-api] capabilities:', JSON.stringify(bridge.capabilities()));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopped = true;
    if (interval) clearInterval(interval);
    server.close(async () => {
      await pendingTick;
      app.managerCore.dispose();
      db.close();
      process.exit(0);
    });
  });
}
