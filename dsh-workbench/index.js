import { executionPolicy } from './execution-policy.js';
import { knowledgeView, updateKnowledge, contextView, buildContext, readContext } from './knowledge.js';
import { documentReview, updateComment, assertStageReviewed } from './reviews.js';
import { boardDirectory, DOCUMENT_NAMES, initializeArtifacts, documentPath, reconcileArtifacts, artifactReview, confirmArtifacts, listApprovalHistory, managedPath, atomicJson } from './artifacts.js';
/**
 * Host half of the product-development Workbench.
 *
 * The browser half cannot touch the filesystem, so this file owns the small,
 * explicitly bounded set of operations the Workbench needs:
 *
 *   GET/PUT /workbench/state    project-scoped JSON state (`<project>/.dsh/workbench.json`)
 *   GET     /workbench/requirements  the cross-project requirement archive
 *   GET     /workbench/library  documents the project root currently holds
 *   GET     /workbench/file     text preview of a project document (DOCX included)
 *   GET     /workbench/raw      original bytes (PDF/DOCX/image) for preview or download
 *   POST    /workbench/upload   save a pasted requirement file and extract its text
 *   POST    /workbench/docx     turn a Markdown deliverable into a real .docx
 *   POST    /workbench/probe    check whether a local preview URL is reachable
 *
 * Every path is resolved below the project root; a request can never aim these
 * operations at an arbitrary host file. Upload and preview bodies are
 * size-capped. Deployment credentials are deliberately not accepted or stored
 * here.
 */
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** Exact routes contributed by this plugin. */
const ROUTES = {
  state: '/workbench/state',
  artifacts: '/workbench/artifacts',
  review: '/workbench/review',
  knowledge: '/workbench/knowledge',
  context: '/workbench/context',
  boards: '/workbench/boards',
  rounds: '/workbench/rounds',
  requirements: '/workbench/requirements',
  library: '/workbench/library',
  file: '/workbench/file',
  raw: '/workbench/raw',
  upload: '/workbench/upload',
  docx: '/workbench/docx',
  probe: '/workbench/probe',
};

/** Stage keys the state file may name. */
const STAGES = ['spec', 'design', 'build', 'verify', 'ship'];

/** The only deployment modes this UI records. */
const DEPLOY_MODES = ['none', 'ssh'];

const MAX_STATE_BYTES = 256 * 1024;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_LIBRARY_FILES = 200;

/** Files the document library lists from the project root. */
const LIBRARY_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.docx', '.pdf', '.txt']);

/** Original-byte response types; anything else is served as an opaque download. */
const RAW_CONTENT_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.mdx': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** Text extensions the preview route will return as UTF-8. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.sh',
  '.zsh',
  '.sql',
]);

/** Local hostnames the preview probe is allowed to touch. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/** Common local development ports tried by auto-detection. */
const COMMON_PORTS = [5173, 3000, 4173, 8080, 8000, 5000, 4200];

/**
 * Default state. Kept in lockstep with the Client's `emptyState`; the Host is
 * the final validator, so unknown fields never reach disk.
 * @returns a fresh state object.
 */
