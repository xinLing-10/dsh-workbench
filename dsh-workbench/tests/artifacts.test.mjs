import { extractDefinitions } from '../knowledge.js';
import { lineDiff } from '../reviews.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { __test as host, apply } from '../index.js';
import { DOCUMENTS, managedPath, documentPath, atomicJson } from '../artifacts.js';

const base = await mkdtemp(join(tmpdir(), 'dsh-artifacts-tests-'));
process.env.DSH_HOME = join(base, 'home');
test.after(() => rm(base, { recursive: true, force: true }));

async function fixture() {
  const root = await mkdtemp(join(base, 'project-'));
  const ctx = { get: () => ({ defaultDirectory: root }) };
  const routes = Object.fromEntries(['state', 'boards', 'rounds', 'file', 'raw', 'library', 'artifacts', 'review', 'knowledge', 'context'].map(
    (name) => [name, host.serializedHandler(ctx, host[`${name}Handler`](ctx, () => false))]));
  async function call(name, { method = 'GET', body, board, query = '' } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = `/workbench/${name}${query}`;
    req.headers = { 'x-workbench-root': encodeURIComponent(root), ...(board ? { 'x-workbench-board': board } : {}) };
    const chunks = [];
    const res = new Writable({ write(chunk, encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
    res.statusCode = 200; res.headers = {};
    res.setHeader = (name, value) => { res.headers[name] = value; };
    res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers); };
    const done = new Promise((resolve, reject) => { res.on('finish', resolve); res.on('error', reject); });
    await routes[name](req, res);
    await done;
    const bytes = Buffer.concat(chunks);
    let json; try { json = JSON.parse(bytes.toString()); } catch {}
    return { status: res.statusCode, json, bytes, headers: res.headers };
  }
  const initial = await call('state');
  assert.equal(initial.status, 200);
  const id = initial.json.boardId;
  async function fill(board = id) {
    for (const name of Object.values(DOCUMENTS).flat()) {
      const path = join(root, '.dsh/workbench/changes', board, 'documents', name);
      await writeFile(path, name.endsWith('.docx') ? host.buildDocx('# Requirements\nOriginal', 'Requirements') : `${board}: ${name}\nOriginal`);
    }
  }
  async function confirm(stage, board = id) {
    const review = await call('artifacts', { board });
    return call('artifacts', { method: 'POST', board,
      body: { action: 'confirm', stage, hashes: review.json.stages[stage].hashes, note: 'Reviewed' } });
  }
  return { root, ctx, call, id, fill, confirm, initial: initial.json };
}

test('new rounds have independent files; root documents never satisfy a new round', async () => {
  const f = await fixture(); await f.fill();
  const next = (await f.call('rounds', { method: 'POST' })).json;
  assert.notEqual(next.boardId, f.id);
  await writeFile(join(f.root, '需求分析阶段.md'), 'Wrong root document');
  const missing = await f.call('file', { board: next.boardId, query: '?path=需求分析阶段.md&soft=1' });
  assert.equal(missing.json.missing, true);
  const old = await f.call('file', { board: f.id, query: '?path=需求分析阶段.md' });
  assert.match(old.json.text, /Original/);
  const library = await f.call('library', { board: next.boardId });
  assert.equal(library.json.files.some((file) => file.path === '需求分析阶段.md'), false);
});

test('confirmation stores exact immutable bytes, revisions and durable receipts', async () => {
  const f = await fixture(); await f.fill();
  const first = await f.confirm('spec');
  assert.equal(first.status, 200, JSON.stringify(first.json));
  const artifact = first.json.approval.artifacts.find((item) => item.name === '需求分析阶段.md');
  assert.equal(artifact.revision, 1);
  const original = await readFile(join(f.root, artifact.snapshot));
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents', artifact.name), 'Version 2');
  const invalid = (await f.call('artifacts', { board: f.id })).json;
  assert.equal(invalid.state.stageData.spec.confirmed, false);
  assert.equal(invalid.state.stageData.spec.needsReview, true);
  const second = await f.confirm('spec');
  assert.equal(second.status, 200);
  assert.equal(second.json.approval.artifacts.find((item) => item.name === artifact.name).revision, 2);
  assert.deepEqual(await readFile(join(f.root, artifact.snapshot)), original);
  const history = (await f.call('artifacts', { board: f.id })).json.history;
  assert.equal(history.length, 2);
  assert.notEqual(history[0].id, history[1].id);
  const download = await f.call('raw', { board: f.id,
    query: `?path=${encodeURIComponent(artifact.snapshot)}&name=${encodeURIComponent(artifact.name)}&download=1` });
  assert.deepEqual(download.bytes, original);
  assert.match(download.headers['content-type'], /text\/markdown/);
});

test('an upstream change invalidates downstream confirmation; restoration cannot silently reapprove', async () => {
  const f = await fixture(); await f.fill();
  assert.equal((await f.confirm('spec')).status, 200);
  assert.equal((await f.confirm('design')).status, 200);
  const path = join(f.root, f.initial.artifactStorage.directory, 'documents/需求交接.md');
  const old = await readFile(path); await writeFile(path, 'Changed');
  let state = (await f.call('state', { board: f.id })).json;
  assert.equal(state.stageData.spec.confirmed, false);
  assert.equal(state.stageData.design.confirmed, false);
  assert.equal(state.stageData.design.needsReview, true);
  await writeFile(path, old);
  state = (await f.call('state', { board: f.id })).json;
  assert.equal(state.stageData.spec.confirmed, false);
  assert.equal((await f.confirm('design')).status, 409);
});

test('deleted approved files invalidate confirmation', async () => {
  const f = await fixture(); await f.fill(); await f.confirm('spec');
  await rm(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'));
  const state = (await f.call('state', { board: f.id })).json;
  assert.equal(state.stageData.spec.confirmed, false);
  assert.equal((await f.confirm('spec')).status, 409);
});

test('a changed version between review and confirmation is rejected without publishing a receipt', async () => {
  const f = await fixture(); await f.fill();
  const review = (await f.call('artifacts', { board: f.id })).json;
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求交接.md'), 'Changed during review');
  const result = await f.call('artifacts', { method: 'POST', board: f.id,
    body: { action: 'confirm', stage: 'spec', hashes: review.stages.spec.hashes } });
  assert.equal(result.status, 409);
  assert.equal((await f.call('artifacts', { board: f.id })).json.history.length, 0);
});

test('missing handoff and incremental baseline block confirmation', async () => {
  const f = await fixture(); await f.fill();
  await rm(join(f.root, f.initial.artifactStorage.directory, 'documents/需求交接.md'));
  assert.equal((await f.confirm('spec')).status, 409);
  const next = (await f.call('rounds', { method: 'POST' })).json;
  await f.fill(next.boardId);
  await rm(join(f.root, next.state.artifactStorage.directory, 'documents/现状基线.md'));
  assert.equal((await f.confirm('spec', next.boardId)).status, 409);
});

test('plain state writes cannot forge approvals or storage metadata', async () => {
  const f = await fixture();
  const forged = structuredClone(f.initial);
  forged.stageData.spec.confirmed = true;
  forged.stageData.spec.approvalId = 'forged';
  forged.artifactStorage.directory = '../../outside';
  const result = await f.call('state', { method: 'PUT', board: f.id, body: forged });
  assert.equal(result.status, 200);
  assert.equal(result.json.stageData.spec.confirmed, false);
  assert.notEqual(result.json.stageData.spec.approvalId, 'forged');
  assert.equal(result.json.artifactStorage.directory, f.initial.artifactStorage.directory);
});

test('explicit board writes stay with that board after another tab changes active board', async () => {
  const f = await fixture();
  const next = (await f.call('rounds', { method: 'POST' })).json;
  const old = (await f.call('state', { board: f.id })).json;
  old.project.name = 'Old tab change';
  const result = await f.call('state', { method: 'PUT', board: f.id, body: old });
  assert.equal(result.status, 200);
  assert.equal((await f.call('state', { board: f.id })).json.project.name, 'Old tab change');
  assert.notEqual((await f.call('state', { board: next.boardId })).json.project.name, 'Old tab change');
});

test('stale state saves are rejected instead of overwriting a new version', async () => {
  const f = await fixture();
  const stale = structuredClone(f.initial);
  const edited = structuredClone(f.initial); edited.project.name = 'Newer';
  assert.equal((await f.call('state', { method: 'PUT', board: f.id, body: edited })).status, 200);
  const response = await f.call('state', { method: 'PUT', board: f.id, body: stale });
  assert.equal(response.status, 409);
  assert.equal((await f.call('state', { board: f.id })).json.project.name, 'Newer');
});

test('legacy active files are recovery copies; inactive history never imports current root files', async () => {
  const f = await fixture();
  const dir = join(f.root, '.dsh/workbench');
  const old = host.emptyState(); old.version = 2;
  old.stageData.spec.confirmed = true; old.stageData.spec.confirmedAt = '2026-10-01';
  await writeFile(join(dir, 'boards/legacy-one.json'), JSON.stringify(old));
  await writeFile(join(dir, 'boards/legacy-two.json'), JSON.stringify(old));
  await writeFile(join(dir, 'boards.json'), JSON.stringify({ version: 1, activeId: 'legacy-two', boards: [
    { id: 'legacy-one', round: 1 }, { id: 'legacy-two', round: 2 },
  ] }));
  await writeFile(join(f.root, '需求分析阶段.md'), 'Current root text');
  const switched = await f.call('boards', { method: 'POST', body: { action: 'activate', id: 'legacy-one' } });
  assert.equal(switched.status, 200);
  const history = (await f.call('state', { board: 'legacy-one' })).json;
  assert.equal(history.stageData.spec.confirmed, false);
  assert.equal(history.stageData.spec.legacyConfirmation.confirmedAt, '2026-10-01');
  assert.equal((await f.call('file', { board: 'legacy-one', query: '?path=需求分析阶段.md&soft=1' })).json.missing, true);
  const active = (await f.call('file', { board: 'legacy-two', query: '?path=需求分析阶段.md' })).json;
  assert.equal(active.text, 'Current root text');
  assert.equal(await readFile(join(f.root, '需求分析阶段.md'), 'utf8'), 'Current root text');
});

test('managed storage rejects symlink escape and cross-board path traversal', async () => {
  const f = await fixture();
  await assert.rejects(documentPath(f.root, f.id, `${f.initial.artifactStorage.directory}/../other/documents/a.md`));
  const external = await mkdtemp(join(base, 'external-'));
  await symlink(external, join(f.root, f.initial.artifactStorage.directory, 'documents', 'linked'));
  await assert.rejects(managedPath(f.root, `${f.initial.artifactStorage.directory}/documents/linked/a.md`));
  assert.equal((await f.call('file', { board: f.id, query: '?path=.dsh/workbench/changes/another/documents/a.md' })).status, 400);
});

test('plugin registers authenticated artifacts route and includes new module in packaging', async () => {
  const registrations = [];
  const ctx = { inject: (_, fn) => fn({ get: () => undefined,
    connection: { requestRejection: () => 403 },
    effect: (fn) => fn(), webServer: { register: (route) => { registrations.push(route); } } }) };
  apply(ctx);
  assert.ok(registrations.some((route) => route.path === '/workbench/artifacts'));
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('artifacts.js'));
});

test('complete five-stage flow requires checklist and preserves all approved stages on save', async () => {
  const f = await fixture(); await f.fill();
  assert.equal((await f.confirm('spec')).status, 200);
  assert.equal((await f.confirm('design')).status, 200);
  assert.equal((await f.confirm('build')).status, 409);
  const current = (await f.call('state', { board: f.id })).json;
  for (const item of current.stageData.build.confirmations) item.done = true;
  assert.equal((await f.call('state', { board: f.id, method: 'PUT', body: current })).status, 200);
  for (const stage of ['build', 'verify', 'ship']) {
    const result = await f.confirm(stage);
    assert.equal(result.status, 200, JSON.stringify(result.json));
  }
  const completed = (await f.call('state', { board: f.id })).json;
  assert.ok(Object.values(completed.stageData).every((stage) => stage.confirmed));
  completed.project.goal = 'Saved after completion';
  const saved = (await f.call('state', { board: f.id, method: 'PUT', body: completed })).json;
  assert.ok(Object.values(saved.stageData).every((stage) => stage.confirmed));
});

test('concurrent saves are serialized and reject the stale writer', async () => {
  const f = await fixture();
  const a = structuredClone(f.initial); a.project.name = 'A';
  const b = structuredClone(f.initial); b.project.name = 'B';
  const results = await Promise.all([
    f.call('state', { board: f.id, method: 'PUT', body: a }),
    f.call('state', { board: f.id, method: 'PUT', body: b }),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), [200, 409]);
});


test('document review compares current text to a verified approved snapshot', async () => {
  const f = await fixture(); await f.fill();
  const approved = await f.confirm('spec');
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'), 'New requirement');
  const result = await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' });
  assert.equal(result.status, 200);
  assert.equal(result.json.baseline.approvalId, approved.json.approval.id);
  assert.ok(result.json.diff.added > 0 && result.json.diff.removed > 0);
  assert.equal(result.json.text, 'New requirement');
  const foreign = await f.call('review', { board: f.id, query: '?path=需求分析阶段.md&approval=not-an-approval' });
  assert.equal(foreign.status, 409);
});

test('first review shows the document as added and does not invent an approved baseline', async () => {
  const f = await fixture(); await f.fill();
  const result = await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' });
  assert.equal(result.json.baseline, null);
  assert.equal(result.json.diff.removed, 0);
  assert.equal(result.json.diff.added, 2);
});

test('paragraph comments retain exact quote/hash and block acceptance until resolved', async () => {
  const f = await fixture(); await f.fill();
  let data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  const body = { action: 'add', name: data.name, contentHash: data.contentHash,
    anchor: { startLine: 2, endLine: 2, quote: 'Original' }, text: 'Make the acceptance criterion measurable' };
  assert.equal((await f.call('review', { method: 'POST', board: f.id, body })).status, 200);
  assert.equal((await f.confirm('spec')).status, 409);
  data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  const comment = data.comments[0];
  assert.equal(comment.anchor.quote, 'Original'); assert.equal(comment.stale, false);
  assert.equal((await f.call('review', { method: 'POST', board: f.id,
    body: { action: 'resolve', id: comment.id, revision: comment.revision } })).status, 200);
  assert.equal((await f.confirm('spec')).status, 200);
  assert.equal((await f.call('review', { method: 'POST', board: f.id,
    body: { action: 'reopen', id: comment.id, revision: comment.revision } })).status, 409);
  assert.equal((await f.call('review', { method: 'POST', board: f.id,
    body: { action: 'reopen', id: comment.id, revision: 2 } })).status, 200);
  assert.equal((await f.confirm('spec')).status, 409);
});

test('stale anchors are labeled; new comments require the exact current version and line range', async () => {
  const f = await fixture(); await f.fill();
  let data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  const body = { action: 'add', name: data.name, contentHash: data.contentHash,
    anchor: { startLine: 2, endLine: 2, quote: 'Original' }, text: 'Please change this' };
  assert.equal((await f.call('review', { method: 'POST', board: f.id, body })).status, 200);
  assert.equal((await f.call('review', { method: 'POST', board: f.id,
    body: { ...body, anchor: { startLine: 2, endLine: 2, quote: 'Forged quote' } } })).status, 409);
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'), 'Updated');
  assert.equal((await f.call('review', { method: 'POST', board: f.id, body })).status, 409);
  data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  assert.equal(data.comments[0].stale, true);
  assert.equal(data.comments[0].anchor.quote, 'Original');
});

test('comments are isolated by board and binary/foreign documents cannot use the review API', async () => {
  const f = await fixture(); await f.fill();
  const data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  await f.call('review', { method: 'POST', board: f.id, body: { action: 'add', name: data.name,
    contentHash: data.contentHash, anchor: { startLine: 2, endLine: 2, quote: 'Original' }, text: 'Old board comment' } });
  const next = (await f.call('rounds', { method: 'POST' })).json; await f.fill(next.boardId);
  const nextData = (await f.call('review', { board: next.boardId, query: '?path=需求分析阶段.md' })).json;
  assert.equal(nextData.comments.length, 0);
  for (const path of ['需求分析阶段.docx', '../outside.md', '.dsh/workbench/changes/other/documents/需求分析阶段.md']) {
    assert.equal((await f.call('review', { board: f.id, query: '?path=' + encodeURIComponent(path) })).status, 409);
  }
});

test('diff handles unchanged documents, insertion, deletion, CRLF and repeated lines', () => {
  assert.equal(lineDiff('same', 'same').rows.length, 0);
  const insert = lineDiff('a\nb', 'a\nx\nb');
  assert.equal(insert.added, 1); assert.equal(insert.removed, 0);
  assert.equal(insert.rows.find((row) => row.kind === 'add').newLine, 2);
  assert.equal(lineDiff('x\na', 'a').removed, 1);
  assert.equal(lineDiff('a\r\nb', 'a\nb').added, 0);
  const repeated = lineDiff('a\na\nb', 'a\nb\na');
  assert.equal(repeated.added, 1); assert.equal(repeated.removed, 1);
});

test('large diffs are bounded and disclose simplified/truncated rendering', () => {
  const before = Array.from({ length: 2000 }, (_, i) => 'old ' + i).join('\n');
  const after = Array.from({ length: 2000 }, (_, i) => 'new ' + i).join('\n');
  const result = lineDiff(before, after);
  assert.equal(result.simplified, true); assert.equal(result.truncated, true);
  assert.equal(result.rows.length, 2500);
  assert.equal(result.added, 2000); assert.equal(result.removed, 2000);
});

test('tampered snapshots are rejected by document comparison', async () => {
  const f = await fixture(); await f.fill();
  const approved = await f.confirm('spec');
  const item = approved.json.approval.artifacts.find((item) => item.name === '需求分析阶段.md');
  await writeFile(join(f.root, item.snapshot), 'Tampered');
  const result = await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' });
  assert.equal(result.status, 409); assert.match(result.json.message, /校验失败/);
});


test('adding a comment after approval invalidates that stage and downstream approvals', async () => {
  const f = await fixture(); await f.fill(); await f.confirm('spec'); await f.confirm('design');
  const data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  await f.call('review', { method: 'POST', board: f.id, body: { action: 'add', name: data.name,
    contentHash: data.contentHash, anchor: { startLine: 2, endLine: 2, quote: 'Original' }, text: 'Please revisit this decision' } });
  const state = (await f.call('state', { board: f.id })).json;
  assert.equal(state.stageData.spec.confirmed, false); assert.equal(state.stageData.design.confirmed, false);
  assert.equal(state.stageData.spec.needsReview, true);
});

test('comment creation racing with confirmation cannot leave an approved stage with an open comment', async () => {
  const f = await fixture(); await f.fill();
  const hashes = (await f.call('artifacts', { board: f.id })).json.stages.spec.hashes;
  const data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  await Promise.all([
    f.call('artifacts', { method: 'POST', board: f.id, body: { action: 'confirm', stage: 'spec', hashes } }),
    f.call('review', { method: 'POST', board: f.id, body: { action: 'add', name: data.name,
      contentHash: data.contentHash, anchor: { startLine: 2, endLine: 2, quote: 'Original' }, text: 'Concurrent review' } }),
  ]);
  assert.equal((await f.call('state', { board: f.id })).json.stageData.spec.confirmed, false);
});

test('line-ending-only edits remain visible as byte changes in review', async () => {
  const f = await fixture(); await f.fill(); await f.confirm('spec');
  const file = join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace(/\n/g, '\r\n'));
  const data = (await f.call('review', { board: f.id, query: '?path=需求分析阶段.md' })).json;
  assert.equal(data.diff.added, 0); assert.equal(data.diff.removed, 0); assert.equal(data.diff.formatOnly, true);
});

