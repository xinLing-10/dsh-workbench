import { registerWorker, acquireLease } from '../src/workers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase, SCHEMA_VERSION } from '../src/db.mjs';
import { createApp } from '../src/app.mjs';
import { createBridge } from '../src/bridge.mjs';
import { createInvite, createTenant } from '../src/auth.mjs';
import { bodyDigest, signToken } from '../../../packages/manager-contracts/tokens.mjs';

const config = {
  publicOrigin: '',
  cookieSecure: false,
  sessionTtlMs: 60_000,
  inviteTtlMs: 60_000,
  maxBodyBytes: 64 * 1024,
  allowRedeem: true,
  workerBaseUrl: '',
  workerToken: '',
  internalSecret: 'test-internal-secret-1234567890-long',
  capabilities: {},
};

/** @returns a signed internal token for the given body and tenant. */
function tokenFor(body, { tenantId = 'ten_x', jti = `jti_${Math.random().toString(36).slice(2)}`, audience = 'product-api', ttl = 60 } = {}) {
  return { tenantId, jti, audience, ttl, digest: body === undefined ? undefined : bodyDigest(body) };
}

const testDatabases = new Map();
async function internal(base, method, path, body, token) {
  if (token) {
    const db = testDatabases.get(base);
    const projectId = body?.projectId || path.match(/projects\/([\w]+)/)?.[1] || db.prepare('SELECT project_id FROM interaction_requests WHERE id = ?').get(path.match(/interactions\/([\w]+)/)?.[1] || '')?.project_id;
    const operationId = body?.operationId || db.prepare('SELECT operation_id FROM interaction_requests WHERE id = ?').get(path.match(/interactions\/([\w]+)/)?.[1] || '')?.operation_id || '';
    const workerId = 'wrk_' + token.tenantId;
    if (!db.prepare('SELECT id FROM workers WHERE id = ?').get(workerId)) registerWorker(db, { workerId, tenantId: token.tenantId, secret: config.internalSecret });
    let lease = db.prepare("SELECT * FROM worker_leases WHERE worker_id = ? AND state = 'active'").get(workerId);
    if (!lease) lease = acquireLease(db, { workerId, projectId, operationId });
    token = signToken({ aud: token.audience, sub: workerId, tenantId: token.tenantId, projectId, operationId, leaseId: lease.id, generation: lease.generation, method, target: path, jti: token.jti, ...(token.digest === undefined ? {} : { body: token.digest }) }, config.internalSecret, token.ttl);
  }
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : {} };
}

async function boot(overrides = {}) {
  const effective = { ...config, ...overrides };
  const db = openDatabase(':memory:');
  const app = createApp({ db, config: effective, bridge: overrides.bridge || createBridge({ config: effective }) });
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  testDatabases.set(base, db);
  return { db, base, close: () => new Promise((resolve) => server.close(resolve)) };
}

function invite(db, ttlMs = 60_000) {
  const tenant = createTenant(db);
  return createInvite(db, { tenantId: tenant.id, ttlMs });
}

/** Minimal cookie-aware client. */
function client(base) {
  let cookie = '';
  let csrf = '';
  return {
    get csrf() { return csrf; },
    get cookie() { return cookie; },
    async call(method, path, body, headers = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
          ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
      if (method === 'GET' && path.endsWith('/me') && payload?.data?.csrfToken) csrf = payload.data.csrfToken;
      return { status: response.status, payload, text };
    },
    async redeem(token, email, password) {
      const result = await this.call('POST', '/api/v1/invitations/redeem', { token, email, password });
      return result;
    },
    async login(email, password) {
      const result = await this.call('POST', '/api/v1/auth/login', { email, password });
      const me = await this.call('GET', '/api/v1/me');
      if (me.payload?.data?.csrfToken) csrf = me.payload.data.csrfToken;
      return result;
    },
  };
}

test('health reports capabilities without authentication', async () => {
  const ctx = await boot();
  try {
    const response = await fetch(`${ctx.base}/healthz`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.capabilities.approvals, false);
    assert.equal(body.data.capabilities.configured, false);
  } finally { await ctx.close(); }
});

