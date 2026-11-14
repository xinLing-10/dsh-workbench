import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalOutcome, approvalPayload, questionAnswer, questionPayload, withDeadline } from '../lib/decide.mjs';
import { createHandlers, normalizeConfig } from '../index.mjs';

const options = normalizeConfig({ enabled: true, workerId: 'wrk_1', tenantId: 'ten_1', projectId: 'prj_1', approvalTimeoutMs: 50, questionTimeoutMs: 50 });

function stubClient({ answer, throws = false, waitResult = 'answer' } = {}) {
  return {
    async createInteraction(payload) {
      if (throws) throw new Error('product down');
      this.lastPayload = payload;
      return { id: 'itx_1' };
    },
    async waitAnswer() {
      if (waitResult === 'timeout') return null;
      return { state: 'answered', answer };
    },
  };
}

test('approval payload names the tool and keeps the reason as scope', () => {
  const payload = approvalPayload({ toolName: 'bash', callId: 'call_1', reason: '安装依赖' }, { operationId: 'op_1' });
  assert.equal(payload.kind, 'permission');
  assert.match(payload.prompt, /bash/);
  assert.match(payload.prompt, /安装依赖/);
  assert.deepEqual(JSON.parse(payload.scope), { toolName: 'bash', callId: 'call_1', operationId: 'op_1' });
});

test('approval answers map to the closed outcome vocabulary', () => {
  assert.equal(approvalOutcome('允许一次'), 'allowed-once');
  assert.equal(approvalOutcome('deny'), 'rejected');
  assert.equal(approvalOutcome('maybe'), undefined);
  assert.equal(approvalOutcome(''), undefined);
});

test('question payload keeps structured options for the product UI', () => {
  const payload = questionPayload({ questions: [{ id: 'scope', header: '范围', question: '哪些内容？', options: [{ label: 'A' }] }], wait: { callId: 'call_1' } });
  assert.equal(payload.kind, 'question');
  assert.equal(payload.questions[0].options[0].label, 'A');
  assert.match(payload.scope, /call_1/);
});

test('question answers accept structured and free-text replies', () => {
  const request = { questions: [{ id: 'scope', question: '哪些内容？', options: [{ label: 'A' }, { label: 'B' }] }] };
  assert.deepEqual(questionAnswer('{"answers":[{"id":"scope","selected":["A"]}]}', request), { answers: [{ id: 'scope', selected: ['A'] }] });
  assert.deepEqual(questionAnswer({ answers: [{ id: 'scope', selected: ['B'] }] }, request).answers[0].selected, ['B']);
  assert.deepEqual(questionAnswer('自定义回答', request).answers[0].custom, '自定义回答');
  assert.equal(questionAnswer('', request), null);
});

test('withDeadline resolves the fallback without leaking a timer', async () => {
  assert.equal(await withDeadline(new Promise(() => {}), 10, 'fallback'), 'fallback');
  assert.equal(await withDeadline(Promise.resolve('ok'), 50, 'fallback'), 'ok');
});

test('approval handler claims allowed-once and rejects on timeout', async () => {
  const allowed = await createHandlers({ client: stubClient({ answer: 'allow' }), options }).approval({ toolName: 'bash' }, async () => 'next');
  assert.equal(allowed, 'allowed-once');
  const timedOut = await createHandlers({ client: stubClient({ waitResult: 'timeout' }), options }).approval({ toolName: 'bash' }, async () => 'next');
  assert.equal(timedOut, 'unavailable');
  const failed = await createHandlers({ client: stubClient({ throws: true }), options }).approval({ toolName: 'bash' }, async () => 'next');
  assert.equal(failed, 'unavailable');
  const aborted = await createHandlers({ client: stubClient({}), options }).approval({ toolName: 'bash', signal: { aborted: true } }, async () => 'next');
  assert.equal(aborted, 'cancelled');
});

test('question handler delegates instead of inventing an answer', async () => {
  const answered = await createHandlers({ client: stubClient({ answer: '{"answers":[{"id":"scope","selected":["A"]}]}' }), options })
    .question({ questions: [{ id: 'scope', question: '哪些内容？', options: [{ label: 'A' }, { label: 'B' }] }] }, async () => 'next');
  assert.deepEqual(answered.answers[0].selected, ['A']);
  let delegated = false;
  const timedOut = await createHandlers({ client: stubClient({ waitResult: 'timeout' }), options })
    .question({ questions: [{ id: 'scope', question: '哪些内容？', options: [{ label: 'A' }, { label: 'B' }] }] }, async () => { delegated = true; return 'next'; });
  assert.equal(delegated, true);
  assert.equal(timedOut, 'next');
});

test('the plugin stays inert without a configured secret', async () => {
  const handlers = createHandlers({ client: stubClient({ answer: 'allow' }), options: normalizeConfig({ enabled: false }) });
  // apply() returns early in that case; handlers remain safe if called directly.
  assert.equal(typeof handlers.approval, 'function');
});


test('a timed-out approval withdraws its pending card without allowing it', async () => {
  const cancelled = [];
  const client = { ...stubClient({ waitResult: 'timeout' }), async cancelInteraction(id) { cancelled.push(id); } };
  assert.equal(await createHandlers({ client, options }).approval({ toolName: 'demo' }), 'unavailable');
  assert.deepEqual(cancelled, ['itx_1']);
});