async function seedKnowledge(f) {
  const docs = {
    '需求分析阶段.md': '# 需求\n\n### FR-001 登录\n用户可以登录。\n\n### AC-001 登录验收\n对应 FR-001，合法凭证可以进入主页。\n\n### FR-002 导出\n用户可以导出文件。',
    '产品实现设计文档.md': '# 设计\n\n### ADR-001 会话存储\n为 FR-001 和 AC-001 采用服务端会话。',
    '实现交接.md': '# 实现\n\n### TASK-001 登录处理\n实现 ADR-001，满足 AC-001。',
    '测试案例.md': '# 用例\n\n### TC-001 正常登录\n验证 AC-001。',
    '测试结果.md': '# 测试结果\n\n### EV-001 登录测试证据\n对应 TC-001 和 AC-001\n命令：npm test\n结果：通过\n代码版本：abc123',
  };
  await f.fill();
  for (const [name, body] of Object.entries(docs)) await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents', name), body);
}

async function mutateKnowledge(f, action) {
  const current = (await f.call('knowledge', { board: f.id })).json;
  return f.call('knowledge', { board: f.id, method: 'POST', body: { ...action, revision: current.revision } });
}

test('knowledge derives typed nodes, references, evidence and actionable gaps from canonical documents', async () => {
  const f = await fixture(); await seedKnowledge(f);
  const result = await f.call('knowledge', { board: f.id });
  assert.equal(result.status, 200);
  assert.equal(result.json.nodes.length, 7);
  assert.ok(result.json.links.some((edge) => edge.from === 'FR-001' && edge.to === 'AC-001'));
  assert.ok(result.json.links.some((edge) => edge.from === 'TC-001' && edge.to === 'EV-001'));
  const evidence = result.json.nodes.find((node) => node.id === 'EV-001');
  assert.equal(evidence.evidence.outcome, 'passed'); assert.equal(evidence.evidence.command, 'npm test');
  assert.ok(result.json.issues.some((issue) => issue.kind === 'missing-acceptance' && issue.id === 'FR-002'));
  assert.equal(result.json.nodes.find((node) => node.id === 'FR-001').status, 'draft');
});

