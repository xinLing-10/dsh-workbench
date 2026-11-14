import { randomUUID } from 'node:crypto';
import { verifyToken } from '../../../packages/manager-contracts/tokens.mjs';

const audit = (db, tenantId, actor, action, target) => db.prepare('INSERT INTO audit_events(tenant_id,actor,action,target,at) VALUES (?,?,?,?,?)').run(tenantId, actor, action, target, new Date().toISOString());
const invalid = message => Object.assign(new Error(message), { status: 409 });
export function registerWorker(db, { workerId, tenantId, secret }) {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(workerId || '') || typeof secret !== 'string' || secret.length < 32 || !db.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId)) throw invalid('Worker 身份或密钥无效');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO workers(id, tenant_id, secret) VALUES (?, ?, ?)').run(workerId, tenantId, secret);
    audit(db, tenantId, 'control-plane', 'worker_registered', workerId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Control-plane only: never exposed as a browser/internal-worker HTTP route. */
export function acquireLease(db, { workerId, projectId, operationId = '', ttlMs = 300000 }) {
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 3600000 || typeof operationId !== 'string' || operationId.length > 100) throw invalid('租约参数无效');
  db.exec('BEGIN IMMEDIATE');
  try {
    const worker = db.prepare("SELECT * FROM workers WHERE id = ? AND status = 'active'").get(workerId);
    const project = worker && db.prepare("SELECT * FROM projects WHERE id = ? AND tenant_id = ? AND status = 'active'").get(projectId, worker.tenant_id);
    if (!project) throw invalid('Worker 无权访问项目');
    const now = new Date().toISOString();
    db.prepare("UPDATE worker_leases SET state = 'expired' WHERE worker_id = ? AND state = 'active' AND expires_at <= ?").run(workerId, now);
    if (db.prepare("SELECT id FROM worker_leases WHERE worker_id = ? AND state = 'active'").get(workerId)) throw invalid('Worker 已有正在处理的操作');
    const generation = worker.generation + 1;
    const lease = { id: 'lease_' + randomUUID(), workerId, tenantId: worker.tenant_id, projectId, operationId, generation, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    db.prepare('UPDATE workers SET generation = ? WHERE id = ?').run(generation, workerId);
    db.prepare("INSERT INTO worker_leases VALUES (?, ?, ?, ?, ?, ?, ?, 'active')").run(lease.id, workerId, lease.tenantId, projectId, operationId, generation, lease.expiresAt);
    audit(db, worker.tenant_id, 'control-plane', 'lease_acquired', lease.id);
    db.exec('COMMIT'); return lease;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function revokeLease(db, id) {
  const row = db.prepare('SELECT tenant_id FROM worker_leases WHERE id = ?').get(id);
  if (!row) throw invalid('租约不存在');
  audit(db, row.tenant_id, 'control-plane', 'lease_revoked', id);
  db.prepare("UPDATE worker_leases SET state = 'revoked' WHERE id = ? AND state = 'active'").run(id);
}
export function disableWorker(db, id) {
  const worker = db.prepare('SELECT tenant_id FROM workers WHERE id = ?').get(id);
  if (!worker) throw invalid('Worker 不存在');
  db.prepare("UPDATE workers SET status = 'disabled' WHERE id = ?").run(id);
  audit(db, worker.tenant_id, 'control-plane', 'worker_disabled', id);
}
export function leaseIsActive(db, claims) {
  const row = db.prepare("SELECT l.*, w.status AS worker_status, w.generation AS current_generation, p.status AS project_status FROM worker_leases l JOIN workers w ON w.id = l.worker_id JOIN projects p ON p.id = l.project_id AND p.tenant_id = l.tenant_id WHERE l.id = ?").get(claims.leaseId || '');
  return Boolean(row && row.state === 'active' && row.worker_status === 'active' && row.project_status === 'active' && row.expires_at > new Date().toISOString() && row.worker_id === claims.sub && row.tenant_id === claims.tenantId && row.project_id === claims.projectId && row.operation_id === claims.operationId && row.generation === claims.generation && row.current_generation === claims.generation);
}
export function authenticateWorker(db, req, body) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return 'unauthorized';
  if (token.length > 8192) return 'format';
  let untrusted;
  try { untrusted = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); } catch { return 'format'; }
  const worker = typeof untrusted?.sub === 'string' && db.prepare("SELECT * FROM workers WHERE id = ? AND status = 'active'").get(untrusted.sub);
  if (!worker) return 'signature';
  const result = verifyToken(token, worker.secret, { audience: 'product-api', body, skewSeconds: 0 });
  if (!result.ok) return result.error;
  const c = result.claims;
  if (!Number.isFinite(c.exp) || !Number.isFinite(c.iat) || c.exp - c.iat > 90 || c.exp <= c.iat || typeof c.jti !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(c.jti)) return 'format';
  if (c.exp <= Math.floor(Date.now() / 1000)) return 'expired';
  if (c.method !== req.method || c.target !== req.url) return 'target';
  if (!leaseIsActive(db, c)) return 'lease';
  if (body && ((body.projectId !== undefined && body.projectId !== c.projectId) || (body.operationId !== undefined && body.operationId !== c.operationId))) return 'lease';
  const now = new Date().toISOString();
  db.prepare('DELETE FROM internal_tokens WHERE exp < ?').run(now);
  try { db.prepare('INSERT INTO internal_tokens(jti, exp, created_at) VALUES (?, ?, ?)').run(c.jti, new Date(c.exp * 1000).toISOString(), now); } catch { return 'replay'; }
  return c;
}
