import { assertDocumentHashes } from './document-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const STAGES = ['spec', 'design', 'build', 'verify', 'ship'];
export const DOCUMENTS = {
  spec: ['需求分析阶段.md', '需求分析阶段.docx', '需求交接.md', '现状基线.md'],
  design: ['产品实现设计文档.md', '设计交接.md'],
  build: ['启动文档.md', '部署文档.md', '实现交接.md'],
  verify: ['测试案例.md', '测试结果.md', '验收交接.md'],
  ship: ['交付清单.md'],
};
export const DOCUMENT_NAMES = new Set(Object.values(DOCUMENTS).flat());
const REQUIRED = {
  spec: ['需求分析阶段.md', '需求分析阶段.docx', '需求交接.md'],
  design: DOCUMENTS.design,
  build: DOCUMENTS.build,
  verify: DOCUMENTS.verify,
  ship: DOCUMENTS.ship,
};
const LIMIT = 64 * 1024 * 1024;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function boardDirectory(id) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('invalid board id');
  return `.dsh/workbench/changes/${id}`;
}

// Refuse existing symlink ancestors for managed data, including snapshot reads.
export async function managedPath(root, relative) {
  const target = resolve(root, relative);
  const base = await realpath(root);
  if (!target.startsWith(resolve(root) + sep)) throw new Error('managed path escapes project');
  let cursor = resolve(root);
  for (const part of target.slice(cursor.length + 1).split(sep)) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('managed paths cannot contain symlinks');
    if (info) {
      const actual = await realpath(cursor);
      if (actual !== base && !actual.startsWith(base + sep)) throw new Error('managed path escapes project');
    }
  }
  return target;
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file);
}

async function documentBytes(root, id, name) {
  const file = await managedPath(root, `${boardDirectory(id)}/documents/${name}`);
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isFile() || info.size > LIMIT) throw new Error(`invalid or oversized artifact: ${name}`);
  return readFile(file);
}