test('confirmed source records become accepted and revert to draft after source changes', async () => {
  const f = await fixture(); await seedKnowledge(f); await f.confirm('spec');
  let data = (await f.call('knowledge', { board: f.id })).json;
  const old = data.nodes.find((node) => node.id === 'FR-001');
  assert.equal(old.status, 'accepted'); assert.ok(old.source.snapshot);
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'), '### FR-001 登录变更\n范围已修改。');
  data = (await f.call('knowledge', { board: f.id })).json;
  const changed = data.nodes.find((node) => node.id === 'FR-001');
  assert.equal(changed.status, 'draft'); assert.equal(changed.stale, true);
  assert.notEqual(changed.source.contentHash, old.source.contentHash);
});

test('knowledge search matches IDs, Chinese body text and full reference source text', async () => {
  const f = await fixture(); await seedKnowledge(f);
  let data = (await f.call('knowledge', { board: f.id, query: '?q=FR-001' })).json;
  assert.equal(data.nodes[0].id, 'FR-001');
  data = (await f.call('knowledge', { board: f.id, query: '?q=合法凭证&type=AC' })).json;
  assert.equal(data.nodes.length, 1); assert.equal(data.nodes[0].id, 'AC-001');
  assert.ok(data.sourceMatches.some((source) => source.name === '需求分析阶段.md'));
});