test('redeem, login and me return an opaque session', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    const invited = invite(ctx.db);
    const redeemed = await a.redeem(invited.token, 'a@example.com', 'password123');
    assert.equal(redeemed.status, 201);
    const me = await a.call('GET', '/api/v1/me');
    assert.equal(me.status, 200);
    assert.equal(me.payload.data.user.email, 'a@example.com');
    assert.ok(me.payload.data.csrfToken.length > 10);
    assert.equal(me.payload.data.capabilities.bridge, false);
    assert.equal(me.payload.data.quota.configured, false);

    const b = client(ctx.base);
    const login = await b.login('a@example.com', 'password123');
    assert.equal(login.status, 200);
    const meB = await b.call('GET', '/api/v1/me');
    assert.equal(meB.status, 200);
    assert.equal(meB.payload.data.user.email, 'a@example.com');
  } finally { await ctx.close(); }
});

test('invites are single use and passwords are verified', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    const invited = invite(ctx.db);
    assert.equal((await a.redeem(invited.token, 'a@example.com', 'password123')).status, 201);
    const again = await a.redeem(invited.token, 'b@example.com', 'password123');
    assert.equal(again.status, 400);
    const wrong = await client(ctx.base).login('a@example.com', 'wrongpass1');
    assert.equal(wrong.status, 401);
  } finally { await ctx.close(); }
});

