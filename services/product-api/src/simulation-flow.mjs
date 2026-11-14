/** Durable, local simulation: no model, shell, network or project-file writes. */
import { createHash } from 'node:crypto';
import { appendEvent } from './app.mjs';
import { publicId } from './contracts.mjs';
import { leaseIsActive } from './workers.mjs';
const now = () => new Date().toISOString();
export function createSimulationFlow(db, publish = () => {}) {
  function notify(events) { for (const e of events) { try { publish(e); } catch {} } }
  return { async execute(job) {
    const claims = { sub: job.worker_id, leaseId: job.lease_id, generation: job.generation, tenantId: job.tenant_id, projectId: job.project_id, operationId: job.operation_id };
    if (!leaseIsActive(db, claims)) throw new Error('simulation lease lost');
    const prior = db.prepare('SELECT * FROM simulation_receipts WHERE operation_id = ?').get(job.operation_id);
    if (prior) {
      if (prior.payload_hash !== job.payload_hash) throw new Error('simulation payload conflict');
      return JSON.parse(prior.result_json);
    }
    const events = [];
    const event = (type, payload) => events.push(appendEvent(db, { tenantId: job.tenant_id, projectId: job.project_id, operationId: job.operation_id, type, payload }));
    const interaction = (kind, prompt, questions = []) => {
      const id = publicId('itx');
      const expires = db.prepare('SELECT expires_at FROM worker_leases WHERE id = ?').get(job.lease_id).expires_at;
      db.prepare("INSERT INTO interaction_requests(id,tenant_id,project_id,operation_id,kind,prompt,scope,state,created_at,expires_at,questions_json) VALUES(?,?,?,?,?,?,?,'pending',?,?,?)").run(id, job.tenant_id, job.project_id, job.operation_id, kind, prompt, 'simulation-only', now(), expires, JSON.stringify(questions));
      event('interaction_created', { interactionId: id, kind, simulation: true });
      return id;
    };
    const receipt = result => {
      db.prepare('INSERT INTO simulation_receipts VALUES(?,?,?,?)').run(job.operation_id, job.payload_hash, JSON.stringify(result), now());
      return result;
    };
    let result;
    db.exec('BEGIN IMMEDIATE');
    try {
      const operation = db.prepare('SELECT state FROM operations WHERE id=?').get(job.operation_id);
      if (!leaseIsActive(db, claims) || !['running','waiting'].includes(operation?.state)) throw new Error('simulation lease or operation lost');
      let flow = db.prepare('SELECT * FROM simulation_flows WHERE operation_id = ?').get(job.operation_id);
      if (!flow) {
        const id = interaction('permission', '【模拟流程】允许生成一份示例文档吗？仅保存模拟文档，不读取或修改项目代码。');
        db.prepare("INSERT INTO simulation_flows VALUES(?,'permission',?,NULL)").run(job.operation_id,id);
        result = { waiting: true };
      } else {
        const row = db.prepare('SELECT * FROM interaction_requests WHERE id = ?').get(flow.stage === 'permission' ? flow.permission_id : flow.question_id);
        if (!row || row.state === 'cancelled' || row.state === 'expired' || row.expires_at <= now()) {
          db.prepare("UPDATE simulation_flows SET stage='cancelled' WHERE operation_id=?").run(job.operation_id);
          result = receipt({ status: 'cancelled', text: '【模拟流程已取消】问题已失效，没有生成示例成果。' });
        } else if (row.state !== 'answered') result = { waiting: true };
        else if (flow.stage === 'permission') {
          if (!['allow','allowed','allowed-once','同意','允许','允许一次'].includes(row.answer.toLowerCase())) {
            db.prepare("UPDATE simulation_flows SET stage='cancelled' WHERE operation_id=?").run(job.operation_id);
            result = receipt({ status: 'cancelled', text: '【模拟流程已取消】你拒绝了本次许可，没有生成示例成果。' });
          } else {
            const questions = [{ id: 'audience', question: '这个产品希望帮助谁？', options: [] }, { id: 'delivery', question: '先看看哪一种示例？', options: [{ label: '示例需求说明' }, { label: '示例学习提纲' }], multiSelect: false }];
            const id = interaction('question', '【模拟流程】再确认两个小问题', questions);
            db.prepare("UPDATE simulation_flows SET stage='question',question_id=? WHERE operation_id=?").run(id,job.operation_id);
            result = { waiting: true };
          }
        } else {
          const answer = JSON.parse(row.answer);
          const content = '# 模拟交付示例（非真实分析）\n\n> 仅用于验证审批、问答、审阅和下载流程。未调用模型，不能当作真实项目结论。\n\n## 你的原始想法\n\n' + job.text + '\n\n## 你确认的信息\n\n' + answer.answers.map(a => '- ' + ({ audience: '服务对象', delivery: '示例类型' }[a.id] || '补充信息') + '：' + [...a.selected, a.custom || ''].filter(Boolean).join('；')).join('\n') + '\n\n## 后续说明\n\n真实分析和实施尚未接通。请阅读后再决定是否确认这份模拟示例。\n';
          const artifactId = publicId('art');
          const relativePath = 'simulation/' + job.operation_id + '/模拟交付示例.md';
          const hash = createHash('sha256').update(content).digest('hex');
          db.prepare('INSERT INTO artifact_index(id,tenant_id,project_id,relative_path,sha256,version,confirmed,created_at) VALUES(?,?,?,?,?,1,0,?)').run(artifactId,job.tenant_id,job.project_id,relativePath,hash,now());
          db.prepare('INSERT INTO simulation_documents VALUES(?,?)').run(artifactId,content);
          db.prepare("UPDATE simulation_flows SET stage='completed' WHERE operation_id=?").run(job.operation_id);
          event('artifact_version', { artifactId, simulation: true });
          result = receipt({ text: '【模拟执行】示例文档已生成，请到“我的成果”阅读、确认或下载。它不是模型分析结果。', artifactId });
        }
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    notify(events); return result;
  } };
}