test('manual knowledge edits are versioned; stale writes and source-owned edits are rejected', async () => {
  const f = await fixture(); await seedKnowledge(f);
  const node = { id: 'ADR-002', type: 'ADR', title: '部署约束', body: '保持单机部署', refs: ['FR-002'], status: 'accepted' };
  assert.equal((await mutateKnowledge(f, { action: 'upsert', node })).status, 200);
  let data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.nodes.find((n) => n.id === 'ADR-002').revision, 1);
  assert.equal((await f.call('knowledge', { board: f.id, method: 'POST', body: { action: 'upsert', node, revision: 0 } })).status, 409);
  assert.equal((await mutateKnowledge(f, { action: 'upsert', node: { ...node, id: 'ADR-001' } })).status, 409);
  assert.equal((await mutateKnowledge(f, { action: 'upsert', node: { ...node, body: '修改约束' } })).status, 200);
  data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.nodes.find((n) => n.id === 'ADR-002').revision, 2);
});

test('manual links support removal and deprecated records do not close coverage gaps', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await mutateKnowledge(f, { action: 'link', from: 'FR-002', to: 'AC-001', relation: 'satisfies' });
  let data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.issues.some((i) => i.kind === 'missing-acceptance' && i.id === 'FR-002'), false);
  const link = data.links.find((edge) => edge.from === 'FR-002' && edge.origin === 'manual');
  await mutateKnowledge(f, { action: 'unlink', id: link.id });
  data = (await f.call('knowledge', { board: f.id })).json;
  assert.ok(data.issues.some((i) => i.kind === 'missing-acceptance' && i.id === 'FR-002'));
  await mutateKnowledge(f, { action: 'deprecate', id: 'AC-001' });
  data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.nodes.find((n) => n.id === 'AC-001').status, 'deprecated');
  assert.ok(data.issues.some((i) => i.kind === 'missing-acceptance' && i.id === 'FR-001'));
});

