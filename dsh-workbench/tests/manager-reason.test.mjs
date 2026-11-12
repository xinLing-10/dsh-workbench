import test from 'node:test';
import assert from 'node:assert/strict';
import { reasonOf } from '../manager-adapter.js';

test('a completed turn end normalizes to a string kind', () => {
  assert.deepEqual(reasonOf({ kind: 'completed' }), { kind: 'completed', detail: '' });
});

test('a model failure keeps a readable detail', () => {
  const reason = reasonOf({ kind: 'error', error: { message: 'rate limit exceeded' } });
  assert.equal(reason.kind, 'error');
  assert.equal(reason.detail, 'rate limit exceeded');
});

test('legacy string reasons pass through', () => {
  assert.deepEqual(reasonOf('aborted'), { kind: 'aborted', detail: '' });
  assert.deepEqual(reasonOf(''), { kind: '', detail: '' });
});

test('a bare failure code is used when there is no message', () => {
  const reason = reasonOf({ kind: 'error', error: { code: 'ECONNRESET' } });
  assert.equal(reason.detail, 'ECONNRESET');
});
