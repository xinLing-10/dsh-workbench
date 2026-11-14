import { randomUUID } from 'node:crypto';
import { bodyDigest, signToken } from './token-contract.mjs';

/**
 * Product API client used inside a worker.
 *
 * Each internal call carries a fresh short-lived token bound to the body, so a
 * captured request cannot be replayed or reused for different content.
 */
export function createProductClient({
  baseUrl,
  secret,
  workerId,
  tenantId,
  projectId,
  operationId = '',
  leaseId = '',
  generation = 0,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  if (!baseUrl || !secret) throw new Error('bridge needs productApiUrl and workerSecret');
  const base = baseUrl.replace(/\/+$/, '');

  const token = (method, target, body) => signToken({
    aud: 'product-api',
    sub: workerId,
    tenantId,
    projectId,
    operationId,
    leaseId,
    generation,
    method,
    target,
    jti: randomUUID(),
    ...(body === undefined ? {} : { body: bodyDigest(body) }),
  }, secret, 60);

  async function call(method, path, body, { timeoutMs = 30_000, signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${token(method, path, body)}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.status === 204) return { status: 204, payload: null };
      const text = await response.text();
      const payload = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
        error.code = payload?.error?.code || 'unavailable';
        error.status = response.status;
        throw error;
      }
      return { status: response.status, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async modelMessage({id,body},options={}) {
      const {payload}=await call('POST','/internal/v1/model-messages',{id,body},{timeoutMs:150000,...options});
      return payload.data;
    },
    async recordEvent(event) {
      const {payload}=await call('POST',`/internal/v1/executions/${encodeURIComponent(operationId)}/events`,event);
      return payload.data;
    },
    async registerArtifacts(items) {
      const {payload}=await call('POST',`/internal/v1/projects/${encodeURIComponent(projectId)}/artifacts`,{projectId,operationId,items});
      return payload.data.artifacts;
    },
    /** Create one pending interaction; resolves to its product id. */
    async createInteraction(payload, options = {}) {
      const request = { ...payload, requestKey:payload.requestKey || bodyDigest({kind:payload.kind,prompt:payload.prompt,scope:payload.scope,questions:payload.questions}), projectId, operationId };
      const { payload: body } = await call('POST', '/internal/v1/interactions', request, options);
      return { id: body.data.interactionId, expiresAt: body.data.expiresAt };
    },

    async cancelInteraction(id) {
      return call('POST', `/internal/v1/interactions/${encodeURIComponent(id)}/cancel`, {}, { timeoutMs: 5000 });
    },

    /**
     * Long-poll until the user answers or the deadline passes.
     * @returns { state: 'answered', answer } or null on timeout.
     */
    async waitAnswer(id, { deadlineMs = 300_000, pollMs = 25_000, signal } = {}) {
      const deadline = now() + deadlineMs;
      while (now() < deadline) {
        signal?.throwIfAborted();
        const remaining = Math.max(1, Math.min(pollMs, deadline - now()));
        let result;
        try { result = await call('GET', `/internal/v1/interactions/${encodeURIComponent(id)}/answer?waitMs=${Math.floor(remaining)}`, undefined, { timeoutMs: remaining + 5_000, signal }); }
        catch(error) {
          signal?.throwIfAborted();
          if(!['TypeError','AbortError','TimeoutError'].includes(error.name) && !(error.status>=500))throw error;
          // Only the idempotent answer GET may reconnect. Never retry a model or tool POST.
          await new Promise(resolve=>setTimeout(resolve,Math.min(500,Math.max(1,deadline-now()))));continue;
        }
        if (result.status === 200 && result.payload?.data?.state === 'answered') {
          return { state: 'answered', answer: result.payload.data.answer };
        }
      }
      return null;
    },
  };
}
