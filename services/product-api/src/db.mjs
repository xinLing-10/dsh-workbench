import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 9;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_params TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeemed_by TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  board_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS projects_by_tenant ON projects(tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  engine_request_id TEXT,
  engine_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('accepted','queued','running','waiting','completed','failed','cancelled','uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, project_id, request_id)
);
CREATE INDEX IF NOT EXISTS operations_by_project ON operations(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS operation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  event TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('question','permission')),
  prompt TEXT NOT NULL,
  scope TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','answered','expired','cancelled')),
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS interactions_by_project ON interaction_requests(project_id, state);

CREATE TABLE IF NOT EXISTS artifact_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, relative_path, version)
);

CREATE TABLE IF NOT EXISTS quota_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id),
  daily_limit INTEGER NOT NULL DEFAULT 0,
  monthly_limit INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY'
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','settled','released','unknown')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_calls (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  upstream_id TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  price_version TEXT NOT NULL,
  settlement TEXT NOT NULL CHECK (settlement IN ('settled','unknown')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  operation_id TEXT,
  revision INTEGER NOT NULL,
  payload_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_project ON project_events(project_id, id);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worker_leases (
  id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL REFERENCES workers(id),
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','expired','revoked'))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_worker_lease ON worker_leases(worker_id) WHERE state = 'active';
CREATE TABLE IF NOT EXISTS dispatch_runs (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  worker_id TEXT NOT NULL REFERENCES workers(id),
  lease_id TEXT NOT NULL REFERENCES worker_leases(id),
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','completed','uncertain')),
  engine TEXT NOT NULL CHECK(engine = 'simulation'),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulation_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulation_flows (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  stage TEXT NOT NULL,
  permission_id TEXT,
  question_id TEXT
);
CREATE TABLE IF NOT EXISTS simulation_documents (
  artifact_id TEXT PRIMARY KEY REFERENCES artifact_index(id),
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_contents (
  artifact_id TEXT PRIMARY KEY REFERENCES artifact_index(id),
  bytes BLOB NOT NULL,
  source_call_id TEXT,
  source_operation_id TEXT,
  source_model TEXT
);
CREATE TABLE IF NOT EXISTS worker_executions (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id), worker_id TEXT NOT NULL REFERENCES workers(id),
  tenant_id TEXT NOT NULL, project_id TEXT NOT NULL, lease_id TEXT NOT NULL REFERENCES worker_leases(id),
  generation INTEGER NOT NULL, engine_id TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL,
  state TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, deadline TEXT NOT NULL,
  stop_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_execution_busy ON worker_executions(worker_id) WHERE state NOT IN ('completed','cancelled','failed');
CREATE TABLE IF NOT EXISTS worker_execution_events (
  operation_id TEXT NOT NULL REFERENCES worker_executions(operation_id), sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL, digest TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY(operation_id,sequence), UNIQUE(operation_id,event_id)
);
CREATE TABLE IF NOT EXISTS worker_interaction_keys (
  operation_id TEXT NOT NULL, request_key TEXT NOT NULL, digest TEXT NOT NULL,
  interaction_id TEXT NOT NULL REFERENCES interaction_requests(id), PRIMARY KEY(operation_id,request_key)
);
CREATE TABLE IF NOT EXISTS worker_execution_artifacts (
  operation_id TEXT NOT NULL REFERENCES worker_executions(operation_id), artifact_id TEXT NOT NULL REFERENCES artifact_index(id),
  PRIMARY KEY(operation_id,artifact_id)
);
CREATE TABLE IF NOT EXISTS platform_admins (
 user_id TEXT PRIMARY KEY REFERENCES users(id), granted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_run_authorization (
 id INTEGER PRIMARY KEY CHECK(id=1), authorization_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_policies (
 scope TEXT NOT NULL CHECK(scope IN ('global','user','project')), scope_id TEXT NOT NULL,
 token_limit INTEGER NOT NULL CHECK(token_limit>=0), window TEXT NOT NULL CHECK(window IN ('day','month','lifetime')),
 revision INTEGER NOT NULL, PRIMARY KEY(scope,scope_id)
);
CREATE TABLE IF NOT EXISTS service_budget_carryovers (
 id TEXT PRIMARY KEY, used INTEGER NOT NULL, held INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 evidence TEXT NOT NULL, imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_model_calls (
 id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id), project_id TEXT NOT NULL REFERENCES projects(id),
 payload_hash TEXT NOT NULL, reservation INTEGER NOT NULL, actual INTEGER,
 state TEXT NOT NULL CHECK(state IN ('held','settled','unknown')), evidence_json TEXT NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS service_calls_scope ON service_model_calls(user_id,project_id,state);
CREATE TABLE IF NOT EXISTS internal_tokens (
  jti TEXT PRIMARY KEY,
  exp TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  meta_json TEXT,
  at TEXT NOT NULL
);
`;

/** @returns an open database with the product schema applied. */
export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  const columns = db.prepare('PRAGMA table_info(interaction_requests)').all();
  if (!columns.some(c => c.name === 'questions_json')) db.exec("ALTER TABLE interaction_requests ADD COLUMN questions_json TEXT NOT NULL DEFAULT '[]'");
  if (!db.prepare('PRAGMA table_info(operations)').all().some(c => c.name === 'simulation_flow')) db.exec('ALTER TABLE operations ADD COLUMN simulation_flow INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(dispatch_runs)').all().some(c => c.name === 'flow_mode')) db.exec('ALTER TABLE dispatch_runs ADD COLUMN flow_mode INTEGER NOT NULL DEFAULT 0');
  if (!db.prepare('PRAGMA table_info(operations)').all().some(c => c.name === 'actor_user_id')) db.exec('ALTER TABLE operations ADD COLUMN actor_user_id TEXT REFERENCES users(id)');
  const row = db.prepare('SELECT version FROM schema_meta').get();
  if (!row) db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION);
  if (row && row.version < SCHEMA_VERSION) db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION);
  return db;
}

export { SCHEMA_VERSION };
