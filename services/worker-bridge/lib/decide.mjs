import { normalizeQuestions, validateQuestionAnswer } from './question-contract.mjs';
/**
 * Pure mapping between DSH waterfalls and the product API. No I/O here, so the
 * routing decisions stay testable without a worker or a model.
 */

/** @returns the product payload for one approval request. */
export function approvalPayload(request, context = {}) {
  const tool = String(request?.toolName || 'tool');
  const reason = typeof request?.reason === 'string' ? request.reason : '';
  return {
    kind: 'permission',
    prompt: reason === '' ? `是否允许执行 ${tool}？` : `是否允许执行 ${tool}？${reason}`,
    scope: JSON.stringify({ toolName: tool, callId: request?.callId || null, operationId: context.operationId || null }),
  };
}

/**
 * Map a product answer onto an approval outcome.
 * Unknown or empty answers must delegate (`undefined`) rather than allow.
 */
export function approvalOutcome(answer) {
  const value = String(answer || '').trim().toLowerCase();
  if (['allow', 'allowed', 'allowed-once', '同意', '允许', '允许一次'].includes(value)) return 'allowed-once';
  if (['deny', 'reject', 'rejected', '拒绝', '不同意'].includes(value)) return 'rejected';
  return undefined;
}

/** @returns the product payload for one user-question request. */
export function questionPayload(request, context = {}) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  return {
    kind: 'question',
    prompt: questions.map((item) => String(item.question || '')).filter(Boolean).join('\n').slice(0, 4000),
    scope: JSON.stringify({ callId: request?.wait?.callId || null, timed: Boolean(request?.wait?.timed), operationId: context.operationId || null }),
    questions: normalizeQuestions(questions),
  };
}

/**
 * Convert a product answer back into `AskUserQuestionAnswer`.
 * Accepts `{ answers: [...] }`, a single `{ id, selected }`, or free text.
 */
export function questionAnswer(raw, request) {
  try { return validateQuestionAnswer(raw, normalizeQuestions(request?.questions || [])); }
  catch { return null; }
}

/** @returns a promise that settles to `fallback` after `ms`. */
export function withDeadline(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); timer.unref?.(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** @returns whether a request is already cancelled. */
export function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}