test('draft references default excluded, explicit inclusion is labeled and source changes revoke acceptance', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await mkdir(join(f.root, 'docs')); await writeFile(join(f.root, 'docs/rules.md'), '规则：保留审计日志。');
  await mutateKnowledge(f, { action: 'reference', path: 'docs/rules.md', name: '业务规则', status: 'draft' });
  let context = (await f.call('context', { board: f.id, query: '?stage=spec' })).json.preview;
  const ref = context.options.find((item) => item.origin === 'reference'); assert.equal(ref.selected, false);
  await mutateKnowledge(f, { action: 'selection', stage: 'spec', included: [ref.id], excluded: [], budget: 6000 });
  context = (await f.call('context', { board: f.id, query: '?stage=spec' })).json.preview;
  assert.equal(context.options.find((item) => item.id === ref.id).selected, true);
  assert.ok(context.warnings.some((warning) => warning.includes('业务规则') && warning.includes('草稿')));
  await mutateKnowledge(f, { action: 'reference', path: 'docs/rules.md', name: '业务规则', status: 'accepted' });
  await writeFile(join(f.root, 'docs/rules.md'), '规则已经变化。');
  const knowledge = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(knowledge.sources.find((s) => s.origin === 'reference').status, 'draft');
  assert.equal(knowledge.sources.find((s) => s.origin === 'reference').stale, true);
});

