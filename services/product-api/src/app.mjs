import {invitationOverview,issueInvitation} from './admin-invitations.mjs';
import {serviceDashboard} from './service-dashboard.mjs';
import {createServiceBudget,isPlatformAdmin} from './service-budget.mjs';
import { executionFor, executionClaims, requireExecution, acceptWorkerEvent } from './worker-executions.mjs';
import { bodyDigest } from '../../../packages/manager-contracts/tokens.mjs';
import { createProductManager } from './manager-core.mjs';
import { assertCurrentDocument } from '../../../packages/manager-core/index.mjs';
import { authenticateWorker, leaseIsActive } from './workers.mjs';
import { normalizeQuestions, validateQuestionAnswer } from '../../../packages/manager-contracts/questions.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createWorkspace } from './workspace.mjs';
import {
  API_PREFIX, ERROR_CODES, eventEnvelope, idempotencyDecision, parseAction, publicId,
} from './contracts.mjs';
import {
  authenticate, createSession, createTenant, createInvite, login, quotaView, redeemInvite, revokeSession,
} from './auth.mjs';
import { clientIp, createRateLimiter, originAllowed, parseCookies, readJson, sendError, sendJson, setCookie } from './http.mjs';

const SESSION_COOKIE = 'pm_session';
const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @returns one project row when it belongs to the tenant, otherwise null. */
function projectFor(db, tenantId, projectId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND tenant_id = ?').get(projectId, tenantId) || null;
}

