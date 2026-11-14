import { createSimulationFlow } from './simulation-flow.mjs';
/** Simulation only: no model, shell, network or project-file writes. */
import { acquireLease, leaseIsActive } from './workers.mjs';
import { appendEvent } from './app.mjs';
const now = () => new Date().toISOString();
const claimsFor = run => ({ sub: run.worker_id, leaseId: run.lease_id, generation: run.generation, tenantId: run.tenant_id, projectId: run.project_id, operationId: run.operation_id });

export function createSimulationEngine(db) {
  return {
    async execute(job) {
      const existing = db.prepare('SELECT * FROM simulation_receipts WHERE operation_id = ?').get(job.operation_id);
      if (existing) {
        if (existing.payload_hash !== job.payload_hash) throw new Error('simulation payload conflict');
        return JSON.parse(existing.result_json);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (!leaseIsActive(db, claimsFor(job))) throw new Error('simulation lease lost');
        const result = { text: '【模拟执行】已接收：' + job.text.slice(0, 500) + '\n\n这条回复仅验证任务派发和恢复，不代表真实模型分析或项目成果。' };
        db.prepare('INSERT INTO simulation_receipts VALUES (?, ?, ?, ?)').run(job.operation_id, job.payload_hash, JSON.stringify(result), now());
        db.exec('COMMIT'); return result;
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

export function createDispatcher({ db, enabled = false, engine: injectedEngine, publish = () => {}, interactive = false, leaseMs = null }) {
  if (enabled !== true) throw new Error('simulation must be explicitly enabled');
  const flow = createSimulationFlow(db, publish);
  const mock = createSimulationEngine(db);
  const engine = injectedEngine || { execute: job => job.flow_mode ? flow.execute(job) : mock.execute(job) };
  let busy = false;
  const notify = events => { for (const event of events) { try { publish(event); } catch { /* durable events remain replayable */ } } };
  const getRun = id => db.prepare('SELECT r.*, o.tenant_id, o.project_id, o.payload_hash, o.state AS operation_state FROM dispatch_runs r JOIN operations o ON o.id = r.operation_id WHERE r.operation_id = ?').get(id);

  function settle(id, { recover = false } = {}) {
    const events = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = getRun(id);
      if (!run || run.state === 'completed' || !['running','waiting','uncertain'].includes(run.operation_state)) { db.exec('COMMIT'); return false; }
      const receipt = db.prepare('SELECT * FROM simulation_receipts WHERE operation_id = ?').get(id);
      if (!receipt || receipt.payload_hash !== run.payload_hash) { db.exec('COMMIT'); return false; }
      if (!recover && !leaseIsActive(db, claimsFor(run))) { db.exec('COMMIT'); return false; }
      const result = JSON.parse(receipt.result_json);
      const status = result.status === 'cancelled' ? 'cancelled' : 'completed';
      db.prepare("UPDATE operations SET state = ?, updated_at = ? WHERE id = ? AND state IN ('running','waiting','uncertain')").run(status, now(), id);
      db.prepare("UPDATE dispatch_runs SET state = 'completed' WHERE operation_id = ?").run(id);
      db.prepare("UPDATE worker_leases SET state = 'revoked' WHERE id = ? AND state = 'active'").run(run.lease_id);
      db.prepare('DELETE FROM operation_outbox WHERE operation_id = ?').run(id);
      events.push(appendEvent(db, { tenantId: run.tenant_id, projectId: run.project_id, type: 'message_completed', operationId: id, payload: result }));
      events.push(appendEvent(db, { tenantId: run.tenant_id, projectId: run.project_id, type: 'task_status', operationId: id, payload: { state: status, simulation: true, recovered: recover } }));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notify(events); return true;
  }
  function uncertain(id) {
    db.exec('BEGIN IMMEDIATE'); let event;
    try {
      const run = getRun(id);
      if (!run || run.state !== 'running' || !['running','waiting'].includes(run.operation_state)) { db.exec('COMMIT'); return; }
      db.prepare("UPDATE operations SET state = 'uncertain', updated_at = ? WHERE id = ? AND state IN ('running','waiting')").run(now(), id);
      db.prepare("UPDATE dispatch_runs SET state = 'uncertain' WHERE operation_id = ?").run(id);
      db.prepare("UPDATE interaction_requests SET state='cancelled' WHERE operation_id=? AND project_id=? AND state='pending'").run(id,run.project_id);
      event = appendEvent(db, { tenantId: run.tenant_id, projectId: run.project_id, type: 'task_status', operationId: id, payload: { state: 'uncertain', simulation: true } });
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notify([event]);
  }
  function recover() {
    for (const row of db.prepare("SELECT operation_id FROM dispatch_runs WHERE state IN ('running','uncertain')").all()) {
      const run = getRun(row.operation_id);
      // A durable simulation receipt is evidence. Missing evidence never triggers re-execution.
      if (settle(run.operation_id, { recover: true })) continue;
      if (!leaseIsActive(db, claimsFor(run))) { uncertain(run.operation_id); continue; }
      // A persisted question is safe to resume after a crash between its commit
      // and the waiting-state acknowledgement. It never constitutes approval.
      if (run.flow_mode && run.operation_state === 'running' && db.prepare("SELECT operation_id FROM simulation_flows WHERE operation_id=? AND stage IN ('permission','question')").get(run.operation_id)) {
        let event;
        db.exec('BEGIN IMMEDIATE');
        try {
          if (leaseIsActive(db, claimsFor(run))) {
            const changed = db.prepare("UPDATE operations SET state='waiting',updated_at=? WHERE id=? AND state='running'").run(now(),run.operation_id);
            if (changed.changes) event = appendEvent(db,{tenantId:run.tenant_id,projectId:run.project_id,operationId:run.operation_id,type:'task_status',payload:{state:'waiting',simulation:true,recovered:true}});
          }
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
        if (event) notify([event]);
      }
    }
  }
  async function executeJob(id) {
    const source = db.prepare("SELECT payload_json FROM project_events WHERE operation_id = ? AND type = 'message_created' ORDER BY id LIMIT 1").get(id);
    const job = { ...getRun(id), text: JSON.parse(source?.payload_json || '{}').text || '' };
    try {
      const result = await engine.execute(job);
      if (result?.waiting) {
        if (!leaseIsActive(db, claimsFor(job))) { uncertain(id); return; }
        let event;
        db.exec('BEGIN IMMEDIATE');
        try {
          const changed = db.prepare("UPDATE operations SET state = 'waiting', updated_at = ? WHERE id = ? AND state = 'running'").run(now(),id);
          if (changed.changes) event = appendEvent(db,{tenantId:job.tenant_id,projectId:job.project_id,operationId:id,type:'task_status',payload:{state:'waiting',simulation:true}});
          db.exec('COMMIT');
        } catch(error) { db.exec('ROLLBACK'); throw error; }
        if (event) notify([event]);
      } else if (!settle(id)) uncertain(id);
    } catch { uncertain(id); }
  }
  async function tick() {
    if (busy) return false;
    busy = true;
    try {
      recover();
      const waiting = db.prepare("SELECT r.operation_id FROM dispatch_runs r JOIN operations o ON o.id=r.operation_id WHERE r.state='running' AND o.state='waiting' ORDER BY r.created_at LIMIT 1").get();
      if (waiting) { await executeJob(waiting.operation_id); return true; }
      const operation = db.prepare("SELECT o.* FROM operations o JOIN operation_outbox q ON q.operation_id = o.id JOIN projects p ON p.id = o.project_id AND p.tenant_id = o.tenant_id WHERE o.state = 'queued' AND p.status = 'active' AND EXISTS (SELECT 1 FROM workers w WHERE w.tenant_id = o.tenant_id AND w.status = 'active' AND NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.worker_id = w.id AND l.state = 'active' AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS (SELECT 1 FROM dispatch_runs r WHERE r.worker_id = w.id AND r.state IN ('running','uncertain'))) AND q.next_at <= ? AND NOT EXISTS (SELECT 1 FROM dispatch_runs r WHERE r.operation_id = o.id) ORDER BY q.id LIMIT 1").get(now());
      if (!operation) return false;
      const worker = db.prepare("SELECT w.id FROM workers w WHERE w.tenant_id = ? AND w.status = 'active' AND NOT EXISTS (SELECT 1 FROM worker_leases l WHERE l.worker_id = w.id AND l.state = 'active' AND l.expires_at > ?) AND NOT EXISTS (SELECT 1 FROM dispatch_runs r WHERE r.worker_id = w.id AND r.state IN ('running','uncertain')) ORDER BY w.id LIMIT 1").get(operation.tenant_id, now());
      if (!worker) return false;
      let lease;
      try { lease = acquireLease(db, { workerId: worker.id, projectId: operation.project_id, operationId: operation.id, ttlMs: leaseMs ?? ((interactive || operation.simulation_flow) ? 300000 : 30000) }); }
      catch (error) { if (error.status === 409) return false; throw error; }
      let event;
      db.exec('BEGIN IMMEDIATE');
      try {
        const claimed = db.prepare("UPDATE operations SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM dispatch_runs WHERE operation_id = ?) AND NOT EXISTS (SELECT 1 FROM dispatch_runs WHERE state = 'running')").run(now(), operation.id, operation.id);
        if (!claimed.changes) { db.prepare("UPDATE worker_leases SET state = 'revoked' WHERE id = ?").run(lease.id); db.exec('COMMIT'); return false; }
        db.prepare("INSERT INTO dispatch_runs(operation_id,worker_id,lease_id,generation,state,engine,created_at,flow_mode) VALUES (?, ?, ?, ?, 'running', 'simulation', ?, ?)").run(operation.id, worker.id, lease.id, lease.generation, now(), (interactive || operation.simulation_flow) ? 1 : 0);
        db.prepare('UPDATE operation_outbox SET attempts = attempts + 1 WHERE operation_id = ?').run(operation.id);
        event = appendEvent(db, { tenantId: operation.tenant_id, projectId: operation.project_id, type: 'task_status', operationId: operation.id, payload: { state: 'running', simulation: true } });
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      notify([event]);
      await executeJob(operation.id);
      return true;
    } finally { busy = false; }
  }
  return { tick, recover };
}
