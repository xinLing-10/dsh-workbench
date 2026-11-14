import { fail, ERROR_CODES } from './contracts.mjs';

/** @returns a map of cookie name to raw value. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

/** @returns the parsed JSON body, or throws an error with a stable code. */
export async function readJson(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('请求体过大'), { code: ERROR_CODES.validation, status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON 对象'), { code: ERROR_CODES.validation, status: 400 });
  }
}

/** Send a JSON response with safe defaults. */
export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/** Send a stable error envelope. */
export function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, fail(code, message, extra));
}

/** Append one Set-Cookie header. */
export function setCookie(res, name, value, { maxAgeSec = 0, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAgeSec > 0) parts.push(`Max-Age=${maxAgeSec}`);
  if (maxAgeSec === 0) parts.push('Max-Age=0');
  if (secure) parts.push('Secure');
  parts.push('HttpOnly');
  const existing = res.getHeader('set-cookie');
  const values = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('set-cookie', [...values, parts.join('; ')]);
}

/** @returns the client address for rate limiting. */
export function clientIp(req) {
  return String(req.socket?.remoteAddress || 'unknown');
}

/** @returns whether the request Origin matches the configured product origin. */
export function originAllowed(req, config) {
  if (!config.publicOrigin) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === config.publicOrigin;
}

/** Fixed-window in-memory limiter; adequate for the single-node skeleton. */
export function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();
  return function take(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      buckets.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
}
