/**
 * Product contracts shared by the standalone manager BFF and its clients.
 *
 * Pure data and validators only: no network, no database, no framework. The
 * browser never receives DSH paths, session ids or model credentials, so every
 * field here is an opaque identifier or a business-neutral code.
 */

export const API_PREFIX = '/api/v1';

/** Stable error codes. Clients switch on these, never on message text. */
export const ERROR_CODES = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  validation: 'validation',
  rate_limited: 'rate_limited',
  capability_unavailable: 'capability_unavailable',
  quota_exceeded: 'quota_exceeded',
  unavailable: 'unavailable',
  csrf: 'csrf',
};

/** Business actions the product accepts. Anything else is rejected. */
export const ACTIONS = [
  'send_message',
  'start_proposed_work',
  'confirm_artifact',
  'request_changes',
  'cancel_operation',
  'answer_question',
  'respond_permission',
  'start_learning_step',
  'submit_learning_answer',
];

/** Event types of the per-project stream. */
export const EVENT_TYPES = [
  'interaction_created',
  'interaction_answered',
  'interaction_cancelled',
  'message_created',
  'message_completed',
  'question_pending',
  'permission_pending',
  'task_status',
  'artifact_version',
  'quota_changed',
  'recovery_check',
  'service_status',
];

/** Bridge capabilities; a false capability must block, never silently allow. */
export const CAPABILITIES = ['bridge', 'questions', 'approvals', 'usage', 'learning'];

/** @returns a product envelope for a success payload. */
export function ok(data, extra = {}) {
  return { ok: true, data, ...extra };
}

/** @returns a stable error envelope. `message` is for humans, `code` for code. */
export function fail(code, message, extra = {}) {
  if (typeof code !== 'string' || !Object.values(ERROR_CODES).includes(code)) {
    throw new Error(`unknown error code: ${code}`);
  }
  return { ok: false, error: { code, message: String(message || code) }, ...extra };
}

/** @returns a validated event envelope; throws when the shape is wrong. */
export function eventEnvelope(input) {
  const { id, projectId, type, revision, payload } = input || {};
  if (!Number.isInteger(id) || id < 1) throw new Error('event id must be a positive integer');
  if (typeof projectId !== 'string' || projectId === '') throw new Error('projectId is required');
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);
  if (!Number.isInteger(revision) || revision < 0) throw new Error('revision must be a non-negative integer');
  return {
    id,
    projectId,
    type,
    operationId: input.operationId || null,
    revision,
    at: input.at || new Date().toISOString(),
    payload: payload === undefined ? null : payload,
  };
}

/** @returns a new opaque public id. Never derived from a filesystem path. */
export function publicId(prefix, random) {
  const raw = typeof random === 'function' ? random() : globalThis.crypto.randomUUID();
  return `${prefix}_${String(raw).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
}

/** @returns whether value looks like one of our public ids of that prefix. */
export function isPublicId(value, prefix) {
  return typeof value === 'string' && new RegExp(`^${prefix}_[a-zA-Z0-9]{8,32}$`).test(value);
}

/** @returns the action name when allowed, otherwise null. */
export function parseAction(value) {
  return ACTIONS.includes(value) ? value : null;
}

/**
 * Idempotency rule: the same request id with the same payload returns the
 * original operation; a different payload is a conflict.
 * @returns 'new' | 'replay' | 'conflict'
 */
export function idempotencyDecision(existing, payloadHash) {
  if (!existing) return 'new';
  return existing.payloadHash === payloadHash ? 'replay' : 'conflict';
}
