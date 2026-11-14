import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestions, validateQuestionAnswer } from './questions.mjs';
const questions = normalizeQuestions([
  { id: 'a', question: '第一版？', options: [{ label: '预约' }, { label: '支付' }] },
  { id: 'b', question: '提醒？', multiSelect: true, options: [{ label: '短信' }, { label: '邮件' }] },
]);
test('question replies preserve ids, multiple selections and user text', () => {
  const result = validateQuestionAnswer({ answers: [{ id: 'b', selected: ['短信', '邮件'] }, { id: 'a', selected: [], custom: '先做演示' }] }, questions);
  assert.deepEqual(result.answers.map(a => a.id), ['a', 'b']);
  assert.equal(result.answers[1].selected.length, 2);
});
test('missing, duplicate, unknown and invalid selections are rejected', () => {
  for (const answers of [[], [{ id: 'a', selected: ['预约'] }, { id: 'a', selected: ['预约'] }], [{ id: 'a', selected: ['预约', '支付'] }, { id: 'b', custom: '无' }], [{ id: 'a', selected: ['未知'] }, { id: 'b', custom: '无' }]]) {
    assert.throws(() => validateQuestionAnswer({ answers }, questions));
  }
  assert.throws(() => normalizeQuestions([{ id: 'a', question: 'A' }, { id: 'a', question: 'B' }]));
});


test('single-question numeric text is retained as a user answer', () => {
  const q = normalizeQuestions([{ id: 'age', question: '多少天？' }]);
  assert.equal(validateQuestionAnswer('123', q).answers[0].custom, '123');
});