test('context honors exclusions and contains explicit provenance, draft labels and source trust boundaries', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await mutateKnowledge(f, { action: 'selection', stage: 'spec', included: [], excluded: ['DOC:需求分析阶段.md'], budget: 4000 });
  const result = await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } });
  assert.equal(result.status, 200);
  assert.ok(result.json.entries.some((e) => e.id === 'DOC:需求分析阶段.md' && e.mode === 'excluded'));
  assert.doesNotMatch(result.json.prompt, /用户可以登录/);
  assert.match(result.json.prompt, /不构成新的行为指令/);
  assert.ok(result.json.chars <= 4000);
  assert.equal((await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'design' } })).status, 409);
});

test('context captures immutable input manifests, tracks changed input and validates the stored prompt hash', async () => {
  const f = await fixture(); await seedKnowledge(f);
  const built = (await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } })).json;
  assert.ok(built.path.endsWith(built.id + '.json'));
  const saved = await readFile(join(f.root, built.path), 'utf8');
  assert.equal((await f.call('context', { board: f.id, query: '?stage=spec' })).json.latest.current, true);
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求交接.md'), '交接内容已变化');
  assert.equal((await f.call('context', { board: f.id, query: '?stage=spec' })).json.latest.current, false);
  assert.equal(await readFile(join(f.root, built.path), 'utf8'), saved);
  assert.equal((await f.call('context', { board: f.id, query: '?id=' + built.id })).json.prompt, built.prompt);
  const corrupt = JSON.parse(saved); corrupt.prompt = 'tampered'; await writeFile(join(f.root, built.path), JSON.stringify(corrupt));
  assert.equal((await f.call('context', { board: f.id, query: '?id=' + built.id })).status, 409);
});