/** Append a project event and return it as a contract envelope. */
export function appendEvent(db, { tenantId, projectId, type, operationId = null, payload = null }) {
  const revision = (db.prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM project_events WHERE project_id = ?').get(projectId).r || 0) + 1;
  const at = nowIso();
  const info = db.prepare('INSERT INTO project_events (tenant_id, project_id, type, operation_id, revision, payload_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tenantId, projectId, type, operationId, revision, payload === null ? null : json(payload), at);
  return eventEnvelope({ id: Number(info.lastInsertRowid), projectId, type, operationId, revision, at, payload });
}

/**
 * Build the product API.
 *
 * Every project route resolves ownership from the session first; the browser
 * never sends a filesystem root, board id or native session id.
 */
export function createApp({ db, config, bridge, managerRuntime = null, modelGateway = null, clock = () => new Date() }) {
  const serviceBudget=createServiceBudget({db,clock});
  const workspace = createWorkspace({ root: config.workspaceRoot || '' });
  const managerCore = createProductManager({db,workspace,runtime:managerRuntime});
  const artifactBytes = async artifact => {
    const snapshot = db.prepare('SELECT bytes FROM artifact_contents WHERE artifact_id = ?').get(artifact.id);
    if (snapshot) {
      const bytes = Buffer.from(snapshot.bytes);
      if (sha256(bytes) !== artifact.sha256) throw Object.assign(new Error('文档版本校验失败'), {status:409});
      return bytes;
    }
    const stored = db.prepare('SELECT content FROM simulation_documents WHERE artifact_id = ?').get(artifact.id);
    if (stored) {
      const bytes = Buffer.from(stored.content, 'utf8');
      if (sha256(bytes) !== artifact.sha256) throw Object.assign(new Error('示例文档校验失败'), { status: 409 });
      return bytes;
    }
    const { path } = await workspace.resolveArtifact(artifact.project_id, artifact.relative_path);
    return readFile(path);
  };
  const limitLogin = createRateLimiter({ limit: 10, windowMs: 60_000 });
  const subscribers = new Map(); // projectId -> Set<(event) => void>
  const startedAt = clock().toISOString();

  const subscribe = (projectId, listener) => {
    const set = subscribers.get(projectId) || new Set();
    set.add(listener);
    subscribers.set(projectId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) subscribers.delete(projectId);
    };
  };

  const emit = (event) => {
    for (const listener of subscribers.get(event.projectId) || []) listener(event);
  };

  const sessionFor = (req) => authenticate(db, parseCookies(req.headers.cookie)[SESSION_COOKIE]);

  /**
   * Authenticate one internal worker call: bearer token, audience, body digest
   * and single-use jti. Returns the claims or an error code string.
   */
  const internalClaims = (req, body) => authenticateWorker(db, req, body);

  const requireSession = (req, res) => {
    const session = sessionFor(req);
    if (!session) {
      sendError(res, 401, ERROR_CODES.unauthorized, '请先登录');
      return null;
    }
    if (!originAllowed(req, config)) {
      sendError(res, 403, ERROR_CODES.forbidden, '请求来源不被接受');
      return null;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || token !== session.csrfToken) {
        sendError(res, 403, ERROR_CODES.csrf, '缺少或错误的 CSRF 令牌');
        return null;
      }
    }
    return session;
  };

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const adminRoute=(method,suffix,handler)=>route(method,new RegExp('^/api/v1/admin/'+suffix+'$'),async({req,res})=>{
    const session=requireSession(req,res);if(!session)return;
    if(!isPlatformAdmin(db,session.userId)){sendError(res,403,ERROR_CODES.forbidden,'仅平台管理员可访问');return;}
    const body=method==='POST'?await readJson(req,config.maxBodyBytes):null;
    sendJson(res,200,{ok:true,data:await handler(session,body)});
  });
  adminRoute('GET','service',()=>({...serviceBudget.overview(),dashboard:serviceDashboard({db,bridge,config}),enabled:Boolean(config.formalService),environment:{required:config.formalService?'docker-v1':'not-enforced',workerReady:Boolean(bridge.capabilities().isolated),modelGateway:Boolean(modelGateway)}}));
  adminRoute('GET','invitations',()=>invitationOverview(db,config));
  adminRoute('POST','invitations',(session,body)=>issueInvitation(db,config,session.userId,body));
  adminRoute('POST','budgets',(s,b)=>serviceBudget.policy(s.userId,b));
  adminRoute('POST','executions/check',async(s,b)=>{
    const run=executionFor(db,String(b.operationId||''));if(!run)throw Object.assign(new Error('执行不存在'),{status:404});
    if(!bridge.recoverOperation)throw Object.assign(new Error('观察服务未连接'),{status:503});
    await bridge.recoverOperation({operationId:run.operation_id,projectId:run.project_id,tenantId:run.tenant_id});
    return {operationId:run.operation_id,state:executionFor(db,run.operation_id).state,redispatched:false};
  });
  adminRoute('POST','reconcile',(s,b)=>b.kind==='legacy'?serviceBudget.reconcileCarryover(s.userId,b):serviceBudget.reconcile(s.userId,b));
  route('POST',/^\/internal\/v1\/model-messages$/,async({req,res})=>{
    const body=await readJson(req,config.maxBodyBytes),claims=internalClaims(req,body);
    if(typeof claims==='string'){sendInternalFailure(res,claims);return;}
    if(config.modelCallsPaused || !config.formalService || !modelGateway || !(bridge.workerCapabilities?bridge.workerCapabilities(claims.sub):bridge.capabilities()).isolated){sendError(res,503,ERROR_CODES.capability_unavailable,'正式模型网关未启用');return;}
    const run=requireExecution(db,claims);if(!run){sendError(res,409,ERROR_CODES.conflict,'需要统一 Worker 执行记录');return;}
    serviceBudget.expireHolds();
    const controller=new AbortController();const abort=()=>{if(!res.writableEnded)controller.abort();};res.on('close',abort);
    try{const data=await modelGateway.message({operationId:claims.operationId,id:body.id,body:body.body,signal:controller.signal,authorizeDispatch:()=>requireExecution(db,claims)});if(!res.destroyed)sendJson(res,200,{ok:true,data});}finally{res.off('close',abort);}
  });

  // requireSession enforces authentication, Origin AND CSRF for every POST.
  // Resolve tenant ownership before parsing input or touching any workspace.
  const coreRoute=(method,suffix,handler)=>route(method,new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/${suffix}$`),async({req,res,params,url})=>{
    const session=requireSession(req,res);if(!session)return;
    const project=projectFor(db,session.tenantId,params.id);
    if(!project){sendError(res,404,ERROR_CODES.not_found,'项目不存在');return;}
    const body=method==='POST'?await readJson(req,config.maxBodyBytes):undefined;
    const data=await handler(project,body,url);
    if(method==='POST')emit(appendEvent(db,{tenantId:session.tenantId,projectId:project.id,type:'task_status',payload:{sharedCore:true}}));
    sendJson(res,200,{ok:true,data});
  });
  coreRoute('GET','manager',async p=>({coreVersion:managerCore.version,manager:await managerCore.view(p)}));
  coreRoute('POST','manager/actions',async(p,b)=>({manager:await managerCore.mutate(p,b)}));
  coreRoute('GET','knowledge',async(p,b,url)=>managerCore.knowledge(p).view(Object.fromEntries(url.searchParams)));
  coreRoute('POST','knowledge',async(p,b)=>managerCore.knowledge(p).update(b));
  coreRoute('GET','document-review',async(p,b,url)=>managerCore.documents(p).review(url.searchParams.get('name'),url.searchParams.get('approval') || ''));
  coreRoute('POST','document-review/comments',async(p,b)=>managerCore.documents(p).comment(b));
  coreRoute('GET','learning',async p=>({learning:await managerCore.learning(p).view()}));
  coreRoute('GET','learning/sources',async p=>managerCore.learning(p).sources());
  coreRoute('POST','learning/context',async(p,b)=>managerCore.learning(p).context(b.paths));
  coreRoute('POST','learning/actions',async(p,b)=>({manager:await managerCore.learning(p).mutate(b)}));

  route('GET', /^\/$/, ({ res }) => {
    sendStatic(res, 'index.html');
  });

  route('GET', /^\/app\.js$/, ({ res }) => {
    sendStatic(res, 'app.js');
  });

  route('GET', /^\/message-format\.mjs$/, ({ res }) => { sendStatic(res, 'message-format.mjs'); });

  route('GET', /^\/styles\.css$/, ({ res }) => {
    sendStatic(res, 'styles.css');
  });

  route('GET', /^\/healthz$/, ({ res }) => {
    sendJson(res, 200, { ok: true, data: { status: 'up', startedAt, capabilities: bridge.capabilities() } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/invitations/redeem$`), async ({ req, res }) => {
    if (!config.allowRedeem) {
      sendError(res, 403, ERROR_CODES.forbidden, '邀请兑换当前未开放');
      return;
    }
    if (!limitLogin(clientIp(req))) {
      sendError(res, 429, ERROR_CODES.rate_limited, '尝试次数过多，请稍后再试');
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    let result;
    try {
      result = await redeemInvite(db, { token: body.token, email: body.email, password: body.password });
    } catch (error) {
      const messages = {
        'invite not found': '邀请码不存在，请向管理员核对完整邀请码和服务地址',
        'invite already redeemed': '这个邀请码已经被使用过，请重新生成',
        'invite expired': '邀请码已过期，请重新生成',
        'email already registered': '这个邮箱已经注册过了，直接登录即可',
        'invalid email': '邮箱格式不正确',
        'invalid invite token': '邀请码格式不正确',
      };
      sendError(res, 400, ERROR_CODES.validation, messages[error.message] || error.message);
      return;
    }
    const session = createSession(db, { userId: result.userId, tenantId: result.tenantId, ttlMs: config.sessionTtlMs });
    setCookie(res, SESSION_COOKIE, session.sessionId, { maxAgeSec: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure });
    sendJson(res, 201, { ok: true, data: { userId: result.userId, tenantId: result.tenantId } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/auth/login$`), async ({ req, res }) => {
    if (!limitLogin(clientIp(req))) {
      sendError(res, 429, ERROR_CODES.rate_limited, '尝试次数过多，请稍后再试');
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    let session;
    try {
      session = await login(db, { email: body.email, password: body.password, ttlMs: config.sessionTtlMs });
    } catch {
      sendError(res, 401, ERROR_CODES.unauthorized, '邮箱或密码不正确');
      return;
    }
    setCookie(res, SESSION_COOKIE, session.sessionId, { maxAgeSec: Math.floor(config.sessionTtlMs / 1000), secure: config.cookieSecure });
    sendJson(res, 200, { ok: true, data: { csrfToken: session.csrfToken } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/auth/logout$`), async ({ req, res }) => {
    const session = requireSession(req, res);
    if (!session) return;
    revokeSession(db, session.sessionId);
    setCookie(res, SESSION_COOKIE, '', { maxAgeSec: 0, secure: config.cookieSecure });
    sendJson(res, 200, { ok: true, data: { loggedOut: true } });
  });

  route('GET', new RegExp(`^${API_PREFIX}/me$`), async ({ req, res }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const tenant = db.prepare('SELECT id, name FROM tenants WHERE id = ?').get(session.tenantId);
    sendJson(res, 200, {
      ok: true,
      data: {
        user: { id: session.userId, email: session.email, platformAdmin:isPlatformAdmin(db,session.userId) },
        tenant,
        csrfToken: session.csrfToken,
        capabilities: bridge.capabilities(),
        quota: quotaView(db, session.tenantId),
        serviceBudget: config.formalService ? serviceBudget.view('user',session.userId) : null,
      },
    });
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects$`), async ({ req, res }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const rows = db.prepare('SELECT * FROM projects WHERE tenant_id = ? ORDER BY updated_at DESC').all(session.tenantId);
    sendJson(res, 200, { ok: true, data: { projects: rows.map(projectView) } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/projects$`), async ({ req, res }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const body = await readJson(req, config.maxBodyBytes);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '' || name.length > 80) {
      sendError(res, 400, ERROR_CODES.validation, '项目名需要 1-80 个字符');
      return;
    }
    const id = publicId('prj');
    const at = nowIso();
    if(config.formalService)await workspace.provisionProject(id);
    db.prepare('INSERT INTO projects (id, tenant_id, name, workspace_key, board_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(id, session.tenantId, name, `ws_${randomBytes(8).toString('hex')}`, 'active', at, at);
    appendEvent(db, { tenantId: session.tenantId, projectId: id, type: 'task_status', payload: { state: 'created' } });
    sendJson(res, 201, { ok: true, data: { project: projectView(projectFor(db, session.tenantId, id)) } });
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const operations = db.prepare("SELECT * FROM operations WHERE project_id = ? ORDER BY CASE WHEN state IN ('waiting','running','uncertain') THEN 0 WHEN state='queued' THEN 1 ELSE 2 END, created_at DESC LIMIT 20").all(project.id);
    const interactions = db.prepare("SELECT * FROM interaction_requests WHERE project_id = ? AND state = 'pending' AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").all(project.id);
    sendJson(res, 200, {
      ok: true,
      data: {
        project: projectView(project),
        operations: operations.map(operationView),
        interactions: interactions.map(interactionView),
        capabilities: bridge.capabilities(),
      },
    });
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/messages$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const rows = db.prepare("SELECT * FROM project_events WHERE project_id = ? AND type IN ('message_created','message_completed','interaction_answered') ORDER BY id").all(project.id);
    sendJson(res, 200, { ok: true, data: { messages: rows.map(messageView) } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/messages$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const requestId = String(body.requestId || '');
    if (text === '' || text.length > 8000) {
      sendError(res, 400, ERROR_CODES.validation, '消息需要 1-8000 个字符');
      return;
    }
    if (bridge.capabilities().readonly && Buffer.byteLength(text, 'utf8') > 6000) {
      sendError(res, 400, ERROR_CODES.validation, '真实答疑验证每条消息最多 6000 字节，请分成几个简短问题。');
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) {
      sendError(res, 400, ERROR_CODES.validation, '缺少有效请求编号');
      return;
    }
    const payloadHash = sha256(json({ type: 'send_message', text }));
    const existing = db.prepare('SELECT * FROM operations WHERE tenant_id = ? AND project_id = ? AND request_id = ?')
      .get(session.tenantId, project.id, requestId);
    const decision = idempotencyDecision(existing ? { payloadHash: existing.payload_hash } : null, payloadHash);
    if (decision === 'conflict') {
      sendError(res, 409, ERROR_CODES.conflict, '同一请求编号携带了不同内容');
      return;
    }
    if (decision === 'replay') {
      sendJson(res, 200, { ok: true, data: { operation: operationView(existing), dispatch: 'replayed' } });
      return;
    }
    if (bridge.capabilities().paused) { sendError(res,409,ERROR_CODES.capability_unavailable,'模型调用已暂停，请联系管理员核对用量；历史仍可查看，不要重复发送。'); return; }
    if(config.formalService){serviceBudget.expireHolds();serviceBudget.checkIdentity(session.userId,project.id);}
    const id = publicId('op');
    const at = nowIso();
    let event;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("INSERT INTO operations (id, tenant_id, project_id, type, request_id, payload_hash, state, created_at, updated_at, simulation_flow, actor_user_id) VALUES (?, ?, ?, 'send_message', ?, ?, 'queued', ?, ?, ?, ?)")
        .run(id, session.tenantId, project.id, requestId, payloadHash, at, at, config.simulationFlow ? 1 : 0, session.userId);
      db.prepare('INSERT INTO operation_outbox (operation_id, event, next_at, created_at) VALUES (?, ?, ?, ?)')
        .run(id, 'dispatch', at, at);
      event = appendEvent(db, {
        tenantId: session.tenantId,
        projectId: project.id,
        type: 'message_created',
        operationId: id,
        payload: { text, state: 'queued' },
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    emit(event);
    sendJson(res, 202, {
      ok: true,
      data: { operation: operationView(db.prepare('SELECT * FROM operations WHERE id = ?').get(id)), dispatch: config.simulate ? 'simulation_queued' : bridge.capabilities().workerProtocol ? 'worker_queued' : bridge.capabilities().readonly ? 'readonly_queued' : 'unavailable', capabilities: bridge.capabilities() },
    });
  });

  route('POST', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/actions$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    const action = parseAction(body.action);
    if (action === null) {
      sendError(res, 400, ERROR_CODES.validation, '不支持的动作');
      return;
    }
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(String(body.requestId || ''))) {
      sendError(res, 400, ERROR_CODES.validation, '缺少有效请求编号');
      return;
    }
    if (action === 'cancel_operation' && (bridge.capabilities().nativeStop === true || config.workerProtocol===true)) {
      const operation = db.prepare('SELECT * FROM operations WHERE id=? AND tenant_id=? AND project_id=?').get(String(body.operationId || ''),session.tenantId,project.id);
      if (!operation) { sendError(res,404,ERROR_CODES.not_found,'任务不存在'); return; }
      if(operation.state==='queued' && (bridge.capabilities().workerProtocol || config.workerProtocol)){
        let cancelled;db.exec('BEGIN IMMEDIATE');try{
          cancelled=db.prepare("UPDATE operations SET state='cancelled',updated_at=? WHERE id=? AND state='queued' AND NOT EXISTS(SELECT 1 FROM worker_executions WHERE operation_id=?)").run(nowIso(),operation.id,operation.id);
          if(cancelled.changes){db.prepare('DELETE FROM operation_outbox WHERE operation_id=?').run(operation.id);const event=appendEvent(db,{tenantId:session.tenantId,projectId:project.id,operationId:operation.id,type:'task_status',payload:{state:'cancelled',workerProtocol:true,notDispatched:true}});db.exec('COMMIT');emit(event);sendJson(res,200,{ok:true,data:{state:'cancelled',notDispatched:true,engineAcknowledged:false}});return;}
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        sendError(res,409,ERROR_CODES.conflict,'任务已开始派发，请刷新后再停止');return;
      }
      if (operation.state === 'cancelled') { const executed=Boolean(executionFor(db,operation.id));sendJson(res,200,{ok:true,data:{state:'cancelled',engineAcknowledged:executed,notDispatched:!executed}}); return; }
      if (!['running','waiting'].includes(operation.state)) { sendError(res,409,ERROR_CODES.conflict,'当前任务不处于可停止状态'); return; }
      let result;try { result = await bridge.cancel({operationId:operation.id,projectId:project.id,tenantId:session.tenantId}); } catch { result=null; }
      const acknowledged = result?.state==='cancelled' && result?.engineAcknowledged===true;
      const events=[];db.exec('BEGIN IMMEDIATE');
      try {
        const changed=db.prepare("UPDATE operations SET state=?,updated_at=? WHERE id=? AND state IN ('running','waiting')").run(acknowledged?'cancelled':'uncertain',nowIso(),operation.id);
        if(changed.changes){
          if(acknowledged){
            const cards=db.prepare("SELECT id FROM interaction_requests WHERE operation_id=? AND project_id=? AND state='pending'").all(operation.id,project.id);
            db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND project_id=? AND state='pending'").run(operation.id,project.id);
            db.prepare("UPDATE worker_leases SET state='revoked' WHERE operation_id=? AND project_id=? AND state='active'").run(operation.id,project.id);
            db.prepare('DELETE FROM operation_outbox WHERE operation_id=?').run(operation.id);
            for(const card of cards)events.push(appendEvent(db,{tenantId:session.tenantId,projectId:project.id,operationId:operation.id,type:'interaction_cancelled',payload:{interactionId:card.id,native:true}}));
          }
          events.push(appendEvent(db,{tenantId:session.tenantId,projectId:project.id,operationId:operation.id,type:'task_status',payload:{state:acknowledged?'cancelled':'uncertain',native:true}}));
        }
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
      for(const event of events)emit(event);
      if(acknowledged && db.prepare('SELECT state FROM operations WHERE id=?').get(operation.id)?.state!=='cancelled'){sendError(res,409,ERROR_CODES.conflict,'任务状态已变化，请刷新后核对');return;}
      if(!acknowledged){sendError(res,409,ERROR_CODES.conflict,'尚未取得引擎停止回执，结果待核对，不会自动重试');return;}
      sendJson(res,200,{ok:true,data:{state:'cancelled',engineAcknowledged:true}});return;
    }
    if (action === 'cancel_operation' && config.simulate) {
      const operation = db.prepare('SELECT * FROM operations WHERE id=? AND tenant_id=? AND project_id=?').get(String(body.operationId || ''),session.tenantId,project.id);
      if (!operation) { sendError(res,404,ERROR_CODES.not_found,'任务不存在'); return; }
      if (operation.state === 'cancelled') { sendJson(res,200,{ok:true,data:{state:'cancelled'}}); return; }
      const events = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        const changed = db.prepare("UPDATE operations SET state='cancelled',updated_at=? WHERE id=? AND state IN ('queued','waiting') AND NOT EXISTS(SELECT 1 FROM simulation_receipts WHERE operation_id=?)").run(nowIso(),operation.id,operation.id);
        if (!changed.changes) { db.exec('ROLLBACK'); sendError(res,409,ERROR_CODES.conflict,'当前任务不能安全取消，请先查看最新状态'); return; }
        const pending = db.prepare("SELECT id FROM interaction_requests WHERE operation_id=? AND project_id=? AND state='pending'").all(operation.id,project.id);
        db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND project_id=? AND state='pending'").run(operation.id,project.id);
        db.prepare("UPDATE worker_leases SET state='revoked' WHERE operation_id=? AND project_id=? AND state='active'").run(operation.id,project.id);
        db.prepare("UPDATE dispatch_runs SET state='completed' WHERE operation_id=?").run(operation.id);
        db.prepare("UPDATE simulation_flows SET stage='cancelled' WHERE operation_id=?").run(operation.id);
        db.prepare('DELETE FROM operation_outbox WHERE operation_id=?').run(operation.id);
        for (const item of pending) events.push(appendEvent(db,{tenantId:session.tenantId,projectId:project.id,operationId:operation.id,type:'interaction_cancelled',payload:{interactionId:item.id,simulation:true}}));
        events.push(appendEvent(db,{tenantId:session.tenantId,projectId:project.id,operationId:operation.id,type:'task_status',payload:{state:'cancelled',simulation:true}}));
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      for (const event of events) emit(event);
      sendJson(res,200,{ok:true,data:{state:'cancelled'}}); return;
    }
    const needsEngine = ['send_message', 'start_proposed_work', 'confirm_artifact', 'request_changes', 'start_learning_step'].includes(action);
    if (needsEngine) {
      sendError(res, 409, ERROR_CODES.capability_unavailable, '执行桥接尚未接通，当前只能查看与准备内容');
      return;
    }
    sendError(res, 409, ERROR_CODES.capability_unavailable, '该动作需要执行服务，当前未接通');
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/interactions$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const rows = db.prepare("SELECT * FROM interaction_requests WHERE project_id = ? AND state = 'pending' AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ORDER BY created_at").all(project.id);
    sendJson(res, 200, { ok: true, data: { interactions: rows.map(interactionView) } });
  });

  route('POST', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/interactions/(?<rid>[\\w]+)/respond$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const row = db.prepare('SELECT * FROM interaction_requests WHERE id = ? AND project_id = ?').get(params.rid, project.id);
    if (!row || row.state !== 'pending') {
      sendError(res, 404, ERROR_CODES.not_found, '该请求已失效');
      return;
    }
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
      db.prepare("UPDATE interaction_requests SET state = 'expired' WHERE id = ?").run(row.id);
      sendError(res, 410, ERROR_CODES.conflict, '该请求已过期');
      return;
    }
    const body = await readJson(req, config.maxBodyBytes);
    let answer = typeof body.answer === 'string' ? body.answer.trim() : JSON.stringify(body.answer ?? '');
    if (answer === '' || answer.length > 4000) {
      sendError(res, 400, ERROR_CODES.validation, '回答需要 1-4000 个字符');
      return;
    }
    const questions = JSON.parse(row.questions_json || '[]');
    if (row.kind === 'question' && questions.length) {
      try { answer = JSON.stringify(validateQuestionAnswer(body.answer, questions)); }
      catch (error) { sendError(res, 400, ERROR_CODES.validation, error.message); return; }
    }
    if (row.kind === 'permission' && !['allow', 'allowed', 'allowed-once', '同意', '允许', '允许一次', 'deny', 'reject', 'rejected', '拒绝', '不同意'].includes(answer.toLowerCase())) {
      sendError(res, 400, ERROR_CODES.validation, '请明确选择允许一次或拒绝');
      return;
    }
    let event;
    db.exec('BEGIN IMMEDIATE');
    try {
      const execution=executionFor(db,row.operation_id);
      if(execution)requireExecution(db,executionClaims(execution));
      // readJson yields: recheck state and expiry atomically after receiving it.
      const changed = db.prepare("UPDATE interaction_requests SET state = 'answered', answer = ?, answered_by = ? WHERE id = ? AND state = 'pending' AND (expires_at IS NULL OR expires_at > ?)")
        .run(answer, session.userId, row.id, nowIso());
      if (changed.changes !== 1) {
        db.exec('ROLLBACK');
        sendError(res, 409, ERROR_CODES.conflict, '该请求已回答或已过期，请刷新后查看');
        return;
      }
      if(execution){db.prepare("UPDATE worker_executions SET state='running',updated_at=? WHERE operation_id=?").run(nowIso(),row.operation_id);db.prepare("UPDATE operations SET state='running',updated_at=? WHERE id=?").run(nowIso(),row.operation_id);}
      event = appendEvent(db, {
        tenantId: session.tenantId,
        projectId: project.id,
        type: 'interaction_answered',
        operationId: row.operation_id,
        payload: { interactionId: row.id, kind: row.kind },
      });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    emit(event);
    sendJson(res, 200, { ok: true, data: { interaction: interactionView(db.prepare('SELECT * FROM interaction_requests WHERE id = ?').get(row.id)) } });
  });

  route('GET',new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/operations/(?<oid>[\\w]+)/execution$`),async({req,res,params})=>{
    const session=requireSession(req,res);if(!session)return;
    const project=projectFor(db,session.tenantId,params.id);
    const run=project && db.prepare('SELECT * FROM worker_executions WHERE operation_id=? AND project_id=? AND tenant_id=?').get(params.oid,project.id,session.tenantId);
    if(!run){sendError(res,404,ERROR_CODES.not_found,'执行不存在');return;}
    sendJson(res,200,{ok:true,data:{execution:{operationId:run.operation_id,state:run.state,sequence:run.sequence,stopRequested:!!run.stop_requested,engineAcknowledged:['completed','cancelled','failed'].includes(run.state),updatedAt:run.updated_at}}});
  });
  route('POST',new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/operations/(?<oid>[\\w]+)/recover$`),async({req,res,params})=>{
    const session=requireSession(req,res);if(!session)return;
    const project=projectFor(db,session.tenantId,params.id);
    const run=project && db.prepare('SELECT * FROM worker_executions WHERE operation_id=? AND project_id=? AND tenant_id=?').get(params.oid,project.id,session.tenantId);
    if(!run){sendError(res,404,ERROR_CODES.not_found,'执行不存在');return;}
    await readJson(req,config.maxBodyBytes);
    if(typeof bridge.recoverOperation!=='function'){sendError(res,409,ERROR_CODES.capability_unavailable,'观察恢复服务未接通');return;}
    await bridge.recoverOperation({operationId:run.operation_id,projectId:project.id,tenantId:session.tenantId});
    sendJson(res,200,{ok:true,data:{state:executionFor(db,run.operation_id).state}});
  });

  // --- Internal worker bridge (service token, never a browser session) ------

  route('POST',/^\/internal\/v1\/executions\/(?<id>[\w]+)\/events$/,async({req,res,params})=>{
    const body=await readJson(req,config.maxBodyBytes),claims=internalClaims(req,body);
    if(typeof claims==='string'){sendInternalFailure(res,claims);return;}
    if(claims.operationId!==params.id){sendError(res,404,ERROR_CODES.not_found,'执行不存在');return;}
    let accepted;try{accepted=acceptWorkerEvent(db,claims,body,appendEvent);}catch(error){if(!error.status)Object.assign(error,{status:400,code:ERROR_CODES.validation});throw error;}for(const event of accepted.events)emit(event);
    sendJson(res,200,{ok:true,data:{state:accepted.state,replayed:accepted.replayed}});
  });

  route('POST', new RegExp('^/internal/v1/interactions$'), async ({ req, res }) => {
    const body = await readJson(req, config.maxBodyBytes);
    const claims = internalClaims(req, body);
    if (typeof claims === 'string') {
      sendInternalFailure(res, claims);
      return;
    }
    const project = projectFor(db, claims.tenantId, String(body.projectId || ''));
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const kind = body.kind === 'permission' ? 'permission' : body.kind === 'question' ? 'question' : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 4000) : '';
    if (kind === '' || prompt === '') {
      sendError(res, 400, ERROR_CODES.validation, '需要 kind（question|permission）与 prompt');
      return;
    }
    const interactionId = publicId('itx');
    const createdAt = nowIso();
    let questions, expiresAt;
    try {
      questions = kind === 'question' ? normalizeQuestions(body.questions) : [];
      expiresAt = body.expiresAt ? new Date(body.expiresAt).toISOString() : new Date(Date.now() + 300_000).toISOString();
    } catch { sendError(res, 400, ERROR_CODES.validation, '问题或有效期格式无效'); return; }
    requireExecution(db,claims);
    const requestKey=body.requestKey;
    if(requestKey!==undefined && (typeof requestKey!=='string' || !/^[A-Za-z0-9_-]{8,200}$/.test(requestKey))){sendError(res,400,ERROR_CODES.validation,'无效互动请求编号');return;}
    const digest=bodyDigest({kind,prompt,scope:String(body.scope || ''),questions});
    if(requestKey){
      const previous=db.prepare('SELECT * FROM worker_interaction_keys WHERE operation_id=? AND request_key=?').get(claims.operationId,requestKey);
      if(previous){if(previous.digest!==digest){sendError(res,409,ERROR_CODES.conflict,'互动重放内容冲突');return;}const existing=db.prepare('SELECT * FROM interaction_requests WHERE id=?').get(previous.interaction_id);if(existing.tenant_id!==claims.tenantId || existing.project_id!==claims.projectId){sendError(res,409,ERROR_CODES.conflict,'互动重放作用域冲突');return;}sendJson(res,200,{ok:true,data:{interactionId:existing.id,createdAt:existing.created_at,expiresAt:existing.expires_at,replayed:true}});return;}
    }
    const events=[];db.exec('BEGIN IMMEDIATE');try{
      requireExecution(db,claims);
      db.prepare('INSERT INTO interaction_requests (id, tenant_id, project_id, operation_id, kind, prompt, scope, state, created_at, expires_at, questions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(interactionId, claims.tenantId, project.id, String(body.operationId || ''), kind, prompt, String(body.scope || ''), 'pending', createdAt, expiresAt, JSON.stringify(questions));
      if(requestKey)db.prepare('INSERT INTO worker_interaction_keys VALUES(?,?,?,?)').run(claims.operationId,requestKey,digest,interactionId);
      if(executionFor(db,claims.operationId)){
        db.prepare("UPDATE worker_executions SET state='waiting',updated_at=? WHERE operation_id=?").run(nowIso(),claims.operationId);
        db.prepare("UPDATE operations SET state='waiting',updated_at=? WHERE id=?").run(nowIso(),claims.operationId);
        events.push(appendEvent(db,{tenantId:claims.tenantId,projectId:project.id,operationId:claims.operationId,type:'task_status',payload:{state:'waiting',workerProtocol:true,kind}}));
      }
      events.push(appendEvent(db,{tenantId:claims.tenantId,projectId:project.id,type:'interaction_created',operationId:claims.operationId,payload:{interactionId,kind}}));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    for(const event of events)emit(event);
    sendJson(res, 201, { ok: true, data: { interactionId, createdAt, expiresAt } });
  });

  route('POST', /^\/internal\/v1\/interactions\/(?<id>[\w]+)\/cancel$/, async ({ req, res, params }) => {
    const body = await readJson(req, config.maxBodyBytes);
    const claims = internalClaims(req, body);
    if (typeof claims === 'string') { sendInternalFailure(res, claims); return; }
    const row = db.prepare('SELECT * FROM interaction_requests WHERE id = ? AND tenant_id = ? AND project_id = ?').get(params.id, claims.tenantId, claims.projectId || '');
    if (!row || (row.operation_id || '') !== (claims.operationId || '')) { sendError(res, 404, ERROR_CODES.not_found, '请求不存在'); return; }
    db.exec('BEGIN IMMEDIATE');
    let event;
    try {
      const changed = db.prepare("UPDATE interaction_requests SET state = 'cancelled' WHERE id = ? AND state = 'pending'").run(row.id);
      if (changed.changes) event = appendEvent(db, { tenantId: row.tenant_id, projectId: row.project_id, type: 'interaction_cancelled', operationId: row.operation_id, payload: { interactionId: row.id } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    if (event) emit(event);
    sendJson(res, 200, { ok: true, data: { state: db.prepare('SELECT state FROM interaction_requests WHERE id = ?').get(row.id).state } });
  });

  route('POST', new RegExp('^/internal/v1/projects/(?<id>[\\w]+)/artifacts$'), async ({ req, res, params }) => {
    const body = await readJson(req, config.maxBodyBytes);
    const claims = internalClaims(req, body);
    if (typeof claims === 'string') {
      sendInternalFailure(res, claims);
      return;
    }
    const project = params.id === claims.projectId ? projectFor(db, claims.tenantId, params.id) : null;
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    requireExecution(db,claims);
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
    if (items.length === 0) {
      sendError(res, 400, ERROR_CODES.validation, '需要 items 列表');
      return;
    }
    const validated = [];
    for (const item of items) {
      const relativePath = String(item.relativePath || '');
      const sha256 = String(item.sha256 || '');
      if (relativePath === '' || !/^[a-f0-9]{64}$/.test(sha256)) {
        sendError(res, 400, ERROR_CODES.validation, '每项需要 relativePath 与 sha256');
        return;
      }
      let bytes;
      try {
        const resolved = await workspace.resolveArtifact(project.id, relativePath);
        if (resolved.size > 1024 * 1024) throw Object.assign(new Error('单份文档最多 1MB'), {status:400});
        bytes = await readFile(resolved.path);
        if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== sha256) throw Object.assign(new Error('文件内容与提交摘要不一致'), {status:409});
      } catch (error) {
        sendError(res, error.status || 400, ERROR_CODES.validation, error.message);
        return;
      }
      const source = item.source || {};
      if (Object.keys(source).some(k => !['callId','model'].includes(k)) || Object.values(source).some(v => typeof v !== 'string' || v.length > 200)) { sendError(res,400,ERROR_CODES.validation,'成果来源不合法'); return; }
      validated.push({ relativePath, sha256, bytes, source });
    }
    const created = [];
    let event;
    db.exec('BEGIN IMMEDIATE');
    try {
      requireExecution(db,claims);
      // Filesystem validation yields; fence again before committing any index.
      if (!leaseIsActive(db, claims)) { db.exec('ROLLBACK'); sendInternalFailure(res, 'lease'); return; }
      for (const { relativePath, sha256, bytes, source } of validated) {
        const latest = db.prepare('SELECT * FROM artifact_index WHERE project_id=? AND relative_path=? ORDER BY version DESC LIMIT 1').get(project.id,relativePath);
        if (latest?.sha256===sha256) { created.push({id:latest.id,relativePath,version:latest.version,replayed:true}); continue; }
        const version = Number(latest?.version || 0) + 1;
        const id = publicId('art');
        db.prepare('INSERT INTO artifact_index (id, tenant_id, project_id, relative_path, sha256, version, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
          .run(id, claims.tenantId, project.id, relativePath, sha256, version, nowIso());
        db.prepare('INSERT INTO artifact_contents VALUES(?,?,?,?,?)').run(id,bytes,source.callId || null,claims.operationId || null,source.model || null);
        created.push({ id, relativePath, version });
      }
      if(executionFor(db,claims.operationId))for(const item of created)db.prepare('INSERT OR IGNORE INTO worker_execution_artifacts VALUES(?,?)').run(claims.operationId,item.id);
      event = appendEvent(db, { tenantId: claims.tenantId, projectId: project.id, type: 'artifact_version', operationId: claims.operationId, payload: { registered: created.length } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    emit(event);
    sendJson(res, 201, { ok: true, data: { artifacts: created } });
  });

  route('GET', new RegExp('^/internal/v1/interactions/(?<id>[\\w]+)/answer$'), async ({ req, res, params }) => {
    const claims = internalClaims(req, undefined);
    if (typeof claims === 'string') {
      sendInternalFailure(res, claims);
      return;
    }
    const row = db.prepare('SELECT * FROM interaction_requests WHERE id = ? AND tenant_id = ?').get(params.id, claims.tenantId);
    if (!row || row.project_id !== claims.projectId || (row.operation_id || '') !== claims.operationId) {
      sendError(res, 404, ERROR_CODES.not_found, '请求不存在');
      return;
    }
    const waitMs = Math.min(30_000, Math.max(0, Number(new URL(req.url, 'http://local').searchParams.get('waitMs') || 20_000)));
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (res.destroyed) return;
      if (!leaseIsActive(db, claims)) { sendInternalFailure(res, 'lease'); return; }
      const current = db.prepare('SELECT * FROM interaction_requests WHERE id = ?').get(row.id);
      if (current.state === 'answered') {
        sendJson(res, 200, { ok: true, data: { state: 'answered', answer: current.answer } });
        return;
      }
      if (current.state === 'expired' || current.state === 'cancelled') {
        sendError(res, 410, ERROR_CODES.conflict, '该请求已结束');
        return;
      }
      if (current.expires_at && Date.parse(current.expires_at) < Date.now()) {
        db.prepare("UPDATE interaction_requests SET state = 'expired' WHERE id = ?").run(current.id);
        sendError(res, 410, ERROR_CODES.conflict, '该请求已过期');
        return;
      }
      if (Date.now() >= deadline) {
        res.writeHead(204, { 'cache-control': 'no-store' });
        res.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/artifacts$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const rows = db.prepare('SELECT * FROM artifact_index WHERE project_id = ? ORDER BY version DESC, created_at DESC').all(project.id);
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.relative_path)) latest.set(row.relative_path, row);
    sendJson(res, 200, { ok: true, data: { artifacts: [...latest.values()].map(artifactView) } });
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/artifacts/(?<aid>[\\w]+)$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const artifact = artifactFor(db, project.id, params.aid);
    if (!artifact) {
      sendError(res, 404, ERROR_CODES.not_found, '成果不存在');
      return;
    }
    if (!/\.(md|markdown|txt|html)$/i.test(artifact.relative_path)) {
      sendError(res, 415, ERROR_CODES.validation, '这种格式请直接下载查看');
      return;
    }
    try {
      const bytes = await artifactBytes(artifact);
      sendJson(res, 200, {
        ok: true,
        data: {
          artifact: artifactView(artifact),
          text: bytes.toString('utf8').slice(0, 200_000),
          truncated: bytes.length > 200_000,
        },
      });
    } catch (error) {
      sendError(res, error.status || 400, error.code === 'capability_unavailable' ? ERROR_CODES.capability_unavailable : ERROR_CODES.not_found, error.message);
    }
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/artifacts/(?<aid>[\\w]+)/versions$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const artifact = artifactFor(db, project.id, params.aid);
    if (!artifact) {
      sendError(res, 404, ERROR_CODES.not_found, '成果不存在');
      return;
    }
    const rows = db.prepare('SELECT * FROM artifact_index WHERE project_id = ? AND relative_path = ? ORDER BY version DESC').all(project.id, artifact.relative_path);
    sendJson(res, 200, {
      ok: true,
      data: { versions: rows.map(artifactView), latestId: rows[0] ? rows[0].id : null },
    });
  });

  route('POST', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/artifacts/(?<aid>[\\w]+)/confirm$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const artifact = artifactFor(db, project.id, params.aid);
    if (!artifact) {
      sendError(res, 404, ERROR_CODES.not_found, '成果不存在');
      return;
    }
    const latest = db.prepare('SELECT * FROM artifact_index WHERE project_id = ? AND relative_path = ? ORDER BY version DESC LIMIT 1')
      .get(project.id, artifact.relative_path);
    const body = await readJson(req, config.maxBodyBytes);
    try {assertCurrentDocument({latestId:latest?.id,documentId:artifact.id,currentHash:artifact.sha256,expectedHash:body.hash});}
    catch(error){sendError(res,409,ERROR_CODES.conflict,error.message);return;}
    db.prepare('UPDATE artifact_index SET confirmed = 1 WHERE id = ?').run(artifact.id);
    const event = appendEvent(db, {
      tenantId: session.tenantId,
      projectId: project.id,
      type: 'artifact_version',
      payload: { artifactId: artifact.id, name: artifact.relative_path, version: artifact.version, sha256: artifact.sha256 },
    });
    emit(event);
    sendJson(res, 200, { ok: true, data: { artifact: artifactView(db.prepare('SELECT * FROM artifact_index WHERE id = ?').get(artifact.id)) } });
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/artifacts/(?<aid>[\\w]+)/download$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const artifact = artifactFor(db, project.id, params.aid);
    if (!artifact) {
      sendError(res, 404, ERROR_CODES.not_found, '成果不存在');
      return;
    }
    try {
      const bytes = await artifactBytes(artifact);
      const name = artifact.relative_path.split('/').pop() || 'artifact';
      res.writeHead(200, {
        'content-type': /\.(md|markdown|txt)$/i.test(name) ? 'text/markdown; charset=utf-8' : 'application/octet-stream',
        'content-length': bytes.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(bytes);
    } catch (error) {
      sendError(res, error.status || 400, ERROR_CODES.not_found, error.message);
    }
  });

  route('GET', new RegExp(`^${API_PREFIX}/projects/(?<id>[\\w]+)/events$`), async ({ req, res, params }) => {
    const session = requireSession(req, res);
    if (!session) return;
    const project = projectFor(db, session.tenantId, params.id);
    if (!project) {
      sendError(res, 404, ERROR_CODES.not_found, '项目不存在');
      return;
    }
    const url = new URL(req.url, 'http://local');
    const after = Number(url.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const backlog = db.prepare('SELECT * FROM project_events WHERE project_id = ? AND id > ? ORDER BY id').all(project.id, after);
    for (const row of backlog) res.write(sseFrame(row));
    const unsubscribe = subscribe(project.id, (event) => res.write(sseFrame(event)));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref?.();
    const close = () => {
      clearInterval(ping);
      unsubscribe();
      res.end();
    };
    req.on('close', close);
    res.on('error', close);
  });

  return {
    managerCore,
    publish: emit,
    capabilities: () => bridge.capabilities(),
    /** Dispatch one HTTP request; returns false when no route matched. */
    async handle(req, res) {
      try {
        const url = new URL(req.url, 'http://local');
        for (const entry of routes) {
          if (entry.method !== req.method) continue;
          const match = entry.pattern.exec(url.pathname);
          if (!match) continue;
          await entry.handler({ req, res, url, params: match.groups || {} });
          return true;
        }
        sendError(res, 404, ERROR_CODES.not_found, '接口不存在');
        return false;
      } catch (error) {
        const status = Number(error.status) || 500;
        const code = error.code && Object.values(ERROR_CODES).includes(error.code) ? error.code : ERROR_CODES.unavailable;
        if (status >= 500) console.error('[product-api]', error);
        if (!res.headersSent) sendError(res, status, code, error.message || '服务暂不可用');
        else res.end();
        return true;
      }
    },
  };

  function sseFrame(row) {
    const event = {
      id: row.id,
      projectId: row.project_id,
      type: row.type,
      operationId: row.operation_id,
      revision: row.revision,
      at: row.at,
      payload: row.payload_json ? JSON.parse(row.payload_json) : null,
    };
    return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  }
}

const APP_ROOT = new URL('../../../apps/manager-web/', import.meta.url);

/** Serve one whitelisted product frontend file. */
function sendStatic(res, name) {
  const file = new URL(name, APP_ROOT);
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'message-format.mjs': 'text/javascript; charset=utf-8', 'styles.css': 'text/css; charset=utf-8' };
  readFile(file)
    .then((bytes) => {
      res.writeHead(200, {
        'content-type': types[name] || 'application/octet-stream',
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
        'referrer-policy': 'no-referrer',
      });
      res.end(bytes);
    })
    .catch(() => sendError(res, 404, ERROR_CODES.not_found, '页面不存在'));
}

/** Map one internal token failure onto a stable public error. */
function sendInternalFailure(res, reason) {
  const known = {
    target: [403, ERROR_CODES.forbidden, '内部请求方法或目标不匹配'],
    lease: [403, ERROR_CODES.forbidden, 'Worker 租约已失效或范围不匹配'],
    replay: [409, ERROR_CODES.conflict, '内部请求已处理过'],
    capability_unavailable: [409, ERROR_CODES.capability_unavailable, '内部令牌未配置'],
    unauthorized: [401, ERROR_CODES.unauthorized, '缺少内部令牌'],
    expired: [403, ERROR_CODES.forbidden, '内部令牌已过期'],
    signature: [403, ERROR_CODES.forbidden, '内部令牌签名无效'],
    audience: [403, ERROR_CODES.forbidden, '内部令牌目标不匹配'],
    digest: [403, ERROR_CODES.forbidden, '请求体与令牌不一致'],
    clock: [403, ERROR_CODES.forbidden, '请求时钟偏差过大'],
    format: [403, ERROR_CODES.forbidden, '内部令牌格式无效'],
  };
  const [status, code, message] = known[reason] || [403, ERROR_CODES.forbidden, '内部请求未通过校验'];
  sendError(res, status, code, message);
}

function projectView(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

function operationView(row) {
  if (!row) return null;
  return { id: row.id, type: row.type, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** @returns one message for the product UI, derived from the event log. */
function messageView(row) {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  return {
    id: row.id,
    role: row.type === 'message_created' ? 'user' : 'system',
    kind: row.type,
    text: ['message_created', 'message_completed'].includes(row.type) ? String(payload.text || '') : '已收到你的回答',
    at: row.at,
  };
}

/** @returns one artifact row for the product UI. */
function artifactView(row) {
  return {
    id: row.id,
    name: row.relative_path.split('/').pop() || row.relative_path,
    path: row.relative_path,
    sha256: row.sha256,
    version: row.version,
    confirmed: Boolean(row.confirmed),
    at: row.created_at,
  };
}

/** @returns one artifact row owned by the project, or null. */
function artifactFor(db, projectId, id) {
  return db.prepare('SELECT * FROM artifact_index WHERE id = ? AND project_id = ?').get(id, projectId) || null;
}

function interactionView(row) {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    questions: JSON.parse(row.questions_json || '[]'),
  };
}
