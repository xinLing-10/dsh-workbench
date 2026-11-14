import { registerWorker, acquireLease } from '../../product-api/src/workers.mjs';
import { createHandlers, normalizeConfig } from '../index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../../product-api/src/db.mjs';
import { createApp } from '../../product-api/src/app.mjs';
import { createBridge } from '../../product-api/src/bridge.mjs';
import { createInvite, createTenant } from '../../product-api/src/auth.mjs';
import { createProductClient } from '../lib/client.mjs';

const secret = 'integration-secret-1234567890-long';

async function boot() {
  const config = {
    publicOrigin: '', cookieSecure: false, sessionTtlMs: 60_000, inviteTtlMs: 60_000,
    maxBodyBytes: 64 * 1024, allowRedeem: true, workerBaseUrl: '', workerToken: '',
    internalSecret: secret, capabilities: { questions: true, approvals: true },
  };
  const db = openDatabase(':memory:');
  const app = createApp({ db, config, bridge: createBridge({ config }) });
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { db, config, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

let cookie = '';
let csrf = '';
async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await response.text();
  return { status: response.status, payload: text ? JSON.parse(text) : {} };
}

test('a worker-created question reaches the user and its answer returns to the worker', async () => {
  const ctx = await boot();
  try {
    const tenant = createTenant(ctx.db);
    const invited = createInvite(ctx.db, { tenantId: tenant.id, ttlMs: 60_000 });
    await call(ctx.base, 'POST', '/api/v1/invitations/redeem', { token: invited.token, email: 'u@example.com', password: 'password123' });
    const me = await call(ctx.base, 'GET', '/api/v1/me');
    csrf = me.payload.data.csrfToken;
    const project = (await call(ctx.base, 'POST', '/api/v1/projects', { name: '小店预约' })).payload.data.project;

    registerWorker(ctx.db, { workerId: 'wrk_1', tenantId: tenant.id, secret });
    const lease = acquireLease(ctx.db, { workerId: 'wrk_1', projectId: project.id, operationId: 'op_1' });
    const client = createProductClient({
      leaseId: lease.id, generation: lease.generation,
      baseUrl: ctx.base,
      secret,
      workerId: 'wrk_1',
      tenantId: tenant.id,
      projectId: project.id,
      operationId: 'op_1',
    });

    const created = await client.createInteraction({ kind: 'question', prompt: '第一版是否包含在线支付？' });
    assert.match(created.id, /^itx_/);

    const pending = await call(ctx.base, 'GET', `/api/v1/projects/${project.id}/interactions`);
    assert.equal(pending.payload.data.interactions.length, 1);
    assert.equal(pending.payload.data.interactions[0].prompt, '第一版是否包含在线支付？');

    const waiting = client.waitAnswer(created.id, { deadlineMs: 5_000, pollMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answered = await call(ctx.base, 'POST', `/api/v1/projects/${project.id}/interactions/${created.id}/respond`, { answer: '不包含' });
    assert.equal(answered.status, 200);

    const result = await waiting;
    assert.equal(result.state, 'answered');
    assert.equal(result.answer, '不包含');
  } finally { await ctx.close(); }
});


test('multiple questions survive API storage and reject partial answers', async () => {
  const ctx = await boot();
  try {
    const tenant = createTenant(ctx.db);
    const invited = createInvite(ctx.db, { tenantId: tenant.id, ttlMs: 60000 });
    await call(ctx.base, 'POST', '/api/v1/invitations/redeem', { token: invited.token, email: 'multi@example.com', password: 'password123' });
    csrf = (await call(ctx.base, 'GET', '/api/v1/me')).payload.data.csrfToken;
    const project = (await call(ctx.base, 'POST', '/api/v1/projects', { name: '演示预约项目' })).payload.data.project;
    registerWorker(ctx.db, { workerId: 'wrk_1', tenantId: tenant.id, secret });
    const lease = acquireLease(ctx.db, { workerId: 'wrk_1', projectId: project.id });
    const client = createProductClient({ leaseId: lease.id, generation: lease.generation, baseUrl: ctx.base, secret, workerId: 'wrk_1', tenantId: tenant.id, projectId: project.id });
    const questions = [{ id: 'scope', question: '第一版包含什么？', options: [{ label: '预约' }, { label: '支付' }] }, { id: 'notice', question: '提醒方式？', multiSelect: true, options: [{ label: '短信' }, { label: '邮件' }] }];
    const created = await client.createInteraction({ kind: 'question', prompt: '确认需求', questions });
    const listed = await call(ctx.base, 'GET', `/api/v1/projects/${project.id}/interactions`);
    assert.equal(listed.payload.data.interactions[0].questions[1].multiSelect, true);
    const path = `/api/v1/projects/${project.id}/interactions/${created.id}/respond`;
    assert.equal((await call(ctx.base, 'POST', path, { answer: { answers: [{ id: 'scope', selected: ['预约'] }] } })).status, 400);
    const answer = { answers: [{ id: 'scope', selected: ['预约'] }, { id: 'notice', selected: ['短信', '邮件'], custom: '仅工作日' }] };
    assert.equal((await call(ctx.base, 'POST', path, { answer })).status, 200);
    assert.deepEqual(JSON.parse((await client.waitAnswer(created.id)).answer), answer);
    await client.cancelInteraction(created.id);
    assert.deepEqual(JSON.parse((await client.waitAnswer(created.id)).answer), answer); // cancellation cannot undo an answer.
  } finally { await ctx.close(); }
});

test('cancelling a live approval aborts the poll and retires its card', async () => {
  const ctx = await boot();
  try {
    const tenant = createTenant(ctx.db);
    const invited = createInvite(ctx.db, { tenantId: tenant.id, ttlMs: 60000 });
    await call(ctx.base, 'POST', '/api/v1/invitations/redeem', { token: invited.token, email: 'cancel@example.com', password: 'password123' });
    csrf = (await call(ctx.base, 'GET', '/api/v1/me')).payload.data.csrfToken;
    const project = (await call(ctx.base, 'POST', '/api/v1/projects', { name: '取消演示' })).payload.data.project;
    registerWorker(ctx.db, { workerId: 'wrk_1', tenantId: tenant.id, secret });
    const lease = acquireLease(ctx.db, { workerId: 'wrk_1', projectId: project.id });
    const client = createProductClient({ leaseId: lease.id, generation: lease.generation, baseUrl: ctx.base, secret, workerId: 'wrk_1', tenantId: tenant.id, projectId: project.id });
    const controller = new AbortController();
    const handlers = createHandlers({ client, options: normalizeConfig({ approvalTimeoutMs: 5000 }) });
    const pending = handlers.approval({ toolName: 'demo', signal: controller.signal });
    for (let i = 0; i < 100 && !ctx.db.prepare('SELECT id FROM interaction_requests').get(); i++) await new Promise(r => setTimeout(r, 10));
    const row = ctx.db.prepare('SELECT id FROM interaction_requests').get();
    assert.ok(row);
    controller.abort();
    assert.equal(await pending, 'cancelled');
    assert.equal(ctx.db.prepare('SELECT state FROM interaction_requests WHERE id = ?').get(row.id).state, 'cancelled');
    assert.equal((await call(ctx.base, 'GET', `/api/v1/projects/${project.id}/interactions`)).payload.data.interactions.length, 0);
    assert.equal((await call(ctx.base, 'POST', `/api/v1/projects/${project.id}/interactions/${row.id}/respond`, { answer: 'allow' })).status, 404);
    await client.cancelInteraction(row.id); // idempotent; no second event.
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM project_events WHERE type = 'interaction_cancelled'").get().n, 1);
  } finally { await ctx.close(); }
});