function emptyState() {
  return {
    version: 3,
    project: { name: '', goal: '', createdAt: '' },
    flow: 'new',
    round: 1,
    stage: STAGES[0],
    sessionId: '',
    specSessionId: '',
    stageSessions: { spec: '', design: '', build: '', verify: '', ship: '' },
    previewUrl: '',
    stageData: {
      spec: {
        input: '',
        sourceName: '',
        sourcePath: '',
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      design: {
        mode: 'preset',
        preset: 'agent',
        gates: [
          { id: 'gate-1', text: '核心数据结构：字段、约束与索引', enabled: true },
          { id: 'gate-2', text: '关键接口：入参、出参与错误码', enabled: true },
          { id: 'gate-3', text: '关键交互流程：正常路径 + 空态/加载/错误', enabled: true },
          { id: 'gate-4', text: '权限与角色判断的位置', enabled: true },
          { id: 'gate-5', text: '数据迁移与向后兼容（如涉及）', enabled: true },
        ],
        frontend: '',
        backend: '',
        database: '',
        deployTarget: '',
        constraints: '',
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      build: {
        confirmations: [
          { id: 'default-1', text: '核心数据流与模块接口已核对', done: false },
          { id: 'default-2', text: '关键交互流程已在项目预览中走通', done: false },
          { id: 'default-3', text: '启动文档 / 部署文档与实际一致', done: false },
        ],
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
      verify: {
        startedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
        fixRounds: 0,
      },
      ship: {
        mode: 'none',
        host: '',
        port: '',
        user: '',
        path: '',
        method: 'rsync',
        deployRequested: false,
        deployStartedAt: '',
        confirmed: false,
        confirmedAt: '',
        reviewNote: '',
      },
    },
    activity: [],
    updatedAt: '',
  };
}

/** @returns whether value is a plain object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @returns a string when value is a string, otherwise the fallback. */
function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/** @returns a boolean when value is a boolean, otherwise false. */
function bool(value) {
  return value === true;
}

/** @returns a finite integer when value is a safe non-negative number. */
function nonNegativeInt(value, fallback = 0) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Coerce a persisted or submitted state into the exact current shape.
 * Unknown keys are dropped, which keeps a hand-edited state file from
 * smuggling new fields into the Client.
 * @param raw - parsed JSON of unknown provenance.
 * @returns a clean state.
 */
function sanitizeState(raw) {
  const base = emptyState();
  if (!isRecord(raw)) return base;

  // Version 1 was a stage/checks-only board. Preserve what has a new home.
  if (raw.version === 1) {
    if (STAGES.includes(raw.stage)) base.stage = raw.stage;
    if (typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt;
    return base;
  }

  if (STAGES.includes(raw.stage)) base.stage = raw.stage;
  if (typeof raw.updatedAt === 'string') base.updatedAt = raw.updatedAt;
  if (typeof raw.sessionId === 'string' && raw.sessionId.length <= 200) base.sessionId = raw.sessionId;
  if (typeof raw.specSessionId === 'string' && raw.specSessionId.length <= 200) {
    base.specSessionId = raw.specSessionId;
  }
  if (isRecord(raw.stageSessions)) {
    for (const stage of STAGES) {
      const value = str(raw.stageSessions[stage]).slice(0, 200);
      if (value !== '') base.stageSessions[stage] = value;
    }
  }
  if (typeof raw.previewUrl === 'string' && raw.previewUrl.length <= 2000) base.previewUrl = raw.previewUrl;

  base.flow = raw.flow === 'incremental' ? 'incremental' : 'new';
  base.round = Math.min(999, Math.max(1, nonNegativeInt(raw.round, 1)));
  if (isRecord(raw.project)) {
    base.project.name = str(raw.project.name).slice(0, 160);
    base.project.goal = str(raw.project.goal).slice(0, 4000);
    base.project.createdAt = str(raw.project.createdAt).slice(0, 40);
  }

  const data = isRecord(raw.stageData) ? raw.stageData : {};
  // Legacy boards: one delivery Session served stages 2–5, and the requirements
  // stage may have had its own. Seed the per-stage map so nothing is lost.
  const specStarted =
    isRecord(data.spec) && (str(data.spec.startedAt) !== '' || bool(data.spec.confirmed));
  if (base.stageSessions.spec === '') {
    base.stageSessions.spec = base.specSessionId || (specStarted ? base.sessionId : '');
  }
  for (const stage of ['design', 'build', 'verify', 'ship']) {
    if (base.stageSessions[stage] === '') base.stageSessions[stage] = base.sessionId;
  }
  if (isRecord(data.spec)) {
    base.stageData.spec.input = str(data.spec.input).slice(0, 100_000);
    base.stageData.spec.sourceName = str(data.spec.sourceName).slice(0, 260);
    base.stageData.spec.sourcePath = str(data.spec.sourcePath).slice(0, 500);
    base.stageData.spec.startedAt = str(data.spec.startedAt).slice(0, 40);
    base.stageData.spec.confirmed = bool(data.spec.confirmed);
    base.stageData.spec.confirmedAt = str(data.spec.confirmedAt).slice(0, 40);
    base.stageData.spec.reviewNote = str(data.spec.reviewNote).slice(0, 2000);
  }
  if (isRecord(data.design)) {
    for (const key of ['frontend', 'backend', 'database', 'deployTarget', 'constraints']) {
      base.stageData.design[key] = str(data.design[key]).slice(0, key === 'constraints' ? 6000 : 200);
    }
    // States written before the plan picker carry only the free-form stack:
    // keep those people in custom mode instead of hiding their input.
    const legacyStack = ['frontend', 'backend', 'database', 'deployTarget'].some(
      (key) => base.stageData.design[key].trim() !== '',
    );
    base.stageData.design.mode = ['preset', 'custom'].includes(data.design.mode)
      ? data.design.mode
      : legacyStack
        ? 'custom'
        : 'preset';
    const preset = str(data.design.preset).trim();
    base.stageData.design.preset = /^[a-z][a-z0-9-]{0,39}$/.test(preset) ? preset : 'agent';
    if (Array.isArray(data.design.gates)) {
      const gates = [];
      const seen = new Set();
      for (const item of data.design.gates.slice(0, 20)) {
        if (!isRecord(item)) continue;
        const text = str(item.text).trim().slice(0, 200);
        if (text === '') continue;
        const id = str(item.id).slice(0, 40) || `gate-${gates.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        gates.push({ id, text, enabled: bool(item.enabled) });
      }
      base.stageData.design.gates = gates;
    }
    base.stageData.design.startedAt = str(data.design.startedAt).slice(0, 40);
    base.stageData.design.confirmed = bool(data.design.confirmed);
    base.stageData.design.confirmedAt = str(data.design.confirmedAt).slice(0, 40);
    base.stageData.design.reviewNote = str(data.design.reviewNote).slice(0, 2000);
  }
  if (isRecord(data.build)) {
    const items = Array.isArray(data.build.confirmations) ? data.build.confirmations.slice(0, 80) : null;
    if (items !== null) {
      const confirmations = [];
      const seen = new Set();
      for (const item of items) {
        if (!isRecord(item)) continue;
        const text = str(item.text).trim().slice(0, 300);
        if (text === '') continue;
        const id = str(item.id).slice(0, 80) || `item-${confirmations.length + 1}`;
        if (seen.has(id)) continue;
        seen.add(id);
        confirmations.push({ id, text, done: bool(item.done) });
        if (confirmations.length >= 40) break;
      }
      base.stageData.build.confirmations = confirmations;
    }
    base.stageData.build.startedAt = str(data.build.startedAt).slice(0, 40);
    base.stageData.build.confirmed = bool(data.build.confirmed);
    base.stageData.build.confirmedAt = str(data.build.confirmedAt).slice(0, 40);
    base.stageData.build.reviewNote = str(data.build.reviewNote).slice(0, 2000);
  }
  if (isRecord(data.verify)) {
    base.stageData.verify.startedAt = str(data.verify.startedAt).slice(0, 40);
    base.stageData.verify.confirmed = bool(data.verify.confirmed);
    base.stageData.verify.confirmedAt = str(data.verify.confirmedAt).slice(0, 40);
    base.stageData.verify.reviewNote = str(data.verify.reviewNote).slice(0, 2000);
    base.stageData.verify.fixRounds = Math.min(50, nonNegativeInt(data.verify.fixRounds, 0));
  }
  if (isRecord(data.ship)) {
    base.stageData.ship.mode = DEPLOY_MODES.includes(data.ship.mode) ? data.ship.mode : 'none';
    base.stageData.ship.host = str(data.ship.host).slice(0, 253);
    base.stageData.ship.port = str(data.ship.port).slice(0, 6);
    base.stageData.ship.user = str(data.ship.user).slice(0, 100);
    base.stageData.ship.path = str(data.ship.path).slice(0, 500);
    base.stageData.ship.method = ['rsync', 'git', 'docker', 'manual'].includes(data.ship.method)
      ? data.ship.method
      : 'rsync';
    base.stageData.ship.deployRequested = bool(data.ship.deployRequested);
    base.stageData.ship.deployStartedAt = str(data.ship.deployStartedAt).slice(0, 40);
    base.stageData.ship.confirmed = bool(data.ship.confirmed);
    base.stageData.ship.confirmedAt = str(data.ship.confirmedAt).slice(0, 40);
    base.stageData.ship.reviewNote = str(data.ship.reviewNote).slice(0, 2000);
  }

  const activity = Array.isArray(raw.activity) ? raw.activity.slice(-60) : [];
  for (const entry of activity) {
    if (!isRecord(entry)) continue;
    const text = str(entry.text).trim().slice(0, 500);
    if (text === '') continue;
    base.activity.push({
      id: str(entry.id).slice(0, 80) || `activity-${base.activity.length + 1}`,
      time: str(entry.time).slice(0, 40),
      kind: ['info', 'prompt', 'confirm', 'deploy', 'error'].includes(entry.kind) ? entry.kind : 'info',
      text,
    });
  }

  // Approval and storage metadata are server-owned on state writes.
  if (isRecord(raw.artifactStorage)) base.artifactStorage = raw.artifactStorage;
  for (const stage of STAGES) {
    const source = isRecord(data[stage]) ? data[stage] : {};
    base.stageData[stage].approvalId = str(source.approvalId).slice(0, 100);
    base.stageData[stage].needsReview = bool(source.needsReview);
    if (isRecord(source.legacyConfirmation)) {
      base.stageData[stage].legacyConfirmation = {
        confirmedAt: str(source.legacyConfirmation.confirmedAt).slice(0, 40),
        reviewNote: str(source.legacyConfirmation.reviewNote).slice(0, 2000),
      };
    }
  }
  base.stateRevision = nonNegativeInt(raw.stateRevision, 0);
  if (Number.isSafeInteger(raw.reviewRevisionBase)) base.reviewRevisionBase = raw.reviewRevisionBase;
  return base;
}

/**
 * Resolve the project root for one request.
 *
 * The Workbench is global, so the launch directory is only a fallback. The
 * Client may name an explicit project directory in `x-workbench-root`; this is
 * how a workspace living below the Harness launch directory is targeted. The
 * value must be an absolute existing directory, which also stops a typo from
 * making the state writer create an arbitrary tree.
 * @param ctx - Host context, used to read the launch directory.
 * @param req - request carrying the optional project root header.
 * @returns absolute project directory.
 */
async function projectRoot(ctx, req) {
  const header = req && req.headers ? req.headers['x-workbench-root'] : undefined;
  if (typeof header === 'string' && header.trim() !== '') {
    let value = header.trim();
    try {
      value = decodeURIComponent(value);
    } catch (error) {
      /* Keep the raw header when it is not URI-encoded. */
    }
    if (!isAbsolute(value)) throw new Error('project root must be an absolute path');
    const candidate = resolve(value);
    const info = await stat(candidate).catch(() => null);
    if (info === null || !info.isDirectory()) throw new Error('project root is not an existing directory');
    return candidate;
  }
  const working = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
  const root =
    working !== undefined && typeof working.defaultDirectory === 'string' && working.defaultDirectory !== ''
      ? working.defaultDirectory
      : process.cwd();
  return resolve(root);
}

/**
 * Resolve a request-supplied relative path under the project root.
 * @param root - absolute project root.
 * @param candidate - relative path from a request.
 * @returns absolute path inside the project.
 * @throws when the path is absolute, empty, or escapes the project.
 */
function resolveInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') throw new Error('path is required');
  if (candidate.includes('\0')) throw new Error('path is invalid');
  const cleaned = candidate.replace(/^\.\//, '');
  if (cleaned.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cleaned)) throw new Error('absolute paths are not allowed');
  const target = resolve(root, normalize(cleaned));
  if (target !== root && !target.startsWith(root + sep)) throw new Error('path escapes the project');
  return target;
}

/** @returns the path relative to root, using forward slashes. */
function relativePath(root, target) {
  return relative(root, target).split(sep).join('/');
}

/**
 * Read one request body, capped.
 * @param req - incoming request.
 * @param limit - maximum byte count.
 * @returns raw body bytes.
 */
function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** @returns parsed JSON from a capped request body. */
async function readJson(req, limit = MAX_STATE_BYTES) {
  const body = await readBody(req, limit);
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

/** @returns a JSON response writer scoped to one handler. */
function responder(res) {
  return (status, payload, headers = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(JSON.stringify(payload));
  };
}

/**
 * Decode the five predefined XML entities and numeric character references.
 * @param text - XML text.
 * @returns decoded text.
 */
function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

/**
 * Find one file in a ZIP archive and inflate it.
 * DOCX is a ZIP; this tiny reader avoids adding a dependency just to preview
 * the document the Workbench itself produces.
 * @param buffer - complete ZIP bytes.
 * @param wanted - exact archive entry name.
 * @returns entry bytes, or null when absent.
 */
function readZipEntry(buffer, wanted) {
  // Locate the End Of Central Directory record. It is within the final 65,557
  // bytes, and scanning backwards is cheaper than trusting a comment length.
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) return null;
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      if ((flags & 0x1) !== 0) return null; // Encrypted.
      if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/**
 * Convert WordprocessingML into readable plain text, preserving paragraph,
 * tab, and table-cell boundaries.
 * @param buffer - complete DOCX bytes.
 * @returns extracted text, or null when this is not a readable DOCX.
 */
function readDocxText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml');
  if (xml === null) return null;
  let text = xml.toString('utf8');
  text = text
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<w:cr\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeXml(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/**
 * Classify a document by extension for the browser preview.
 * @param file - absolute path.
 * @returns one of markdown, html, docx, code, text, binary.
 */
function previewKind(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.sh', '.sql'].includes(ext)) {
    return 'code';
  }
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

/**
 * Read a document for preview.
 * @param file - absolute path.
 * @param rel - path for the response.
 * @returns preview payload.
 */
async function readPreview(file, rel) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('not a file');
  if (info.size > MAX_PREVIEW_BYTES) throw new Error('file is too large to preview');
  const kind = previewKind(file);
  if (kind === 'binary' || kind === 'pdf') {
    return {
      path: rel,
      kind,
      size: info.size,
      mtime: info.mtime.toISOString(),
      text: '',
      unsupported: true,
    };
  }
  const bytes = await readFile(file);
  let text;
  if (kind === 'docx') {
    const extracted = readDocxText(bytes);
    if (extracted === null) throw new Error('DOCX could not be read');
    text = extracted;
  } else {
    text = bytes.toString('utf8');
  }
  return {
    path: rel,
    kind,
    size: info.size,
    mtime: info.mtime.toISOString(),
    text,
    unsupported: false,
  };
}

/* --------------------------------------------------------------------------
 * DOCX writing
 * ------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

/** @returns CRC-32 of a buffer. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @returns the current time encoded as MS-DOS date and time words. */
function dosDateTime() {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive using the stored (uncompressed) method. DOCX readers
 * accept stored entries, and avoiding DEFLATE keeps this writer auditable.
 * @param entries - array of { name, data }.
 * @returns ZIP bytes.
 */
function zipStored(entries) {
  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file name.
    local.writeUInt16LE(0, 8); // Stored.
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** @returns XML-escaped text. */
function xmlEscape(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse the small Markdown subset the Workbench documents use into blocks.
 * @param markdown - source.
 * @returns block list with kind and text.
 */
function markdownBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let inCode = false;
  let code = [];

  const flushCode = () => {
    if (code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') });
    code = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        code = [];
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.trim() === '') {
      blocks.push({ kind: 'blank', text: '' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: `h${heading[1].length}`, text: heading[2].trim() });
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr', text: '' });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      blocks.push({ kind: 'quote', text: quote[1].trim() });
      continue;
    }
    const task = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task !== null) {
      blocks.push({ kind: 'bullet', text: `${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${task[2].trim()}` });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }
    const numbered = /^\s*(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered !== null) {
      blocks.push({ kind: 'number', text: `${numbered[1]} ${numbered[2].trim()}` });
      continue;
    }
    blocks.push({ kind: 'p', text: line.trim() });
  }
  flushCode();
  return blocks;
}

/** @returns a Word run with optional formatting. */
function wordRun(text, opts = {}) {
  const props = [];
  if (opts.bold) props.push('<w:b/>');
  if (opts.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>', '<w:color w:val="333333"/>');
  if (opts.size) props.push(`<w:sz w:val="${opts.size}"/>`);
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<w:r>${rPr}<w:t${preserve}>${xmlEscape(text)}</w:t></w:r>`;
}

/** @returns a Word paragraph. */
function wordParagraph(text, opts = {}) {
  const pPr = [];
  if (opts.align) pPr.push(`<w:jc w:val="${opts.align}"/>`);
  if (opts.indent) pPr.push(`<w:ind w:left="${opts.indent}"/>`);
  if (opts.spacing) pPr.push(`<w:spacing w:before="${opts.spacing[0]}" w:after="${opts.spacing[1]}"/>`);
  if (opts.shade) pPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>');
  const props = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${props}${wordRun(text, opts)}</w:p>`;
}

/**
 * Convert Markdown to a complete, simple DOCX document.
 * @param markdown - source Markdown.
 * @param title - document title used in metadata.
 * @returns DOCX bytes.
 */
function buildDocx(markdown, title) {
  const blocks = markdownBlocks(markdown);
  const body = [];
  for (const block of blocks) {
    if (block.kind === 'blank') {
      continue;
    }
    if (block.kind === 'hr') {
      body.push(
        '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="D9DCE3"/></w:pBdr></w:pPr></w:p>',
      );
      continue;
    }
    if (block.kind === 'code') {
      for (const line of block.text.split('\n')) {
        body.push(wordParagraph(line === '' ? ' ' : line, { code: true, size: 19, shade: true, spacing: [0, 0] }));
      }
      continue;
    }
    if (block.kind === 'h1') {
      body.push(wordParagraph(block.text, { bold: true, size: 40, spacing: [360, 160] }));
      continue;
    }
    if (block.kind === 'h2') {
      body.push(wordParagraph(block.text, { bold: true, size: 32, spacing: [280, 120] }));
      continue;
    }
    if (block.kind === 'h3') {
      body.push(wordParagraph(block.text, { bold: true, size: 26, spacing: [220, 100] }));
      continue;
    }
    if (block.kind === 'h4' || block.kind === 'h5' || block.kind === 'h6') {
      body.push(wordParagraph(block.text, { bold: true, size: 24, spacing: [180, 80] }));
      continue;
    }
    if (block.kind === 'bullet') {
      body.push(wordParagraph(`• ${block.text}`, { indent: 420, spacing: [0, 60] }));
      continue;
    }
    if (block.kind === 'number') {
      body.push(wordParagraph(block.text, { indent: 420, spacing: [0, 60] }));
      continue;
    }
    if (block.kind === 'quote') {
      body.push(wordParagraph(block.text, { indent: 420, spacing: [60, 60] }));
      continue;
    }
    body.push(wordParagraph(block.text, { spacing: [0, 100] }));
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1300" w:bottom="1200" w:left="1300" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const now = new Date().toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(title)}</dc:title><dc:creator>DSH Workbench</dc:creator><cp:lastModifiedBy>DSH Workbench</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DSH Workbench</Application></Properties>`;

  return zipStored([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: document },
  ]);
}

/* --------------------------------------------------------------------------
 * Route handlers
 * ------------------------------------------------------------------------ */

/* --------------------------------------------------------------------------
 * Boards
 *
 * One project holds several boards, one per requirement round: every round is
 * an independent board file under `.dsh/workbench/boards/`, so earlier rounds
 * keep their own stages, confirmations and sessions. `boards.json` keeps the
 * roster and which board is active; a legacy single `.dsh/workbench.json` is
 * migrated into the first board on first read.
 * ------------------------------------------------------------------------ */

const BOARD_INDEX_VERSION = 1;
const MAX_BOARDS = 100;

/** @returns the paths one project uses for its board roster and files. */
function boardPaths(root) {
  const dir = join(root, '.dsh', 'workbench');
  return {
    dir,
    boards: join(dir, 'boards'),
    index: join(dir, 'boards.json'),
    legacy: join(root, '.dsh', 'workbench.json'),
  };
}

/** @returns the file holding one board. */
function boardFile(root, id) {
  boardDirectory(id);
  return join(boardPaths(root).boards, `${id}.json`);
}

/** @returns one roster row for a board. */
function boardSummary(id, state, name) {
  const pending = STAGES.find(stage => !state.stageData[stage].confirmed);
  const stage = pending || 'ship';
  const title = str(state.project.name).trim() || str(name).trim() || str(state.project.goal).trim().split('\n')[0].slice(0, 80) || `未命名需求 · 第 ${state.round || 1} 轮`;
  return { id, name: title, goal: str(state.project.goal).slice(0, 2000),
    flow: state.flow === 'incremental' ? 'incremental' : 'new', round: state.round,
    stage, confirmed: STAGES.findIndex(key => !state.stageData[key].confirmed) < 0 ? STAGES.length : STAGES.indexOf(stage),
    stageStarted: Boolean(state.stageData[stage].startedAt),
    stages: Object.fromEntries(STAGES.map(key => [key, {
      confirmed: state.stageData[key].confirmed, needsReview: !!state.stageData[key].needsReview,
      startedAt: state.stageData[key].startedAt, confirmedAt: state.stageData[key].confirmedAt,
      sessionId: state.stageSessions?.[key] || (key === 'spec' ? state.specSessionId : state.sessionId) || '',
    }])), updatedAt: state.updatedAt || new Date().toISOString() };
}

/** Read the roster, or null when the project has none yet. */
async function readBoardIndex(root) {
  try {
    const parsed = JSON.parse(await readFile(boardPaths(root).index, 'utf8'));
    const boards = Array.isArray(parsed.boards) ? parsed.boards.filter(isRecord) : [];
    return {
      version: BOARD_INDEX_VERSION,
      activeId: str(parsed.activeId),
      boards: boards.map((board) => ({
        id: str(board.id),
        name: str(board.name),
        flow: board.flow === 'incremental' ? 'incremental' : 'new',
        round: Math.min(999, Math.max(1, nonNegativeInt(board.round, 1))),
        stage: STAGES.includes(board.stage) ? board.stage : STAGES[0],
        confirmed: Math.min(STAGES.length, nonNegativeInt(board.confirmed, 0)),
        stageStarted: board.stageStarted === true,
        updatedAt: str(board.updatedAt),
      })),
    };
  } catch (error) {
    return null;
  }
}

/** Persist the roster. */
async function writeBoardIndex(root, index) {
  const paths = boardPaths(root);
  await mkdir(paths.dir, { recursive: true });
  const boards = index.boards.slice(0, MAX_BOARDS);
  await writeFile(
    paths.index,
    `${JSON.stringify({ version: BOARD_INDEX_VERSION, activeId: index.activeId, boards }, null, 2)}\n`,
    'utf8',
  );
}

/** Read one board file. */
async function readBoard(root, id) {
  if (id === '') return null;
  try {
    return sanitizeState(JSON.parse(await readFile(boardFile(root, id), 'utf8')));
  } catch (error) {
    return null;
  }
}

/** Write one board file and refresh its roster row. */
async function saveBoard(root, index, id, state, name) {
  const paths = boardPaths(root);
  await mkdir(paths.boards, { recursive: true });
  state.stateRevision = nonNegativeInt(state.stateRevision, 0) + 1;
  await atomicJson(boardFile(root, id), state);
  const summary = boardSummary(id, state, name === undefined ? '' : name);
  const existing = index.boards.findIndex((board) => board.id === id);
  if (existing < 0) index.boards.unshift(summary);
  else index.boards[existing] = summary;
  index.boards = index.boards.slice(0, MAX_BOARDS);
  await writeBoardIndex(root, index);
  return summary;
}

/**
 * Ensure the roster exists, migrating the legacy single-board file into the
 * first board. The legacy file is left untouched as a safety copy.
 */
async function ensureBoardIndex(root) {
  const existing = await readBoardIndex(root);
  if (existing !== null) return existing;
  const paths = boardPaths(root);
  const index = { version: BOARD_INDEX_VERSION, activeId: '', boards: [] };
  try {
    const legacy = sanitizeState(JSON.parse(await readFile(paths.legacy, 'utf8')));
    legacy.updatedAt = new Date().toISOString();
    await saveBoard(root, index, 'board-1', legacy, '');
    index.activeId = 'board-1';
  } catch (error) {
    /* No legacy board: the project starts with an empty roster. */
  }
  await writeBoardIndex(root, index);
  return index;
}

/** Create and activate a new board, carrying the project identity forward. */
async function createBoard(root, index, options = {}) {
  const previousId = index.activeId;
  const previous = previousId === '' ? null : await readBoard(root, previousId);
  const next = emptyState();
  if (previous !== null) {
    next.project = { ...previous.project };
    next.flow = options.flow === 'new' ? 'new' : 'incremental';
    next.round = Math.max(1, ...index.boards.map((board) => board.round || 1), previous.round || 1) + 1;
  } else {
    next.flow = options.flow === 'incremental' ? 'incremental' : 'new';
  }
  // Freeze the old active board's legacy files before opening a new round.
  if (previous) await prepareBoard(root, index, previousId, previous);
  next.updatedAt = new Date().toISOString();
  const id = `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await initializeArtifacts(root, id, next);
  next.boardId = id;
  await saveBoard(root, index, id, next, options.name === undefined ? '' : str(options.name));
  index.activeId = id;
  await writeBoardIndex(root, index);
  await rememberRequirement(next, root, { boardId: id, boardName: options.name === undefined ? '' : str(options.name) });
  return { id, state: next };
}

/** @returns the active board id and state, creating one when the project has none. */
async function activeBoard(root, index) {
  let id = index.activeId;
  let state = id === '' ? null : await readBoard(root, id);
  if (state !== null) return { id, state };
  id = id === '' ? 'board-1' : id;
  state = emptyState();
  await initializeArtifacts(root, id, state);
  state.updatedAt = new Date().toISOString();
  await saveBoard(root, index, id, state, '');
  index.activeId = id;
  await writeBoardIndex(root, index);
  return { id, state };
}

/** Initialize once; old approvals are retained as unverified legacy records. */
async function prepareBoard(root, index, id, state) {
  const row = index.boards.find((item) => item.id === id);
  const initialized = await initializeArtifacts(root, id, state, {
    legacy: true, importRoot: id === index.activeId,
  });
  const previousRevision = state.stateRevision || 0;
  const changed = await reconcileArtifacts(root, id, state);
  if (changed) state.reviewRevisionBase = previousRevision;
  if (initialized || changed) {
    state.updatedAt = new Date().toISOString();
    await saveBoard(root, index, id, state, row?.name || '');
    await rememberRequirement(state, root, { boardId: id, boardName: row?.name || '' });
  }
  state.boardId = id;
  return { id, state };
}

async function selectedBoard(root, index, req) {
  const requested = req.headers?.['x-workbench-board'];
  if (requested) {
    if (!index.boards.some((item) => item.id === requested)) throw new Error('board not found');
    const state = await readBoard(root, requested);
    if (!state) throw new Error('board data is unavailable');
    return prepareBoard(root, index, requested, state);
  }
  const { id, state } = await activeBoard(root, index);
  return prepareBoard(root, index, id, state);
}

async function requestedDocument(root, req, requested) {
  const index = await ensureBoardIndex(root);
  const { id } = await selectedBoard(root, index, req);
  return await documentPath(root, id, requested) || resolveInside(root, requested);
}

function knowledgeHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      const { id, state } = await selectedBoard(root, index, req);
      if (req.method === 'GET') {
        const query = new URL(req.url || '/', 'http://workbench.local').searchParams;
        send(200, await knowledgeView(root, id, state, { q: query.get('q'), type: query.get('type'), status: query.get('status') }));
      } else if (req.method === 'POST') {
        send(200, await updateKnowledge(root, id, state, await readJson(req, 64 * 1024)));
      } else send(405, { error: 'method-not-allowed' });
    } catch (error) { send(409, { error: 'knowledge-failed', message: String(error.message || error) }); }
  };
}

function contextHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      const root = await projectRoot(ctx, req);
      if (req.method === 'POST') await executionPolicy(root);
      const index = await ensureBoardIndex(root);
      const { id, state } = await selectedBoard(root, index, req);
      if (req.method === 'GET') {
        const query = new URL(req.url || '/', 'http://workbench.local').searchParams;
        send(200, query.has('id') ? await readContext(root, id, query.get('id')) : await contextView(root, id, state, query.get('stage') || state.stage));
      } else if (req.method === 'POST') {
        const body = await readJson(req, 8 * 1024);
        if (body.action !== 'build') throw new Error('未知上下文操作');
        send(200, await buildContext(root, id, state, body.stage));
      } else send(405, { error: 'method-not-allowed' });
    } catch (error) { send(409, { error: 'context-failed', message: String(error.message || error) }); }
  };
}

function reviewHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      const { id, state } = await selectedBoard(root, index, req);
      if (req.method === 'GET') {
        const url = new URL(req.url || '/', 'http://workbench.local');
        send(200, await documentReview(root, id, url.searchParams.get('path') || '', url.searchParams.get('approval') || ''));
        return;
      }
      if (req.method !== 'POST') return send(405, { error: 'method-not-allowed' });
      const body = await readJson(req, 32 * 1024);
      const comment = await updateComment(root, id, body);
      if (body.action !== 'resolve') {
        let changed = false;
        for (const stage of STAGES.slice(STAGES.indexOf(comment.stage))) {
          const data = state.stageData[stage];
          if (data.confirmed) {
            Object.assign(data, { confirmed: false, confirmedAt: '', needsReview: true });
            changed = true;
          }
        }
        if (changed) {
          state.reviewRevisionBase = state.stateRevision || 0;
          const row = index.boards.find((item) => item.id === id);
          await saveBoard(root, index, id, state, row?.name || '');
          await rememberRequirement(state, root, { boardId: id, boardName: row?.name || '' });
        }
      }
      send(200, { ok: true, boardId: id });
    } catch (error) {
      send(error.code === 'ENOENT' ? 404 : 409, { error: 'document-review-failed', message: String(error.message || error) });
    }
  };
}

function artifactsHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      const { id, state } = await selectedBoard(root, index, req);
      if (req.method === 'GET') {
        send(200, { ...await artifactReview(root, id, state), state,
          history: await listApprovalHistory(root, id) });
        return;
      }
      if (req.method !== 'POST') return send(405, { error: 'method-not-allowed' });
      const body = await readJson(req);
      if (body.action !== 'confirm') throw new Error('unknown artifact action');
      await assertStageReviewed(root, id, body.stage);
      const approval = await confirmArtifacts(root, id, state, body.stage, body.hashes, body.note);
      delete state.reviewRevisionBase;
      const row = index.boards.find((item) => item.id === id);
      state.updatedAt = new Date().toISOString();
      await saveBoard(root, index, id, state, row?.name || '');
      await rememberRequirement(state, root, { boardId: id, boardName: row?.name || '' });
      send(200, { state, approval });
    } catch (error) {
      send(409, { error: 'artifact-review-failed', message: String(error.message || error) });
    }
  };
}

/**
 * Create the state handler.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function stateHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      if (req.method === 'GET') {
        const { id, state } = await selectedBoard(root, index, req);
        const row = index.boards.find((board) => board.id === id);
        send(200, {
          ...state,
          boardId: id,
          boardName: row ? row.name : '',
          projectRoot: root,
          projectName: basename(root),
        });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const parsed = JSON.parse((await readBody(req, MAX_STATE_BYTES)).toString('utf8'));
        const { id, state: persisted } = await selectedBoard(root, index, req);
        if (parsed.boardId && parsed.boardId !== id) throw new Error('board identity mismatch');
        if (nonNegativeInt(parsed.stateRevision, 0) !== persisted.stateRevision) {
          return send(409, { error: 'state-conflict', message: '看板已被更新，请刷新后重试；本地修改暂未覆盖服务器状态。' });
        }
        const state = sanitizeState(parsed);
        delete state.reviewRevisionBase;
        state.artifactStorage = persisted.artifactStorage;
        state.boardId = id;
        for (const stage of STAGES) {
          const old = persisted.stageData[stage];
          Object.assign(state.stageData[stage], {
            confirmed: old.confirmed && parsed.stageData?.[stage]?.confirmed !== false,
            confirmedAt: old.confirmedAt, approvalId: old.approvalId || '',
            needsReview: old.needsReview || (old.confirmed && parsed.stageData?.[stage]?.confirmed === false),
            legacyConfirmation: old.legacyConfirmation,
          });
          if (!state.stageData[stage].confirmed) state.stageData[stage].confirmedAt = '';
        }
        // Invalidating an upstream approval invalidates every downstream approval.
        let invalid = false;
        for (const stage of STAGES) {
          if (!state.stageData[stage].confirmed) invalid = true;
          if (invalid && state.stageData[stage].confirmed) {
            Object.assign(state.stageData[stage], { confirmed: false, confirmedAt: '', needsReview: true });
          }
        }
        await reconcileArtifacts(root, id, state);
        state.updatedAt = new Date().toISOString();
        const row = index.boards.find((board) => board.id === id);
        await saveBoard(root, index, id, state, row ? row.name : '');
        await rememberRequirement(state, root, { boardId: id, boardName: row ? row.name : '' });
        send(200, { ...state, boardId: id });
        return;
      }
      send(405, { error: 'method-not-allowed' });
    } catch (error) {
      send(500, { error: 'workbench-state-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Create the board-roster handler: list the project's boards, or switch the
 * active one. `root` in the body lets the requirement archive activate a board
 * in another project in the same call.
 */
function boardsHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      let root;
      let body = {};
      if (req.method === 'POST') {
        body = JSON.parse((await readBody(req, 8 * 1024)).toString('utf8'));
      }
      const explicit = typeof body.root === 'string' ? body.root.trim() : '';
      if (explicit !== '' && isAbsolute(explicit) && (await stat(explicit).catch(() => null))) {
        root = resolve(explicit);
      } else {
        root = await projectRoot(ctx, req);
      }
      const index = await ensureBoardIndex(root);
      if (req.method === 'GET') {
        const boards = [];
        for (const row of index.boards) {
          const saved = await readBoard(root, row.id);
          if (!saved) continue;
          const { state } = await prepareBoard(root, index, row.id, saved);
          boards.push(boardSummary(row.id, state, row.name));
        }
        send(200, { activeId: index.activeId, boards });
        return;
      }
      if (req.method !== 'POST') {
        send(405, { error: 'method-not-allowed' });
        return;
      }
      const action = str(body.action);
      if (action === 'activate') {
        const id = str(body.id);
        if (!index.boards.some((board) => board.id === id)) {
          send(404, { error: 'board-not-found' });
          return;
        }
        // Migrate both while the original active id still identifies root-file ownership.
        await selectedBoard(root, index, { headers: {} });
        const targetState = await readBoard(root, id);
        if (!targetState) throw new Error('board data is unavailable');
        await prepareBoard(root, index, id, targetState);
        index.activeId = id;
        await writeBoardIndex(root, index);
        send(200, { activeId: id, boards: index.boards, root });
        return;
      }
      if (action === 'create') {
        const created = await createBoard(root, index, { flow: body.flow, name: body.name });
        send(200, { state: created.state, boardId: created.id, activeId: created.id, boards: index.boards, root });
        return;
      }
      send(400, { error: 'unknown-action' });
    } catch (error) {
      send(400, { error: 'boards-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Create the document preview handler.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function fileHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'GET') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    let requested = '';
    try {
      const root = await projectRoot(ctx, req);
      const url = new URL(req.url || '/', 'http://workbench.local');
      requested = url.searchParams.get('path') || '';
      const target = await requestedDocument(root, req, requested);
      const payload = await readPreview(target, relativePath(root, target));
      send(200, payload);
    } catch (error) {
      const message = String((error && error.message) || error);
      const missing = error && (error.code === 'ENOENT' || /not a file/.test(message));
      let soft = false;
      try {
        soft = new URL(req.url || '/', 'http://workbench.local').searchParams.get('soft') === '1';
      } catch (parseError) {
        /* Keep the hard failure when the URL cannot be parsed. */
      }
      if (missing && soft) {
        send(200, { missing: true, path: requested });
        return;
      }
      send(missing ? 404 : 400, { error: missing ? 'file-not-found' : 'file-preview-failed', message });
    }
  };
}

/**
 * List the documents the project root currently holds.
 *
 * The dock needs one call per refresh, not one per expected file: this reports
 * every Markdown/Word/PDF/plain-text file sitting in the project root together
 * with its size and modification time, so a stage gate can tell which expected
 * deliverables exist and the UI can surface documents the agent named itself.
 * @param root - absolute project root.
 * @returns metadata for each document, sorted by path.
 */
async function scanDocuments(root) {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return [];
  }
  const files = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const ext = extname(dirent.name).toLowerCase();
    if (!LIBRARY_EXTENSIONS.has(ext)) continue;
    const file = join(root, dirent.name);
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) continue;
    files.push({
      path: dirent.name,
      kind: previewKind(file),
      ext: ext.slice(1),
      size: info.size,
      mtime: info.mtime.toISOString(),
    });
    if (files.length >= MAX_LIBRARY_FILES) break;
  }
  files.sort((left, right) => left.path.localeCompare(right.path, 'zh'));
  return files;
}

/**
 * Create the document-library handler.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function libraryHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'GET') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      const { id } = await selectedBoard(root, index, req);
      const own = await scanDocuments(await managedPath(root, `${boardDirectory(id)}/documents`));
      const extra = (await scanDocuments(root)).filter((item) => !DOCUMENT_NAMES.has(item.path));
      send(200, { boardId: id, files: [
        ...own.map((item) => ({ ...item, scope: 'board', physicalPath: `${boardDirectory(id)}/documents/${item.path}` })),
        ...extra.map((item) => ({ ...item, scope: 'project', physicalPath: item.path })),
      ] });
    } catch (error) {
      send(400, { error: 'library-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Original-byte response header value.
 * @param name - file name shown by the browser.
 * @param download - whether the browser should save instead of render.
 * @returns a Content-Disposition value safe for a non-ASCII name.
 */
function contentDisposition(name, download) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Create the original-bytes handler. PDF and Word previews cannot be produced
 * from extracted text, so the dock streams the file itself; `download=1` turns
 * the same response into a save.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function rawHandler(ctx, fence) {
  return async (req, res) => {
    if (fence(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.end();
      return;
    }
    try {
      const root = await projectRoot(ctx, req);
      const url = new URL(req.url || '/', 'http://workbench.local');
      const target = await requestedDocument(root, req, url.searchParams.get('path') || '');
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      if (info.size > MAX_RAW_BYTES) {
        res.statusCode = 413;
        res.end('file is too large');
        return;
      }
      const name = basename(url.searchParams.get('name') || target);
      res.statusCode = 200;
      res.setHeader('content-type', RAW_CONTENT_TYPES[extname(name).toLowerCase()] || 'application/octet-stream');
      res.setHeader('content-length', String(info.size));
      res.setHeader('content-disposition', contentDisposition(name, url.searchParams.get('download') === '1'));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      await new Promise((resolvePromise, reject) => {
        const stream = createReadStream(target);
        stream.on('error', reject);
        stream.on('end', resolvePromise);
        stream.pipe(res);
      });
    } catch (error) {
      const message = String((error && error.message) || error);
      const missing = error && (error.code === 'ENOENT' || /not a file/.test(message));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = missing ? 404 : 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: missing ? 'file-not-found' : 'file-read-failed', message }));
    }
  };
}

/* --------------------------------------------------------------------------
 * Requirement archive
 *
 * The per-project state file is the source of truth for one requirement. This
 * index is the user-level view over those files: every save records the
 * project path, the stage it reached and the session that carries the
 * conversation, so closing the page or the session never strands a
 * requirement. It lives in the Harness home, outside every project.
 * ------------------------------------------------------------------------ */

const MAX_REQUIREMENTS = 200;

/** @returns the Harness home directory holding the archive. */
function harnessHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh');
}

/** @returns the archive file path. */
function requirementsFile() {
  return join(harnessHome(), 'workbench', 'requirements.json');
}

/** @returns recorded requirements, newest first; a broken file reads as empty. */
async function readRequirementIndex() {
  try {
    const parsed = JSON.parse(await readFile(requirementsFile(), 'utf8'));
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return items.filter(isRecord).slice(0, MAX_REQUIREMENTS);
  } catch (error) {
    return [];
  }
}

/** Replace the archive atomically; the caller keeps the result small. */
async function writeRequirementIndex(items) {
  const file = requirementsFile();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

// Archive mutations span project roots; serialize the read/modify/write as one unit.
let requirementIndexTail = Promise.resolve();
function updateRequirementIndex(transform) {
  const operation = requirementIndexTail.catch(() => {}).then(async () => {
    const next = transform(await readRequirementIndex());
    await writeRequirementIndex(next);
    return next;
  });
  requirementIndexTail = operation.catch(() => {});
  return operation;
}

/**
 * Project one saved board into its archive row.
 * @param state - sanitized project state.
 * @param root - absolute project root.
 * @returns the archive entry.
 */
function requirementEntry(state, root, meta = {}) {
  const confirmed = STAGES.filter((stage) => state.stageData[stage].confirmed).length;
  const started = STAGES.some(
    (stage) => state.stageData[stage].startedAt !== '' || state.stageData[stage].confirmed,
  );
  return {
    root,
    boardId: str(meta.boardId),
    boardName: str(meta.boardName),
    title: basename(root),
    name: state.project.name,
    goal: state.project.goal.slice(0, 300),
    stage: STAGES.includes(state.stage) ? state.stage : STAGES[0],
    flow: state.flow === 'incremental' ? 'incremental' : 'new',
    round: state.round,
    confirmed,
    started,
    sessionId: state.sessionId,
    specSessionId: state.specSessionId,
    stageSessions: { ...state.stageSessions },
    requirementPreview: state.stageData.spec.input.slice(0, 240),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Record (or refresh) one requirement in the archive. Best effort: an archive
 * failure must never fail the state save that produced it.
 */
async function rememberRequirement(state, root, meta = {}) {
  try {
    const entry = requirementEntry(state, root, meta);
    const key = JSON.stringify([entry.root, entry.boardId]);
    await updateRequirementIndex(items => [entry, ...items.filter((item) => JSON.stringify([str(item.root), str(item.boardId)]) !== key)]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, MAX_REQUIREMENTS));
  } catch (error) {
    /* The archive is a convenience view, not the source of truth. */
  }
}

/**
 * Annotate archive rows with whether their project directory still exists.
 * @param items - recorded requirements.
 * @returns rows carrying an `exists` flag.
 */
async function decorateRequirements(items) {
  return Promise.all(
    items.map(async (item) => {
      const root = str(item.root);
      const info = root === '' ? null : await stat(root).catch(() => null);
      return { ...item, exists: info !== null && info.isDirectory() };
    }),
  );
}

/**
 * Start a new incremental round.
 *
 * Every round is its own board: the active board stays untouched (its stage,
 * confirmations and sessions are preserved), and a fresh board with the next
 * round number becomes active. Earlier rounds stay reachable from the archive.
 */
function roundsHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'POST') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    try {
      const root = await projectRoot(ctx, req);
      const index = await ensureBoardIndex(root);
      const created = await createBoard(root, index, { flow: 'incremental' });
      send(200, {
        state: created.state,
        boardId: created.id,
        activeId: created.id,
        boards: index.boards,
        archived: '',
        root,
      });
    } catch (error) {
      send(400, { error: 'round-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Create the requirement-archive handler.
 * @param ctx - Host context (unused; the archive is not project-scoped).
 * @returns route handler.
 */
function requirementsHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    try {
      if (req.method === 'GET') {
        send(200, { items: await decorateRequirements(await readRequirementIndex()) });
        return;
      }
      if (req.method === 'DELETE' || req.method === 'POST') {
        const body = req.method === 'POST' ? await readJson(req, 128 * 1024) : {};
        if (!isRecord(body)) return send(400, { error: 'invalid-request' });
        if (body.action === 'remove-many') {
          if (!Array.isArray(body.items) || !body.items.length || body.items.length > MAX_REQUIREMENTS ||
            body.items.some(item => !isRecord(item) || typeof item.root !== 'string' || !isAbsolute(item.root) || item.root.length > 8192 || typeof item.boardId !== 'string' || item.boardId.length > 200)) {
            return send(400, { error: 'invalid-selection', message: '请选择有效的需求记录，每次最多移除200条。' });
          }
          const keys = new Set(body.items.map(item => JSON.stringify([item.root, item.boardId])));
          let removed = 0;
          const remaining = await updateRequirementIndex(items => items.filter(item => {
            const selected = keys.has(JSON.stringify([str(item.root), str(item.boardId)]));
            if (selected) removed++;
            return !selected;
          }));
          return send(200, { removed, items: await decorateRequirements(remaining) });
        }
        if (body.action !== undefined) return send(400, { error: 'unknown-action' });
        let root = '';
        let boardId = '';
        try {
          const url = new URL(req.url || '/', 'http://workbench.local');
          root = url.searchParams.get('root') || '';
          boardId = url.searchParams.get('id') || '';
        } catch (error) {
          /* Fall through to the body for POST. */
        }
        if ((root === '' || boardId === '') && req.method === 'POST') {
          root = root || str(body.root);
          boardId = boardId || str(body.id);
        }
        if (root === '') {
          send(400, { error: 'root-required' });
          return;
        }
        await updateRequirementIndex(items =>
          items.filter((item) => item.root !== root || (boardId !== '' && str(item.boardId) !== boardId)),
        );
        send(200, { items: await decorateRequirements(await readRequirementIndex()) });
        return;
      }
      send(405, { error: 'method-not-allowed' });
    } catch (error) {
      send(500, { error: 'requirements-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Create the requirement upload handler. The browser posts raw bytes and the
 * original file name; the Host stores them under `.dsh/uploads/` and returns
 * extracted text for the analysis prompt.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function uploadHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'POST') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    try {
      const root = await projectRoot(ctx, req);
      const rawName = String(req.headers['x-workbench-filename'] || 'requirement');
      let decodedName = rawName;
      try {
        decodedName = decodeURIComponent(rawName);
      } catch (error) {
        /* Keep the raw name when it is not URI-encoded. */
      }
      const safeName = basename(decodedName)
        .replace(/[^\w.\-()（）\u4e00-\u9fa5]+/g, '-')
        .slice(0, 120);
      const ext = extname(safeName).toLowerCase();
      if (!['.md', '.markdown', '.txt', '.docx'].includes(ext)) {
        send(415, { error: 'unsupported-file', message: '只支持 .md、.txt 与 .docx 需求文稿' });
        return;
      }
      const bytes = await readBody(req, MAX_UPLOAD_BYTES);
      if (bytes.length === 0) {
        send(400, { error: 'empty-file', message: '文件内容为空' });
        return;
      }
      let text;
      if (ext === '.docx') {
        const extracted = readDocxText(bytes);
        if (extracted === null) {
          send(400, { error: 'invalid-docx', message: '无法读取这个 DOCX 文件' });
          return;
        }
        text = extracted;
      } else {
        text = bytes.toString('utf8');
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = join(root, '.dsh', 'uploads', `${stamp}-${safeName}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      send(200, {
        name: safeName,
        path: relativePath(root, target),
        text,
        kind: ext === '.docx' ? 'docx' : 'text',
      });
    } catch (error) {
      send(500, { error: 'upload-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Create the Markdown-to-DOCX handler.
 * @param ctx - Host context owning the project root.
 * @returns route handler.
 */
function docxHandler(ctx, fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'POST') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    try {
      const root = await projectRoot(ctx, req);
      const payload = await readJson(req, 16 * 1024);
      const source = await requestedDocument(root, req, str(payload.source));
      const target = await requestedDocument(root, req, str(payload.target));
      if (extname(target).toLowerCase() !== '.docx') {
        send(400, { error: 'invalid-target', message: '目标文件必须以 .docx 结尾' });
        return;
      }
      const markdown = await readFile(source, 'utf8');
      const title = basename(target, '.docx');
      const bytes = buildDocx(markdown, title);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      send(200, {
        path: relativePath(root, target),
        size: bytes.length,
        source: relativePath(root, source),
      });
    } catch (error) {
      const missing = error && error.code === 'ENOENT';
      send(missing ? 404 : 400, {
        error: missing ? 'source-not-found' : 'docx-failed',
        message: String((error && error.message) || error),
      });
    }
  };
}

/**
 * Create the preview probe handler. Only loopback addresses are allowed; this
 * is a convenience check, not a general proxy.
 * @returns route handler.
 */
function probeHandler(fence) {
  return async (req, res) => {
    const send = responder(res);
    if (fence(req, res)) return;
    if (req.method !== 'POST') {
      send(405, { error: 'method-not-allowed' });
      return;
    }
    try {
      const payload = await readJson(req, 32 * 1024);
      const candidates =
        typeof payload.url === 'string' && payload.url !== ''
          ? [payload.url]
          : COMMON_PORTS.map((port) => `http://127.0.0.1:${port}/`);
      for (const candidate of candidates) {
        let url;
        try {
          url = new URL(candidate);
        } catch (error) {
          continue;
        }
        if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) continue;
        try {
          const response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(2500),
            headers: { accept: 'text/html,application/xhtml+xml,*/*' },
          });
          let title = '';
          if (response.ok) {
            const type = response.headers.get('content-type') || '';
            if (type.includes('text/html')) {
              const body = (await response.text()).slice(0, 32_000);
              title = (/<title[^>]*>([^<]*)<\/title>/i.exec(body) || [])[1]?.trim() || '';
            }
            send(200, { ok: true, url: url.toString(), status: response.status, title });
            return;
          }
        } catch (error) {
          /* Try the next candidate. */
        }
      }
      send(200, { ok: false, url: candidates[0] || '', status: 0, title: '' });
    } catch (error) {
      send(400, { error: 'probe-failed', message: String((error && error.message) || error) });
    }
  };
}

/**
 * Register every Workbench route.
 *
 * Routes live in a service-scoped child context rather than the plugin body:
 * they must be registered only while `webServer` exists, follow that service
 * across a restart, and carry the Connection trust fence so an unauthenticated
 * caller can never read project files through them.
 */
const projectQueues = new Map();
function serializedHandler(ctx, handler) {
  return async (req, res) => {
    const key = await projectRoot(ctx, req).catch(() => '__invalid__');
    const previous = projectQueues.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => handler(req, res));
    projectQueues.set(key, operation);
    try { await operation; }
    finally { if (projectQueues.get(key) === operation) projectQueues.delete(key); }
  };
}

export function apply(ctx) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    /** Answer an unauthenticated or untrusted request; true when rejected. */
    const fence = (req, res) => {
      const rejection = webCtx.connection.requestRejection(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    };
    const routes = [
      [ROUTES.state, stateHandler(webCtx, fence)],
      [ROUTES.artifacts, artifactsHandler(webCtx, fence)],
      [ROUTES.review, reviewHandler(webCtx, fence)],
      [ROUTES.knowledge, knowledgeHandler(webCtx, fence)],
      [ROUTES.context, contextHandler(webCtx, fence)],
      [ROUTES.boards, boardsHandler(webCtx, fence)],
      [ROUTES.rounds, roundsHandler(webCtx, fence)],
      [ROUTES.requirements, requirementsHandler(webCtx, fence)],
      [ROUTES.library, libraryHandler(webCtx, fence)],
      [ROUTES.file, fileHandler(webCtx, fence)],
      [ROUTES.raw, rawHandler(webCtx, fence)],
      [ROUTES.upload, uploadHandler(webCtx, fence)],
      [ROUTES.docx, docxHandler(webCtx, fence)],
      [ROUTES.probe, probeHandler(fence)],
    ];
    for (const [path, handler] of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path, handler: serializedHandler(webCtx, handler) }),
        `dsh-workbench: ${path}`,
      );
    }
  });
}

/** Exported for host-side tests; not part of the plugin's public contract. */
export const __test = {
  boardSummary,
  knowledgeHandler,
  contextHandler,
  reviewHandler,
  artifactsHandler,
  serializedHandler,
  emptyState,
  sanitizeState,
  resolveInside,
  readDocxText,
  buildDocx,
  markdownBlocks,
  readZipEntry,
  zipStored,
  scanDocuments,
  contentDisposition,
  requirementEntry,
  roundsHandler,
  boardsHandler,
  stateHandler,
  ensureBoardIndex,
  readBoardIndex,
  readBoard,
  createBoard,
  decorateRequirements,
  readRequirementIndex,
  writeRequirementIndex,
  rememberRequirement,
  requirementsHandler,
  libraryHandler,
  rawHandler,
  fileHandler,
};
