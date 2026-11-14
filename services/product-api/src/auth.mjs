import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.mjs';
import { publicId } from './contracts.mjs';

const now = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** @returns a new tenant with an empty quota account. */
export function createTenant(db, { name = '个人租户' } = {}) {
  const id = publicId('ten');
  db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
  db.prepare('INSERT INTO quota_accounts (tenant_id) VALUES (?)').run(id);
  return { id, name };
}

/** @returns an invite token; only its hash is stored. */
export function createInvite(db, { tenantId, ttlMs }) {
  const token = randomBytes(24).toString('base64url');
  const id = publicId('inv');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare(
    'INSERT INTO invites (id, token_hash, tenant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sha256(token), tenantId, createdAt, expiresAt);
  return { id, token, expiresAt };
}

/** @returns { userId, tenantId } after redeeming a single-use invite. */
export async function redeemInvite(db, { token, email, password, ttlMs }) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('invalid invite token');
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid email');
  const row = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token));
  if (!row) throw new Error('invite not found');
  if (row.redeemed_at) throw new Error('invite already redeemed');
  if (Date.parse(row.expires_at) <= Date.now()) throw new Error('invite expired');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) throw new Error('email already registered');
  const { hash, params } = await hashPassword(password);
  const userId = publicId('usr');
  const createdAt = now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Password hashing yields; recheck single-use and expiry under the write lock.
    const current = db.prepare('SELECT redeemed_at,expires_at FROM invites WHERE id=?').get(row.id);
    if (!current || current.redeemed_at) throw new Error('invite already redeemed');
    if (Date.parse(current.expires_at) <= Date.now()) throw new Error('invite expired');
    db.prepare('INSERT INTO users (id, tenant_id, email, password_hash, password_params, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, row.tenant_id, email.toLowerCase(), hash, params, 'active', createdAt);
    db.prepare("INSERT INTO memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .run(row.tenant_id, userId, createdAt);
    db.prepare('UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE id = ?').run(createdAt, userId, row.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { userId, tenantId: row.tenant_id };
}

/** @returns a session id and CSRF token for the account. */
export async function login(db, { email, password, ttlMs }) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
  if (!user || user.status !== 'active') throw new Error('invalid credentials');
  if (!(await verifyPassword(String(password || ''), user.password_hash))) throw new Error('invalid credentials');
  return createSession(db, { userId: user.id, tenantId: user.tenant_id, ttlMs });
}

/** @returns { sessionId, csrfToken, expiresAt }. */
export function createSession(db, { userId, tenantId, ttlMs }) {
  const sessionId = publicId('ses');
  const csrfToken = randomBytes(24).toString('base64url');
  const createdAt = now();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, tenant_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, userId, tenantId, csrfToken, createdAt, expiresAt);
  return { sessionId, csrfToken, expiresAt };
}

/** @returns the session context, or null when missing/expired/revoked/disabled. */
export function authenticate(db, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  const row = db.prepare(
    `SELECT s.*, u.email, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  ).get(sessionId);
  if (!row || row.revoked_at || row.status !== 'active') return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return { sessionId: row.id, userId: row.user_id, tenantId: row.tenant_id, csrfToken: row.csrf_token, email: row.email };
}

/** Revoke one session (logout). */
export function revokeSession(db, sessionId) {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), sessionId);
}

/** @returns the quota view; the skeleton never charges anything yet. */
export function quotaView(db, tenantId) {
  const row = db.prepare('SELECT * FROM quota_accounts WHERE tenant_id = ?').get(tenantId);
  return {
    dailyLimit: row?.daily_limit ?? 0,
    monthlyLimit: row?.monthly_limit ?? 0,
    used: row?.used ?? 0,
    reserved: row?.reserved ?? 0,
    unknown: row?.unknown ?? 0,
    currency: row?.currency ?? 'CNY',
    configured: Boolean(row && (row.daily_limit > 0 || row.monthly_limit > 0)),
  };
}
