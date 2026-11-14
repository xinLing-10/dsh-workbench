/** Runtime configuration for the product API skeleton. Every value is explicit. */
export function loadConfig(env = process.env) {
  const number = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    modelCallsPaused: env.PRODUCT_API_MODEL_CALLS_PAUSED === '1',
    formalService: env.PRODUCT_API_FORMAL_SERVICE === '1',
    workerProtocol: env.PRODUCT_API_WORKER_PROTOCOL === '1',
    workerPoolFile: env.PRODUCT_API_WORKER_POOL_FILE || '',
    workerId: env.PRODUCT_API_WORKER_ID || '',
    simulate: env.PRODUCT_API_SIMULATE === '1',
    simulationFlow: env.PRODUCT_API_SIMULATE === '1' && env.PRODUCT_API_SIMULATION_FLOW === '1',
    port: number(env.PRODUCT_API_PORT, 8089),
    host: env.PRODUCT_API_HOST || '127.0.0.1',
    dbPath: env.PRODUCT_API_DB || 'control-data/product.sqlite',
    publicOrigin: env.PRODUCT_API_ORIGIN || '', // e.g. https://manager.example.com
    cookieSecure: env.PRODUCT_API_COOKIE_SECURE === '1',
    sessionTtlMs: number(env.PRODUCT_API_SESSION_TTL_MS, 7 * 24 * 3600 * 1000),
    inviteTtlMs: number(env.PRODUCT_API_INVITE_TTL_MS, 24 * 3600 * 1000),
    maxBodyBytes: number(env.PRODUCT_API_MAX_BODY, 64 * 1024),
    workerBaseUrl: env.PRODUCT_API_WORKER_URL || '',
    workerToken: env.PRODUCT_API_WORKER_TOKEN || '',
    // Batch-one scope: a single self-use account unless explicitly opened later.
    allowRedeem: env.PRODUCT_API_ALLOW_REDEEM === '1',
    // Root holding one directory per project id (the worker workspace volume).
    workspaceRoot: env.PRODUCT_API_WORKSPACE_ROOT || '',
    // Configured capability flags; false unless an operator turned them on.
    capabilities: Object.fromEntries(
      String(env.PRODUCT_API_CAPABILITIES || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => [value, true]),
    ),
  };
}
