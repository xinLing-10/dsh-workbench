import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { boardDirectory, DOCUMENTS, managedPath, atomicJson, listApprovalHistory } from './artifacts.js';

const TEXT_LIMIT = 2 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function stageFor(name) {
  const stage = Object.keys(DOCUMENTS).find((key) => DOCUMENTS[key].includes(name));
  if (!stage || !/\.(md|txt|markdown)$/i.test(name)) throw new Error('此文档暂不支持段落审阅，请下载原文件');
  return stage;
}

async function textFile(root, path, expectedHash) {
  const bytes = await readFile(await managedPath(root, path));
  if (bytes.length > TEXT_LIMIT) throw new Error('文档过大，请下载后审阅');
  const contentHash = digest(bytes);
  if (expectedHash && expectedHash !== contentHash) throw new Error('确认快照校验失败');
  const text = bytes.toString('utf8');
  if (text.split('\n').length > 20000) throw new Error('文档行数过多，请下载后审阅');
  return { text, contentHash };
}

async function reviewStore(root, id) {
  const file = await managedPath(root, `${boardDirectory(id)}/reviews.json`);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, comments: [] }; throw error; }
}

const linesOf = (text) => text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');

/** Bounded line diff: trim common edges; large edits fall back to an explicit replacement. */
export function lineDiff(before, after) {
  const a = linesOf(before), b = linesOf(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const left = a.slice(prefix, a.length - suffix), right = b.slice(prefix, b.length - suffix);
  const operations = [];
  for (let i = 0; i < prefix; i++) operations.push({ kind: 'same', text: a[i] });
  const simplified = left.length * right.length > 1_000_000;
  if (simplified) {
    for (const text of left) operations.push({ kind: 'remove', text });
    for (const text of right) operations.push({ kind: 'add', text });
  } else {
    const width = right.length + 1;
    const lcs = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
      lcs[i * width + j] = left[i] === right[j] ? 1 + lcs[(i + 1) * width + j + 1]
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) {
        operations.push({ kind: 'same', text: left[i++] }); j++;
      } else if (i < left.length && (j === right.length || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
        operations.push({ kind: 'remove', text: left[i++] });
      } else operations.push({ kind: 'add', text: right[j++] });
    }
  }
  for (let i = a.length - suffix; i < a.length; i++) operations.push({ kind: 'same', text: a[i] });
  let oldLine = 0, newLine = 0, added = 0, removed = 0;
  for (const row of operations) {
    row.oldLine = row.kind === 'add' ? null : ++oldLine;
    row.newLine = row.kind === 'remove' ? null : ++newLine;
    if (row.kind === 'add') added++;
    if (row.kind === 'remove') removed++;
  }
  // Keep three context lines around each edit and collapse the rest.
  const visible = new Set();
  for (let i = 0; i < operations.length; i++) if (operations[i].kind !== 'same') {
    for (let j = Math.max(0, i - 3); j <= Math.min(operations.length - 1, i + 3); j++) visible.add(j);
  }
  const rows = []; let omitted = 0;
  for (let i = 0; i < operations.length; i++) {
    if (!visible.has(i)) { omitted++; continue; }
    if (omitted) { rows.push({ kind: 'skip', count: omitted }); omitted = 0; }
    rows.push(operations[i]);
  }
  if (omitted && (added || removed)) rows.push({ kind: 'skip', count: omitted });
  return { rows: rows.slice(0, 2500), added, removed, simplified, truncated: rows.length > 2500 };
}

export async function documentReview(root, id, name, approvalId = '') {
  const stage = stageFor(name);
  const current = await textFile(root, `${boardDirectory(id)}/documents/${name}`);
  const history = (await listApprovalHistory(root, id)).filter((entry) =>
    entry.stage === stage && entry.artifacts.some((item) => item.name === name));
  const approval = approvalId ? history.find((entry) => entry.id === approvalId) : history[0];
  if (approvalId && !approval) throw new Error('确认版本不存在或不属于此文档');
  const artifact = approval?.artifacts.find((item) => item.name === name);
  const baseline = artifact ? await textFile(root, artifact.snapshot, artifact.contentHash) : { text: '', contentHash: null };
  const store = await reviewStore(root, id);
  return {
    boardId: id, name, stage, ...current,
    baseline: artifact ? { approvalId: approval.id, revision: artifact.revision, contentHash: artifact.contentHash,
      confirmedAt: approval.confirmedAt } : null,
    versions: history.map((entry) => ({ approvalId: entry.id, confirmedAt: entry.confirmedAt,
      revision: entry.artifacts.find((item) => item.name === name).revision })),
    diff: { ...lineDiff(baseline.text, current.text),
      formatOnly: Boolean(artifact && baseline.contentHash !== current.contentHash && baseline.text.replace(/\r\n/g, '\n') === current.text.replace(/\r\n/g, '\n')) },
    comments: store.comments.filter((item) => item.name === name).map((item) =>
      ({ ...item, stale: item.contentHash !== current.contentHash })),
  };
}

export async function updateComment(root, id, body) {
  const store = await reviewStore(root, id);
  const now = new Date().toISOString();
  let updated;
  if (body.action === 'add') {
    const stage = stageFor(body.name);
    const current = await textFile(root, `${boardDirectory(id)}/documents/${body.name}`);
    if (current.contentHash !== body.contentHash) throw new Error('文档已更新，请重新选择当前段落后评论；草稿已保留');
    const { startLine, endLine, quote } = body.anchor || {};
    const lines = linesOf(current.text);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 ||
      endLine < startLine || endLine > lines.length || endLine - startLine > 300 ||
      typeof quote !== 'string' || quote.length > 12000 ||
      lines.slice(startLine - 1, endLine).join('\n') !== quote) throw new Error('评论段落与文档不一致');
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 4000) throw new Error('评论需为 1–4000 字符');
    if (store.comments.length >= 2000) throw new Error('本轮评论已达上限，请另开需求轮次');
    const comment = { id: randomUUID(), name: body.name, stage, boardId: id,
      contentHash: current.contentHash, anchor: { startLine, endLine, quote }, text,
      status: 'open', revision: 1, createdAt: now, updatedAt: now };
    store.comments.push(comment);
    updated = comment;
  } else if (body.action === 'resolve' || body.action === 'reopen') {
    const comment = store.comments.find((item) => item.id === body.id);
    if (!comment) throw new Error('评论不存在');
    if (comment.revision !== body.revision) throw new Error('评论已被更新，请刷新后重试');
    comment.status = body.action === 'resolve' ? 'resolved' : 'open';
    comment.updatedAt = now;
    comment.revision++;
    updated = comment;
  } else throw new Error('未知评论操作');
  await atomicJson(await managedPath(root, `${boardDirectory(id)}/reviews.json`), store);
  return updated;
}

export async function assertStageReviewed(root, id, stage) {
  const store = await reviewStore(root, id);
  const count = store.comments.filter((item) => item.stage === stage && item.status === 'open').length;
  if (count) throw new Error(`本阶段还有 ${count} 条未解决评论，请先处理或标记已解决`);
}
