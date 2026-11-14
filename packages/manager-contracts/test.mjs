import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS, CAPABILITIES, ERROR_CODES, EVENT_TYPES,
  eventEnvelope, fail, idempotencyDecision, isPublicId, ok, parseAction, publicId,
} from './index.mjs';

test('success and error envelopes are explicit', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, data: { a: 1 } });
  assert.deepEqual(fail(ERROR_CODES.conflict, 'stale revision'), {
    ok: false,
    error: { code: 'conflict', message: 'stale revision' },
  });
  assert.throws(() => fail('nope', 'x'), /unknown error code/);
});

test('every error code is unique and non-empty', () => {
  const values = Object.values(ERROR_CODES);
  assert.equal(new Set(values).size, values.length);
  assert.ok(values.every((value) => value.length > 0));
});

test('event envelopes validate their shape', () => {
  const event = eventEnvelope({ id: 3, projectId: 'prj_a', type: 'task_status', revision: 2, payload: { s: 1 } });
  assert.equal(event.type, 'task_status');
  assert.equal(event.operationId, null);
  assert.throws(() => eventEnvelope({ id: 0, projectId: 'p', type: 'task_status', revision: 1 }), /event id/);
  assert.throws(() => eventEnvelope({ id: 1, projectId: 'p', type: 'bogus', revision: 1 }), /unknown event type/);
  assert.throws(() => eventEnvelope({ id: 1, projectId: 'p', type: 'task_status', revision: -1 }), /revision/);
});

test('public ids are opaque and prefix-scoped', () => {
  const id = publicId('prj');
  assert.ok(isPublicId(id, 'prj'));
  assert.ok(!isPublicId(id, 'doc'));
  assert.ok(!isPublicId('prj_../etc', 'prj'));
});

test('actions are whitelisted', () => {
  assert.equal(parseAction('send_message'), 'send_message');
  assert.equal(parseAction('run_shell'), null);
  assert.ok(ACTIONS.includes('confirm_artifact'));
  assert.ok(CAPABILITIES.includes('approvals'));
  assert.ok(EVENT_TYPES.includes('permission_pending'));
});

test('idempotency distinguishes replay from conflict', () => {
  assert.equal(idempotencyDecision(null, 'h'), 'new');
  assert.equal(idempotencyDecision({ payloadHash: 'h' }, 'h'), 'replay');
  assert.equal(idempotencyDecision({ payloadHash: 'h' }, 'other'), 'conflict');
});
