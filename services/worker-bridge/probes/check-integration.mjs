/**
 * Integration checker for the worker bridge.
 *
 * Reads the product control database (read-only) and reports whether a real
 * worker actually talked to the product: interactions created/answered,
 * messages, artifacts, and internal token receipts (proof the bridge called).
 *
 *   node probes/check-integration.mjs [path/to/product.sqlite]
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const file = process.argv[2] || 'control-data/product.sqlite';
if (!existsSync(file)) {
  console.error(`no control database at ${file}`);
  process.exit(2);
}
const db = new DatabaseSync(file, { readOnly: true });
const count = (sql) => Number(db.prepare(sql).get()?.n || 0);

const report = {
  projects: count('SELECT count(*) AS n FROM projects'),
  messages: count("SELECT count(*) AS n FROM project_events WHERE type = 'message_created'"),
  interactionsCreated: count('SELECT count(*) AS n FROM interaction_requests'),
  interactionsAnswered: count("SELECT count(*) AS n FROM interaction_requests WHERE state = 'answered'"),
  interactionsExpired: count("SELECT count(*) AS n FROM interaction_requests WHERE state = 'expired'"),
  interactionsPending: count("SELECT count(*) AS n FROM interaction_requests WHERE state = 'pending'"),
  artifacts: count('SELECT count(*) AS n FROM artifact_index'),
  artifactsConfirmed: count('SELECT count(*) AS n FROM artifact_index WHERE confirmed = 1'),
  internalCalls: count('SELECT count(*) AS n FROM internal_tokens'),
};

const lines = [
  ['项目', report.projects],
  ['消息事件', report.messages],
  ['互动（创建/已答/待答/过期）', `${report.interactionsCreated} / ${report.interactionsAnswered} / ${report.interactionsPending} / ${report.interactionsExpired}`],
  ['成果（总数/已确认）', `${report.artifacts} / ${report.artifactsConfirmed}`],
  ['内部令牌签发次数', report.internalCalls],
];
for (const [name, value] of lines) console.log(`${name.padEnd(26)} ${value}`);

const verdict = report.internalCalls > 0 && report.interactionsAnswered > 0
  ? 'PASS: 真实 Worker 已通过桥接创建问题并由用户在网页回答'
  : report.internalCalls > 0
    ? 'PARTIAL: Worker 已调用产品接口，但还没有用户回答闭环'
    : 'EMPTY: 尚无 Worker 调用记录（桥接未启用或尚未运行）';
console.log(`\n${verdict}`);
process.exit(verdict.startsWith('PASS') ? 0 : 1);