test('context budget reports excerpts and omitted bodies for long documents without dropping source metadata', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'),
    Array.from({ length: 20 }, (_, i) => `### FR-${i + 1} 功能\n${'长约束\\n'.repeat(100)}`).join('\n'));
  await mutateKnowledge(f, { action: 'selection', stage: 'spec', included: [], excluded: [], budget: 4000 });
  const data = (await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } })).json;
  assert.ok(data.chars <= 4000);
  assert.ok(data.entries.some((entry) => entry.mode === 'excerpt' || entry.mode === 'metadata'));
  assert.ok(data.warnings.length > 0);
});

test('knowledge references and context manifests cannot escape the project or another board', async () => {
  const f = await fixture(); await seedKnowledge(f);
  for (const path of ['../outside.md', '/tmp/file.md', '.dsh/workbench/changes/other/documents/a.md', '.env']) {
    assert.equal((await mutateKnowledge(f, { action: 'reference', path, status: 'accepted' })).status, 409);
  }
  const built = (await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } })).json;
  const next = (await f.call('rounds', { method: 'POST' })).json;
  assert.equal((await f.call('context', { board: next.boardId, query: '?id=' + built.id })).status, 409);
  assert.equal((await f.call('knowledge', { board: next.boardId })).json.nodes.length, 0);
});


test('knowledge extraction ignores fenced examples and plain mentions while reporting duplicate definitions', async () => {
  const f = await fixture(); await f.fill();
  const text = '# 需求\n普通文字提及 FR-999 不创建条目。\n\n```md\n### FR-EXAMPLE 示例\n```\n\n### FR-001 登录\n实际需求。\n\n### FR-001 重复编号\n应当报告冲突。';
  const nodes = extractDefinitions(text, { id: 'doc', path: 'source', contentHash: 'hash', status: 'draft' }, ['FR']);
  assert.equal(nodes.length, 2); assert.equal(nodes[0].id, 'FR-001');
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md'), text);
  const data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.nodes.length, 1); assert.ok(data.issues.some((issue) => issue.kind === 'duplicate-id'));
});

