import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyDigest, signToken, verifyToken } from './tokens.mjs';

const secret = 'test-secret-value-1234567890';

test('a signed token verifies for its audience and digest', () => {
  const body = { kind: 'question', prompt: 'hi' };
  const token = signToken({ aud: 'product-api', sub: 'wrk_1', tenantId: 'ten_1', body: bodyDigest(body) }, secret, 60);
  const result = verifyToken(token, secret, { audience: 'product-api', body });
  assert.equal(result.ok, true);
  assert.equal(result.claims.sub, 'wrk_1');
});

test('wrong secret, audience or body digest is rejected', () => {
  const body = { a: 1 };
  const token = signToken({ aud: 'product-api', body: bodyDigest(body) }, secret, 60);
  assert.equal(verifyToken(token, 'another-secret-value-1234', { audience: 'product-api', body }).ok, false);
  assert.equal(verifyToken(token, secret, { audience: 'worker:1', body }).ok, false);
  assert.equal(verifyToken(token, secret, { audience: 'product-api', body: { a: 2 } }).ok, false);
});

test('expired and malformed tokens are rejected', () => {
  const token = signToken({ aud: 'product-api' }, secret, -120);
  assert.equal(verifyToken(token, secret, { audience: 'product-api' }).error, 'expired');
  assert.equal(verifyToken('v1.broken', secret, {}).error, 'format');
  assert.equal(verifyToken('v2.a.b', secret, {}).error, 'format');
});

test('the body digest is stable regardless of key order', () => {
  assert.equal(bodyDigest({ a: 1, b: 2 }), bodyDigest({ b: 2, a: 1 }));
});


test('body signatures cover nested questions and preserve array order', () => {
  const body = { questions: [{ id: 'q1', options: [{ label: '允许', description: '一次' }] }] };
  const changed = structuredClone(body);
  changed.questions[0].options[0].label = '拒绝';
  assert.notEqual(bodyDigest(body), bodyDigest(changed));
  assert.equal(bodyDigest({ b: { z: 1, a: 2 }, a: 3 }), bodyDigest({ a: 3, b: { a: 2, z: 1 } }));
  assert.notEqual(bodyDigest({ a: [1, 2] }), bodyDigest({ a: [2, 1] }));
});
