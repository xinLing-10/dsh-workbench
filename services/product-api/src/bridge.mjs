import { CAPABILITIES } from './contracts.mjs';

/**
 * Internal bridge to one tenant's DSH worker.
 *
 * Capabilities start false on purpose: the design forbids pretending a
 * connection exists. Callers must block on false instead of falling back to a
 * native session or silently dropping the request.
 */
export function createBridge({ config }) {
  // Configuration is not evidence of a working transport. Until dispatch and
  // capability negotiation exist, never advertise execution as available.
  const capabilities = Object.fromEntries(CAPABILITIES.map((name) => [name, false]));
  return {
    /** @returns the negotiated capability map (all false in this slice). */
    capabilities() {
      return { ...capabilities, simulation: config.simulate === true, configured: Boolean(config.workerBaseUrl && config.workerToken) };
    },
    async dispatch() {
      throw Object.assign(new Error('执行桥接尚未接通，当前无法提交任务'), {
        code: 'capability_unavailable',
        status: 409,
      });
    },
    async cancel() {
      throw Object.assign(new Error('执行桥接尚未接通，当前无法停止任务'), {
        code: 'capability_unavailable',
        status: 409,
      });
    },
  };
}