test('unknown evidence outcomes are kept unknown rather than inferred from narrative', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await writeFile(join(f.root, f.initial.artifactStorage.directory, 'documents/测试结果.md'), '### EV-001 待验证\n计划验证 AC-001，预计通过，但尚未执行。');
  const data = (await f.call('knowledge', { board: f.id })).json;
  assert.equal(data.nodes.find((node) => node.id === 'EV-001').evidence.outcome, 'unknown');
  assert.ok(data.issues.some((issue) => issue.kind === 'incomplete-evidence'));
});


test('deprecated source records are redacted from whole-document context and cannot re-enter through excerpts', async () => {
  const f = await fixture(); await seedKnowledge(f);
  const path = join(f.root, f.initial.artifactStorage.directory, 'documents/需求分析阶段.md');
  await writeFile(path, (await readFile(path, 'utf8')).replace('用户可以登录。', 'DEPRECATED_ONLY_CONTENT'));
  await mutateKnowledge(f, { action: 'deprecate', id: 'FR-001' });
  const data = (await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } })).json;
  assert.equal(data.deprecatedIds.includes('FR-001'), true);
  assert.doesNotMatch(data.prompt, /DEPRECATED_ONLY_CONTENT/);
  assert.ok(data.entries.some((entry) => entry.id === 'DOC:需求分析阶段.md' && entry.redacted));
});

test('actual context captures relationships among selected knowledge records', async () => {
  const f = await fixture(); await seedKnowledge(f);
  const data = (await f.call('context', { board: f.id, method: 'POST', body: { action: 'build', stage: 'spec' } })).json;
  assert.ok(data.relationships.some((edge) => edge.from === 'FR-001' && edge.to === 'AC-001'));
  assert.ok(data.entries.some((entry) => entry.id === 'RELATIONS'));
  assert.match(data.prompt, /关联编号/);
});

test('previously selected references require renewed selection when their content changes', async () => {
  const f = await fixture(); await seedKnowledge(f);
  await writeFile(join(f.root, 'rules.md'), '原始参考规则');
  await mutateKnowledge(f, { action: 'reference', path: 'rules.md', status: 'accepted' });
  let preview = (await f.call('context', { board: f.id, query: '?stage=spec' })).json.preview;
  const reference = preview.options.find((option) => option.origin === 'reference');
  await mutateKnowledge(f, { action: 'selection', stage: 'spec', included: [reference.id], excluded: [], budget: 8000 });
  await writeFile(join(f.root, 'rules.md'), '已经修改的参考规则');
  preview = (await f.call('context', { board: f.id, query: '?stage=spec' })).json.preview;
  assert.equal(preview.options.find((option) => option.id === reference.id).selected, false);
  assert.match(preview.options.find((option) => option.id === reference.id).reason, /来源已更新/);
  await mutateKnowledge(f, { action: 'selection', stage: 'spec', included: [reference.id], excluded: [], budget: 8000 });
  preview = (await f.call('context', { board: f.id, query: '?stage=spec' })).json.preview;
  assert.equal(preview.options.find((option) => option.id === reference.id).selected, true);
  assert.equal(preview.options.find((option) => option.id === reference.id).status, 'draft');
});


test('queue summaries use requirement titles and actual pending stage with session details',async()=>{
 const f=await fixture(); const edited=structuredClone(f.initial);
 edited.project.name='知识文档筛选';edited.project.goal='按标题和分类查找';
 edited.stage='ship';edited.stageData.spec.startedAt='2026-11-12T00:00:00Z';edited.stageSessions.spec='source-session';
 assert.equal((await f.call('state',{method:'PUT',body:edited})).status,200);
 const roster=await f.call('boards'); const row=roster.json.boards.find(item=>item.id===f.id);
 assert.equal(row.name,'知识文档筛选');assert.equal(row.stage,'spec');
 assert.equal(row.goal,'按标题和分类查找');assert.equal(row.stages.spec.sessionId,'source-session');
 assert.equal(row.stageStarted,true);assert.equal(row.confirmed,0);
});