test('projects are scoped to the tenant', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const created = await a.call('POST', '/api/v1/projects', { name: '小店预约' });
    assert.equal(created.status, 201);
    const id = created.payload.data.project.id;
    assert.match(id, /^prj_/);
    const mine = await a.call('GET', `/api/v1/projects/${id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.payload.data.project.name, '小店预约');

    const b = client(ctx.base);
    await b.redeem(invite(ctx.db).token, 'b@example.com', 'password123');
    await b.call('GET', '/api/v1/me');
    const foreign = await b.call('GET', `/api/v1/projects/${id}`);
    assert.equal(foreign.status, 404);
    const list = await b.call('GET', '/api/v1/projects');
    assert.deepEqual(list.payload.data.projects, []);
  } finally { await ctx.close(); }
});

test('messages are idempotent per request id and reject changed payloads', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const first = await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '你好', requestId: 'req-0001' });
    assert.equal(first.status, 202);
    assert.equal(first.payload.data.dispatch, 'unavailable');
    const operationId = first.payload.data.operation.id;

    const replay = await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '你好', requestId: 'req-0001' });
    assert.equal(replay.status, 200);
    assert.equal(replay.payload.data.operation.id, operationId);

    const conflict = await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '不一样', requestId: 'req-0001' });
    assert.equal(conflict.status, 409);

    const bad = await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '', requestId: 'req-0002' });
    assert.equal(bad.status, 400);
  } finally { await ctx.close(); }
});

test('unsafe requests need a CSRF token and a session', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    const me = await a.call('GET', '/api/v1/me');
    const csrf = me.payload.data.csrfToken;
    const without = await a.call('POST', '/api/v1/projects', { name: 'x' }, { 'x-csrf-token': 'wrong-token-value' });
    assert.equal(without.status, 403);
    assert.equal(without.payload.error.code, 'csrf');
    const ok = await a.call('POST', '/api/v1/projects', { name: 'x' });
    assert.equal(ok.status, 201);
    assert.ok(csrf.length > 10);
    const anonymous = await fetch(`${ctx.base}/api/v1/projects`);
    assert.equal(anonymous.status, 401);
  } finally { await ctx.close(); }
});

test('project events can be read as SSE with a cursor', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '你好', requestId: 'req-0001' });

    const controller = new AbortController();
    const response = await fetch(`${ctx.base}/api/v1/projects/${project.id}/events?lastEventId=0`, {
      headers: { cookie: a.cookie },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /event: task_status/);
    assert.match(text, /event: message_created/);
    assert.match(text, /"text":"你好"/);
    controller.abort();
  } finally { await ctx.close(); }
});

test('actions requiring the execution bridge are blocked, not silently accepted', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const blocked = await a.call('POST', `/api/v1/projects/${project.id}/actions`, { requestId: 'act-0001', action: 'start_proposed_work' });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.payload.error.code, 'capability_unavailable');
    const invalid = await a.call('POST', `/api/v1/projects/${project.id}/actions`, { requestId: 'act-0002', action: 'run_shell' });
    assert.equal(invalid.status, 400);
    const interactions = await a.call('GET', `/api/v1/projects/${project.id}/interactions`);
    assert.deepEqual(interactions.payload.data.interactions, []);
  } finally { await ctx.close(); }
});

test('internal interactions require a valid, single-use, body-bound token', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;

    const payload = { projectId: project.id, kind: 'question', prompt: '需要在线支付吗？', operationId: 'op_seed', expiresAt: new Date(Date.now() + 60_000).toISOString() };

    const anonymous = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.payload.error.code, 'unauthorized');

    const wrongAudience = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload, tokenFor(payload, { tenantId, audience: 'worker:1' }));
    assert.equal(wrongAudience.status, 403);

    const wrongDigest = await internal(ctx.base, 'POST', '/internal/v1/interactions', { ...payload, prompt: 'changed' }, tokenFor(payload, { tenantId }));
    assert.equal(wrongDigest.status, 403);
    assert.equal(wrongDigest.payload.error.code, 'forbidden');

    const good = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload, tokenFor(payload, { tenantId, jti: 'jti_fixed' }));
    assert.equal(good.status, 201);
    assert.match(good.payload.data.interactionId, /^itx_/);

    const replay = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload, tokenFor(payload, { tenantId, jti: 'jti_fixed' }));
    assert.equal(replay.status, 409);

    const listed = await a.call('GET', `/api/v1/projects/${project.id}/interactions`);
    assert.equal(listed.payload.data.interactions.length, 1);
    assert.equal(listed.payload.data.interactions[0].kind, 'question');
  } finally { await ctx.close(); }
});

test('a user answer is delivered to the waiting worker', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;
    const payload = { projectId: project.id, kind: 'permission', prompt: '允许安装依赖吗？', operationId: 'op_seed' };
    const created = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload, tokenFor(payload, { tenantId }));
    const interactionId = created.payload.data.interactionId;

    const waiting = internal(ctx.base, 'GET', `/internal/v1/interactions/${interactionId}/answer?waitMs=3000`, undefined, tokenFor(undefined, { tenantId }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answered = await a.call('POST', `/api/v1/projects/${project.id}/interactions/${interactionId}/respond`, { answer: '允许一次' });
    assert.equal(answered.status, 200);
    assert.equal(answered.payload.data.interaction.state, 'answered');

    const result = await waiting;
    assert.equal(result.status, 200);
    assert.equal(result.payload.data.state, 'answered');
    assert.equal(result.payload.data.answer, '允许一次');
  } finally { await ctx.close(); }
});

test('an expired interaction cannot be answered', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;
    const payload = { projectId: project.id, kind: 'question', prompt: '过期问题', expiresAt: new Date(Date.now() - 1000).toISOString() };
    const created = await internal(ctx.base, 'POST', '/internal/v1/interactions', payload, tokenFor(payload, { tenantId }));
    const interactionId = created.payload.data.interactionId;
    const answered = await a.call('POST', `/api/v1/projects/${project.id}/interactions/${interactionId}/respond`, { answer: '迟到的回答' });
    assert.equal(answered.status, 410);
    assert.equal((await a.call('GET', `/api/v1/projects/${project.id}/interactions`)).payload.data.interactions.length, 0);
  } finally { await ctx.close(); }
});

test('the product frontend is served with a strict CSP', async () => {
  const ctx = await boot();
  try {
    const page = await fetch(`${ctx.base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await page.text();
    assert.match(html, /项目管家/);
    assert.match(html, /<script type="module" src="\/app\.js">/);
    assert.equal((await fetch(`${ctx.base}/app.js`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/styles.css`)).status, 200);
    const formatter = await fetch(`${ctx.base}/message-format.mjs`);
    assert.equal(formatter.status, 200);
    assert.match(formatter.headers.get('content-type'), /text\/javascript/);
    assert.equal((await fetch(`${ctx.base}/../package.json`)).status, 404);
  } finally { await ctx.close(); }
});

test('message history is scoped to the project owner', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    await a.call('POST', `/api/v1/projects/${project.id}/messages`, { text: '第一版只做预约', requestId: 'req-msg-01' });
    const history = await a.call('GET', `/api/v1/projects/${project.id}/messages`);
    assert.equal(history.status, 200);
    assert.equal(history.payload.data.messages.length, 1);
    assert.equal(history.payload.data.messages[0].text, '第一版只做预约');
    assert.equal(history.payload.data.messages[0].role, 'user');

    const b = client(ctx.base);
    await b.redeem(invite(ctx.db).token, 'b@example.com', 'password123');
    await b.call('GET', '/api/v1/me');
    assert.equal((await b.call('GET', `/api/v1/projects/${project.id}/messages`)).status, 404);
  } finally { await ctx.close(); }
});

test('artifacts are registered by the worker, read, confirmed and downloaded', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'product-ws-'));
  const ctx = await boot({ workspaceRoot });
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: '小店预约' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;

    const directory = join(workspaceRoot, project.id, 'documents');
    await mkdir(directory, { recursive: true });
    const content = '# 需求说明书\n\n第一版只做预约。\n';
    await writeFile(join(directory, '需求分析阶段.md'), content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const payload = { items: [{ relativePath: 'documents/需求分析阶段.md', sha256 }] };
    const registered = await internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, payload, tokenFor(payload, { tenantId }));
    assert.equal(registered.status, 201);
    const artifactId = registered.payload.data.artifacts[0].id;
    const replay = await internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, payload, tokenFor(payload,{tenantId}));
    assert.equal(replay.payload.data.artifacts[0].id,artifactId);
    assert.equal(replay.payload.data.artifacts[0].version,1);

    const list = await a.call('GET', `/api/v1/projects/${project.id}/artifacts`);
    assert.equal(list.payload.data.artifacts.length, 1);
    assert.equal(list.payload.data.artifacts[0].name, '需求分析阶段.md');
    assert.equal(list.payload.data.artifacts[0].confirmed, false);

    const read = await a.call('GET', `/api/v1/projects/${project.id}/artifacts/${artifactId}`);
    assert.equal(read.status, 200);
    assert.match(read.payload.data.text, /第一版只做预约/);
    assert.equal(read.payload.data.artifact.sha256, sha256);

    const wrong = await a.call('POST', `/api/v1/projects/${project.id}/artifacts/${artifactId}/confirm`, { hash: 'f'.repeat(64) });
    assert.equal(wrong.status, 409);
    const confirmed = await a.call('POST', `/api/v1/projects/${project.id}/artifacts/${artifactId}/confirm`, { hash: sha256 });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.payload.data.artifact.confirmed, true);

    const download = await fetch(`${ctx.base}/api/v1/projects/${project.id}/artifacts/${artifactId}/download`, { headers: { cookie: a.cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
    assert.match(await download.text(), /第一版只做预约/);

    const b = client(ctx.base);
    await b.redeem(invite(ctx.db).token, 'b@example.com', 'password123');
    await b.call('GET', '/api/v1/me');
    assert.equal((await b.call('GET', `/api/v1/projects/${project.id}/artifacts`)).status, 404);
    assert.equal((await b.call('GET', `/api/v1/projects/${project.id}/artifacts/${artifactId}`)).status, 404);
  } finally { await ctx.close(); }
});

test('artifact registration refuses traversal and unauthenticated workers', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'product-ws-'));
  const ctx = await boot({ workspaceRoot });
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;
    await mkdir(join(workspaceRoot, project.id), { recursive: true });
    await writeFile(join(workspaceRoot, project.id, 'ok.md'), 'ok', 'utf8');

    const secretFile = join(workspaceRoot, 'outside.md');
    await writeFile(secretFile, 'secret', 'utf8');
    const sha = createHash('sha256').update('x').digest('hex');

    const escape = { items: [{ relativePath: '../outside.md', sha256: sha }] };
    const denied = await internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, escape, tokenFor(escape, { tenantId }));
    assert.equal(denied.status, 400);

    const missing = { items: [{ relativePath: 'nope.md', sha256: sha }] };
    const missingResult = await internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, missing, tokenFor(missing, { tenantId }));
    assert.equal(missingResult.status, 404);

    const anonymous = await internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, { items: [] });
    assert.equal(anonymous.status, 401);
  } finally { await ctx.close(); }
});

test('artifact versions accumulate and only the latest can be confirmed', async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'product-ws-'));
  const ctx = await boot({ workspaceRoot });
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'a@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: 'p' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;
    const file = join(workspaceRoot, project.id, '文档.md');
    await mkdir(join(workspaceRoot, project.id), { recursive: true });
    await writeFile(file, 'v1 内容', 'utf8');
    const v1 = createHash('sha256').update('v1 内容').digest('hex');
    const register = (sha) => internal(ctx.base, 'POST', `/internal/v1/projects/${project.id}/artifacts`, { items: [{ relativePath: '文档.md', sha256: sha }] }, tokenFor({ items: [{ relativePath: '文档.md', sha256: sha }] }, { tenantId }));
    const first = await register(v1);
    const firstId = first.payload.data.artifacts[0].id;

    await writeFile(file, 'v2 内容', 'utf8');
    const v2 = createHash('sha256').update('v2 内容').digest('hex');
    const second = await register(v2);
    const secondId = second.payload.data.artifacts[0].id;

    const versions = await a.call('GET', `/api/v1/projects/${project.id}/artifacts/${firstId}/versions`);
    assert.equal(versions.status, 200);
    assert.deepEqual(versions.payload.data.versions.map((item) => item.version), [2, 1]);
    assert.equal(versions.payload.data.latestId, secondId);

    const oldRead = await a.call('GET', `/api/v1/projects/${project.id}/artifacts/${firstId}`);
    assert.equal(oldRead.status, 200);
    assert.equal(oldRead.payload.data.text, 'v1 内容');
    const oldConfirm = await a.call('POST', `/api/v1/projects/${project.id}/artifacts/${firstId}/confirm`, { hash: v1 });
    assert.equal(oldConfirm.status, 409);
    const newConfirm = await a.call('POST', `/api/v1/projects/${project.id}/artifacts/${secondId}/confirm`, { hash: v2 });
    assert.equal(newConfirm.status, 200);

    const list = await a.call('GET', `/api/v1/projects/${project.id}/artifacts`);
    assert.equal(list.payload.data.artifacts.length, 1);
    assert.equal(list.payload.data.artifacts[0].version, 2);
  } finally { await ctx.close(); }
});

test('every element the frontend binds exists in the served page', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const root = new URL('../../../apps/manager-web/', import.meta.url);
  const html = await readFile(fileURLToPath(new URL('index.html', root)), 'utf8');
  const script = await readFile(fileURLToPath(new URL('app.js', root)), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const bound = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]));
  const missing = [...bound].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `frontend binds missing elements: ${missing.join(', ')}`);
  assert.ok(ids.has('artifact-version'));
  assert.ok(ids.has('live-state'));
});


test('configuration alone cannot enable an unimplemented execution bridge', async () => {
  const ctx = await boot({ capabilities: { bridge: true, approvals: true, usage: true }, workerBaseUrl: 'http://localhost:1', workerToken: 'configured' });
  try {
    const health = await (await fetch(ctx.base + '/healthz')).json();
    assert.equal(health.data.capabilities.bridge, false);
    assert.equal(health.data.capabilities.approvals, false);
    assert.equal(health.data.capabilities.usage, false);
  } finally { await ctx.close(); }
});

test('failed event persistence rolls back message and outbox, allowing safe retry', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'atomic@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: '事务测试' })).payload.data.project;
    ctx.db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON project_events WHEN NEW.type = 'message_created' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END");
    const path = `/api/v1/projects/${project.id}/messages`;
    const body = { text: '不能丢失', requestId: 'req-atomic-01' };
    assert.equal((await a.call('POST', path, body)).status, 500);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 0);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM operation_outbox').get().n, 0);
    ctx.db.exec('DROP TRIGGER fail_message');
    assert.equal((await a.call('POST', path, body)).status, 202);
    assert.equal((await a.call('GET', path)).payload.data.messages.length, 1);
  } finally { await ctx.close(); }
});

test('permission replies are explicit, single-use and committed with their event', async () => {
  const ctx = await boot();
  try {
    const a = client(ctx.base);
    await a.redeem(invite(ctx.db).token, 'permission@example.com', 'password123');
    await a.call('GET', '/api/v1/me');
    const project = (await a.call('POST', '/api/v1/projects', { name: '审批测试' })).payload.data.project;
    const tenantId = ctx.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(project.id).tenant_id;
    const body = { projectId: project.id, kind: 'permission', prompt: '是否允许？' };
    const created = await internal(ctx.base, 'POST', '/internal/v1/interactions', body, tokenFor(body, { tenantId }));
    const id = created.payload.data.interactionId;
    const path = `/api/v1/projects/${project.id}/interactions/${id}/respond`;
    assert.equal((await a.call('POST', path, { answer: '随便' })).status, 400);
    ctx.db.exec("CREATE TRIGGER fail_answer BEFORE INSERT ON project_events WHEN NEW.type = 'interaction_answered' BEGIN SELECT RAISE(ABORT, 'injected answer failure'); END");
    assert.equal((await a.call('POST', path, { answer: 'allow' })).status, 500);
    assert.equal(ctx.db.prepare('SELECT state FROM interaction_requests WHERE id = ?').get(id).state, 'pending');
    ctx.db.exec('DROP TRIGGER fail_answer');
    const results = await Promise.all(['allow', 'deny'].map(answer => a.call('POST', path, { answer })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.ok(results.some(r => [404, 409].includes(r.status)));
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type = 'interaction_answered'").get().n, 1);
  } finally { await ctx.close(); }
});


test('existing v1 databases migrate without losing projects or legacy interactions', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'manager-migration-'));
  let db;
  try {
    const path = join(dir, 'control.sqlite');
    db = openDatabase(path);
    db.exec("INSERT INTO tenants VALUES ('ten_old', '旧项目', '2026-01-01'); INSERT INTO interaction_requests (id,tenant_id,project_id,kind,prompt,state,created_at) VALUES ('itx_old','ten_old','prj_old','question','旧问题','pending','2026-01-01')");
    db.exec('ALTER TABLE interaction_requests DROP COLUMN questions_json; UPDATE schema_meta SET version = 1');
    db.close(); db = openDatabase(path);
    assert.equal(db.prepare('SELECT version FROM schema_meta').get().version, SCHEMA_VERSION);
    const row = db.prepare("SELECT * FROM interaction_requests WHERE id = 'itx_old'").get();
    assert.equal(row.prompt, '旧问题');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worker_executions'").get());
    assert.equal(row.questions_json, '[]');
    db.close(); db = openDatabase(path); // Repeat migration safely.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM interaction_requests').get().n, 1);
  } finally { db?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('paused execution preserves replay/history and rejects a new chargeable operation',async()=>{let paused=false;const ctx=await boot({bridge:{capabilities:()=>({bridge:true,paused})}});try{const a=client(ctx.base);await a.redeem(invite(ctx.db).token,'paused@example.com','password123');await a.call('GET','/api/v1/me');const p=(await a.call('POST','/api/v1/projects',{name:'fictional'})).payload.data.project;const payload={text:'fictional message',requestId:'paused-request-01'};const one=await a.call('POST',`/api/v1/projects/${p.id}/messages`,payload);paused=true;const replay=await a.call('POST',`/api/v1/projects/${p.id}/messages`,payload);assert.equal(replay.status,200);assert.equal(replay.payload.data.operation.id,one.payload.data.operation.id);assert.equal((await a.call('POST',`/api/v1/projects/${p.id}/messages`,{...payload,requestId:'paused-request-02'})).status,409);assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,1);assert.equal((await a.call('GET',`/api/v1/projects/${p.id}/messages`)).status,200);}finally{await ctx.close();}});
for(const acknowledged of [true,false])test('native stop requires engine receipt: '+acknowledged,async()=>{let calls=0;const ctx=await boot({bridge:{capabilities:()=>({bridge:true,nativeStop:true}),cancel:async()=>{calls++;return acknowledged?{state:'cancelled',engineAcknowledged:true}:{state:'cancelled'};}}});try{const a=client(ctx.base);await a.redeem(invite(ctx.db).token,'stop@example.com','password123');await a.call('GET','/api/v1/me');const p=(await a.call('POST','/api/v1/projects',{name:'fictional'})).payload.data.project;const op=(await a.call('POST',`/api/v1/projects/${p.id}/messages`,{text:'fictional',requestId:'stop-request-01'})).payload.data.operation;ctx.db.prepare("UPDATE operations SET state='running' WHERE id=?").run(op.id);const result=await a.call('POST',`/api/v1/projects/${p.id}/actions`,{action:'cancel_operation',operationId:op.id,requestId:'stop-request-02'});assert.equal(result.status,acknowledged?200:409);assert.equal(ctx.db.prepare('SELECT state FROM operations WHERE id=?').get(op.id).state,acknowledged?'cancelled':'uncertain');assert.equal(calls,1);if(acknowledged){const replay=await a.call('POST',`/api/v1/projects/${p.id}/actions`,{action:'cancel_operation',operationId:op.id,requestId:'stop-request-03'});assert.equal(replay.status,200);assert.equal(calls,1);}}finally{await ctx.close();}});
