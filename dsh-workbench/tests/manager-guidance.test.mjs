import test from 'node:test';
import assert from 'node:assert/strict';
import { guidanceFor } from '../manager.js';

const makeState = (confirmed) => ({
  stageData: Object.fromEntries(['spec', 'design', 'build', 'verify', 'ship'].map((stage) => [stage, { confirmed: confirmed.includes(stage) }])),
});
const doc = (mode, guidanceStage = '') => ({ contract: { mode }, guidanceStage, guidanceVersion: 2 });

test('after the requirement is confirmed the manager suggests the design', () => {
  const guidance = guidanceFor(doc('design'), makeState(['spec']));
  assert.equal(guidance.stage, 'design');
  assert.equal(guidance.extend, '');
  assert.ok(guidance.message.includes('下一步是《设计方案》'));
});

test('after the design is confirmed a requirements+design contract suggests extending to build', () => {
  const guidance = guidanceFor(doc('design', 'spec'), makeState(['spec', 'design']));
  assert.equal(guidance.stage, 'build');
  assert.equal(guidance.extend, 'software');
  assert.ok(guidance.message.includes('交付目标扩展到'));
});

test('inside the full contract the next stage is the build', () => {
  const guidance = guidanceFor(doc('software', 'spec'), makeState(['spec', 'design']));
  assert.equal(guidance.stage, 'build');
  assert.equal(guidance.extend, '');
});

test('a fully confirmed contract reports completion', () => {
  const guidance = guidanceFor(doc('software', 'verify'), makeState(['spec', 'design', 'build', 'verify', 'ship']));
  assert.equal(guidance.stage, '');
  assert.ok(guidance.message.includes('都齐了'));
});

test('the same confirmation is announced only once', () => {
  assert.equal(guidanceFor(doc('software', 'design'), makeState(['spec', 'design'])), null);
});

test('no contract means no guidance', () => {
  assert.equal(guidanceFor({ contract: null }, makeState(['spec'])), null);
});

test('confirmed stages outside the contract do not trigger guidance', () => {
  assert.equal(guidanceFor(doc('requirements', 'spec'), makeState(['spec'])), null);
});
