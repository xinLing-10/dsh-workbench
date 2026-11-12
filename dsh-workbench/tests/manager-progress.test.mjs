import test from 'node:test';
import assert from 'node:assert/strict';
import { progressOf } from '../manager.js';

const review = { stages: { spec: { hashes: { '需求分析阶段.md': 'a' } }, design: { hashes: {} } } };
const job = (over) => ({ kind: 'work', stage: 'spec', status: 'running', createdAt: '2026-11-12T10:00:00.000Z', ...over });
const states = (progress) => progress.steps.map((step) => step.state);

test('a queued work job sits on 准备资料', () => {
  const progress = progressOf(job({ status: 'queued' }), review);
  assert.equal(progress.steps.length, 6);
  assert.deepEqual(states(progress), ['done', 'current', 'todo', 'todo', 'todo', 'todo']);
});

test('running without documents is 生成中; with documents it moves to 写文件', () => {
  assert.deepEqual(states(progressOf(job({ status: 'running' }), { stages: { spec: { hashes: {} } } })).slice(3, 6), ['current', 'todo', 'todo']);
  assert.deepEqual(states(progressOf(job({ status: 'running' }), review)).slice(3, 6), ['done', 'current', 'todo']);
});

test('awaiting review points at 待你阅读', () => {
  const progress = progressOf(job({ status: 'awaiting_review', finishedAt: '2026-11-12T10:02:05.000Z' }), review);
  assert.equal(progress.steps.at(-1).state, 'current');
  assert.equal(progress.elapsedSeconds, 125);
});

test('a completed conversation marks every step done', () => {
  const progress = progressOf({ kind: 'conversation', status: 'completed', createdAt: '2026-11-12T10:00:00.000Z' }, {});
  assert.equal(progress.steps.length, 5);
  assert.ok(progress.steps.every((step) => step.state === 'done'));
});

test('a failure marks the stopped step and keeps the rest pending', () => {
  const progress = progressOf(job({ status: 'failed' }), review);
  assert.deepEqual(states(progress), ['done', 'done', 'done', 'done', 'done', 'failed']);
});

test('elapsed time counts from the start when the job has one', () => {
  const progress = progressOf(
    job({ status: 'running', startedAt: '2026-11-12T10:01:00.000Z' }),
    review,
    Date.parse('2026-11-12T10:01:30.000Z'),
  );
  assert.equal(progress.elapsedSeconds, 30);
});