async function loadManifest(root, id) {
  const file = await managedPath(root, `${boardDirectory(id)}/artifacts.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, artifacts: {}, approvals: {} };
    throw error;
  }
}

async function saveManifest(root, id, manifest) {
  await atomicJson(await managedPath(root, `${boardDirectory(id)}/artifacts.json`), manifest);
}

/** A legacy import is a recovery copy, never proof of the old approval. */
export async function initializeArtifacts(root, id, state, { legacy = false, importRoot = false } = {}) {
  const directory = boardDirectory(id);
  if (state.artifactStorage?.version === 1) return false;
  await mkdir(await managedPath(root, `${directory}/documents`), { recursive: true });
  await mkdir(await managedPath(root, `${directory}/snapshots`), { recursive: true });
  await mkdir(await managedPath(root, `${directory}/approvals`), { recursive: true });
  const imported = [];
  if (legacy && importRoot) {
    for (const name of DOCUMENT_NAMES) {
      const source = await managedPath(root, name);
      const info = await lstat(source).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isFile() || info.size > LIMIT) continue;
      const target = await managedPath(root, `${directory}/documents/${name}`);
      await writeFile(target, await readFile(source), { flag: 'wx' }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      imported.push(name);
    }
  }
  state.artifactStorage = {
    version: 1, directory, migratedAt: new Date().toISOString(),
    legacy, imported,
    warning: legacy ? (importRoot
      ? '旧根目录文档已复制为待核对资料；旧确认未绑定版本，请重新审阅。'
      : '此历史轮次没有可靠的独立文档版本；未从当前根目录推断历史内容，请核对后补充。') : '',
  };
  for (const stage of STAGES) {
    const data = state.stageData[stage];
    if (data.confirmed) {
      data.legacyConfirmation = { confirmedAt: data.confirmedAt || '', reviewNote: data.reviewNote || '' };
      data.confirmed = false;
      data.confirmedAt = '';
      data.needsReview = true;
    }
  }
  return true;
}

export async function documentPath(root, id, requested) {
  // Bare legacy names are aliases within this board, never root fallbacks.
  const path = DOCUMENT_NAMES.has(requested)
    ? `${boardDirectory(id)}/documents/${requested}` : requested;
  if (path.startsWith('.dsh/workbench/')) {
    if (!path.startsWith(boardDirectory(id) + '/')) throw new Error('artifact belongs to another board');
    const target = resolve(root, path);
    if (!target.startsWith(resolve(root, boardDirectory(id)) + sep)) throw new Error('artifact belongs to another board');
    return managedPath(root, path);
  }
  return null;
}

export async function currentHashes(root, id, stage, flow) {
  const names = DOCUMENTS[stage].filter((name) => name !== '现状基线.md' || flow === 'incremental');
  const files = {};
  for (const name of names) {
    const bytes = await documentBytes(root, id, name);
    files[name] = bytes === null ? null : hash(bytes);
  }
  return files;
}

function invalidate(state, start) {
  for (const stage of STAGES.slice(start)) {
    const data = state.stageData[stage];
    if (data.confirmed || data.approvalId) data.needsReview = true;
    data.confirmed = false;
    data.confirmedAt = '';
  }
}

/** Recheck approved hashes; keep old receipts when a document changes/disappears. */
export async function reconcileArtifacts(root, id, state) {
  const manifest = await loadManifest(root, id);
  const before = JSON.stringify(state.stageData);
  for (let index = 0; index < STAGES.length; index++) {
    const stage = STAGES[index];
    if (!state.stageData[stage].confirmed) continue;
    const approval = manifest.approvals[stage];
    const files = await currentHashes(root, id, stage, state.flow);
    if (!approval || state.stageData[stage].approvalId !== approval.id ||
        JSON.stringify(files) !== JSON.stringify(approval.hashes)) invalidate(state, index);
  }
  return before !== JSON.stringify(state.stageData);
}

export async function artifactReview(root, id, state) {
  const manifest = await loadManifest(root, id);
  const stages = {};
  for (const stage of STAGES) {
    stages[stage] = { hashes: await currentHashes(root, id, stage, state.flow),
      approval: manifest.approvals[stage] || null };
  }
  return { boardId: id, storage: state.artifactStorage, stages };
}

export async function confirmArtifacts(root, id, state, stage, expectedHashes, note) {
  if (!STAGES.includes(stage)) throw new Error('invalid stage');
  const index = STAGES.indexOf(stage);
  if (STAGES.slice(0, index).some((key) => !state.stageData[key].confirmed)) {
    throw new Error('请先确认前序阶段的当前版本');
  }
  if (stage === 'build' && state.stageData.build.confirmations.some((item) => !item.done)) {
    throw new Error('请先完成实现检查清单');
  }
  const files = await currentHashes(root, id, stage, state.flow);
  const required = [...REQUIRED[stage], ...(stage === 'spec' && state.flow === 'incremental' ? ['现状基线.md'] : [])];
  for (const name of required) if (!files[name]) throw new Error(`缺少本轮产出：${name}`);
  assertDocumentHashes(files, expectedHashes);
  const manifest = await loadManifest(root, id);
  const artifacts = [];
  for (const [name, contentHash] of Object.entries(files)) {
    if (!contentHash) continue;
    const bytes = await documentBytes(root, id, name);
    if (!bytes || hash(bytes) !== contentHash) throw new Error('文档正在写入，请稍后重新审阅');
    const old = manifest.artifacts[name];
    const revision = old?.contentHash === contentHash ? old.revision : (old?.revision || 0) + 1;
    const snapshot = `${boardDirectory(id)}/snapshots/${contentHash}`;
    const snapshotFile = await managedPath(root, snapshot);
    await writeFile(snapshotFile, bytes, { flag: 'wx' }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      if (hash(await readFile(snapshotFile)) !== contentHash) throw new Error('snapshot integrity failure');
    });
    const artifact = { artifactId: `${id}:${name}`, name, revision, contentHash, snapshot };
    artifacts.push(artifact);
    manifest.artifacts[name] = artifact;
  }
  const latest = await currentHashes(root, id, stage, state.flow);
  if (JSON.stringify(latest) !== JSON.stringify(files)) throw new Error('文档正在写入，请稍后重新审阅');
  const approval = { id: randomUUID(), boardId: id, stage, confirmedAt: new Date().toISOString(),
    actor: 'workbench-user', note: String(note || '').slice(0, 2000), hashes: files, artifacts };
  const receipt = await managedPath(root, `${boardDirectory(id)}/approvals/${approval.id}.json`);
  await writeFile(receipt, JSON.stringify(approval, null, 2) + '\n', { flag: 'wx' });
  manifest.approvals[stage] = approval;
  await saveManifest(root, id, manifest);
  Object.assign(state.stageData[stage], { confirmed: true, confirmedAt: approval.confirmedAt,
    approvalId: approval.id, needsReview: false, reviewNote: approval.note });
  if (index < STAGES.length - 1) state.stage = STAGES[index + 1];
  return approval;
}

export async function listApprovalHistory(root, id) {
  const directory = await managedPath(root, `${boardDirectory(id)}/approvals`);
  const entries = await readdir(directory);
  const approvals = [];
  for (const name of entries.filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
    approvals.push(JSON.parse(await readFile(await managedPath(root, `${boardDirectory(id)}/approvals/${name}`), 'utf8')));
  }
  return approvals.sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
}
