import { createProductClient } from './lib/client.mjs';
import { approvalOutcome, approvalPayload, isAborted, questionAnswer, questionPayload } from './lib/decide.mjs';

export const name = 'manager-bridge';
export const inject = [];

/** @returns normalized options; the bridge is inert unless explicitly enabled. */
export function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    productApiUrl: String(config.productApiUrl || ''),
    workerSecret: String(config.workerSecret || ''),
    workerId: String(config.workerId || ''),
    tenantId: String(config.tenantId || ''),
    projectId: String(config.projectId || ''),
    operationId: String(config.operationId || ''),
    leaseId: String(config.leaseId || ''),
    generation: Number(config.generation) || 0,
    approvalTimeoutMs: Number(config.approvalTimeoutMs) || 300_000,
    questionTimeoutMs: Number(config.questionTimeoutMs) || 300_000,
  };
}

/**
 * Build the two waterfall handlers against an injected client.
 * Exported separately so the routing can be tested without a live product API.
 */
export function createHandlers({ client, options }) {
  async function ask(request, payload, timeoutMs) {
    let id;
    let answered = false;
    try {
      const created = await client.createInteraction({ ...payload, expiresAt: new Date(Date.now() + timeoutMs).toISOString() }, { signal: request?.signal });
      id = created.id;
      if (isAborted(request?.signal)) return null;
      const result = await client.waitAnswer(id, { deadlineMs: timeoutMs, signal: request?.signal });
      if (isAborted(request?.signal)) return null;
      answered = Boolean(result);
      return result;
    } finally {
      // Cleanup is independent of the aborted signal; never overwrite an answer.
      if (id && !answered) await client.cancelInteraction?.(id).catch(() => {});
    }
  }
  return {
    async approval(request) {
      if (isAborted(request?.signal)) return 'cancelled';
      try {
        const result = await ask(request, approvalPayload(request, options), options.approvalTimeoutMs);
        if (isAborted(request?.signal)) return 'cancelled';
        return result ? approvalOutcome(result.answer) || 'unavailable' : 'unavailable';
      } catch { return isAborted(request?.signal) ? 'cancelled' : 'unavailable'; }
    },
    async question(request, next) {
      if (isAborted(request?.signal)) return next();
      try {
        const result = await ask(request, questionPayload(request, options), options.questionTimeoutMs);
        const answer = result ? questionAnswer(result.answer, request) : null;
        return answer === null ? next() : answer;
      } catch { return next(); }
    },
  };
}

/**
 * DSH (Cordis) plugin entry.
 *
 * Disabled unless the worker profile sets `enabled: true` and provides the
 * product URL, the shared secret and the tenant/project identity. Failures fall
 * back to the next answerer (approval: `unavailable`), never to an implicit
 * allow.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config);
  if (!options.enabled || !options.productApiUrl || !options.workerSecret) return;
  const client = createProductClient({
    baseUrl: options.productApiUrl,
    secret: options.workerSecret,
    workerId: options.workerId,
    tenantId: options.tenantId,
    projectId: options.projectId,
    operationId: options.operationId,
    leaseId: options.leaseId,
    generation: options.generation,
  });
  const handlers = createHandlers({ client, options });
  ctx.on('approval/request', (request, next) => handlers.approval(request, next));
  ctx.on('user-questions/request', (request, next) => handlers.question(request, next));
}
