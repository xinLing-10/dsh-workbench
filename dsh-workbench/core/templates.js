import { writePdf, writePptx, pdfFont } from './delivery-export.js';
import { sha256 } from './delivery-plan.js';
import { randomUUID } from 'node:crypto';
/**
 * Delivery templates.
 *
 * The five-stage chain keeps producing Markdown (the confirmed content of
 * record). This module adds the layer on top of it: a per-stage template
 * library (built-in simplified/full presets plus uploaded .docx/.md/.txt), a
 * confirmed section skeleton, and a deterministic renderer that produces the
 * delivery files (Markdown, Word, and a print view for PDF).
 *
 * Nothing here changes agent handoffs or the confirmation gates: a deliverable
 * is always rendered from documents the user already confirmed.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile, rename } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { boardDirectory, DOCUMENTS, STAGES, managedPath } from './artifacts.js';

/** @returns every entry of a ZIP archive (stored or deflated), in order. */
export function zipEntries(buffer) {
  let eocd = -1;
  const min = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 DOCX（ZIP）文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX 目录损坏');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressed);
    entries.push({
      name,
      data: method === 0 ? Buffer.from(raw) : inflateRawSync(raw),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Decode the five XML entities Word writes. */
function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Encode text for XML content. */
function encodeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** @returns the visible text of one Word paragraph XML fragment. */
function paragraphText(xml) {
  const parts = [];
  const pattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    parts.push(decodeXml(match[1]));
    match = pattern.exec(xml);
  }
  return parts.join('');
}

/** @returns the paragraph properties of one Word paragraph, or ''. */
function paragraphProps(xml) {
  const match = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(xml);
  return match === null ? '' : match[0];
}

/** @returns the run properties of the first run of one Word paragraph, or ''. */
function runProps(xml) {
  const match = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(xml);
  return match === null ? '' : match[0];
}

/**
 * Fill a real DOCX template.
 *
 * A paragraph whose whole text is `{{正文}}` (or `{{<章节标题>}}`) is replaced by
 * the generated content, so the template keeps its cover, styles, headers and
 * footers. Inline `{{项目名}}` style fields are replaced inside the paragraph.
 *
 * @returns { bytes, replaced, missing }
 */
export function fillDocxTemplate(bytes, { fields = {}, sections = new Map(), whole }, deps) {
  const entries = zipEntries(bytes);
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml');
  if (documentEntry === undefined) throw new Error('DOCX 里没有正文（word/document.xml）');
  let replaced = 0;
  const missing = new Set();
  const xml = documentEntry.data.toString('utf8');
  const bodyXml = whole === undefined || whole === '' ? '' : deps.bodyXml(whole);
  const sectionBodies = new Map([...sections.entries()].map(([title, markdown]) => [title, deps.bodyXml(markdown)]));
  const paragraph = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  const output = xml.replace(paragraph, (fragment) => {
    const text = paragraphText(fragment);
    if (!text.includes('{{')) return fragment;
    const single = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(text.trim());
    if (single !== null) {
      const key = single[1].trim();
      let replacement = '';
      if (key === '正文' || key === '正文内容') replacement = bodyXml;
      else if (sectionBodies.has(key)) replacement = sectionBodies.get(key);
      else if (fields[key] !== undefined) {
        replacement = `<w:p>${paragraphProps(fragment)}<w:r>${runProps(fragment)}<w:t>${encodeXml(String(fields[key]))}</w:t></w:r></w:p>`;
      } else {
        missing.add(key);
        replacement = `<w:p>${paragraphProps(fragment)}<w:r>${runProps(fragment)}<w:t>（本节待补充）</w:t></w:r></w:p>`;
      }
      if (replacement === '') replacement = '<w:p/>';
      replaced += 1;
      return replacement;
    }
    let filled = text;
    for (const [key, value] of Object.entries(fields)) {
      filled = filled.split(`{{${key}}}`).join(String(value));
    }
    const leftover = /\{\{\s*([^{}]+?)\s*\}\}/.exec(filled);
    if (leftover !== null) missing.add(leftover[1].trim());
    replaced += 1;
    return `<w:p>${paragraphProps(fragment)}<w:r>${runProps(fragment)}<w:t xml:space="preserve">${encodeXml(filled)}</w:t></w:r></w:p>`;
  });
  documentEntry.data = Buffer.from(output, 'utf8');
  // Unprocessed header/footer/inline placeholders must also block a formal delivery.
  for(const entry of entries.filter(e=>/^word\/.*\.xml$/.test(e.name))) {
    for(const match of paragraphText(entry.data.toString('utf8')).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g))missing.add(match[1].trim());
  }

  return { bytes: deps.zip(entries), replaced, missing: [...missing] };
}

/** @returns whether a DOCX (or Markdown) text carries template placeholders. */
export function hasPlaceholders(text) {
  return /\{\{\s*[^{}]+?\s*\}\}/.test(String(text || ''));
}

/** @returns the path of a LibreOffice binary, or null. */
export function findSoffice() {
  const candidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/bin/libreoffice',
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch (error) {
      /* Keep looking. */
    }
  }
  return null;
}

/** Convert one DOCX to PDF with LibreOffice; resolves to the PDF path or null. */
export function convertToPdf(soffice, docxPath, directory) {
  return new Promise((resolve) => {
    execFile(
      soffice,
      ['--headless', '--convert-to', 'pdf', '--outdir', directory, docxPath],
      { timeout: 60_000 },
      (error) => resolve(error === null ? docxPath.replace(/\.docx$/i, '.pdf') : null),
    );
  });
}

const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;
const MAX_TEMPLATE_TEXT = 200_000;
const TEMPLATE_EXTENSIONS = ['.docx', '.md', '.txt'];

/** @returns the title the delivery uses for one stage. */
/**
 * The confirmed documents each stage turns into a delivery. Long documents
 * stitch several sources together (requirements + design + test results), in
 * the order listed; earlier sources win when two headings share a name.
 */
export const DELIVERY_SOURCES = {
  spec: ['需求分析阶段.md'],
  design: ['产品实现设计文档.md'],
  build: ['启动文档.md'],
  verify: ['测试结果.md'],
  ship: ['交付清单.md'],
  proposal: ['需求分析阶段.md'],
  thesis: ['需求分析阶段.md', '产品实现设计文档.md', '测试结果.md'],
  defense: ['需求分析阶段.md', '产品实现设计文档.md', '测试结果.md'],
  slides: ['产品实现设计文档.md', '测试结果.md', '需求分析阶段.md'],
  market: ['需求分析阶段.md'],
  competitor: ['需求分析阶段.md'],
  pitchdeck: ['需求分析阶段.md', '产品实现设计文档.md'],
};

/** @returns the source file list for one delivery stage. */
export function sourcesFor(stage) {
  const value = DELIVERY_SOURCES[stage];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Project scenarios. The scenario decides which extra documents the manager
 * offers on top of the five-stage chain; it never changes the chain itself.
 */
export const SCENARIOS = {
  product: {
    title: '产品开发',
    hint: '按五个阶段产出需求、设计、测试与交付文档',
    extras: [],
  },
  thesis: {
    title: '毕业设计',
    hint: '需求确认后额外产出开题报告、毕业论文与答辩材料',
    extras: ['proposal', 'thesis', 'defense', 'slides'],
  },
  pitch: {
    title: '产品概念 / 融资',
    hint: '行业调研、竞品分析与概念演示',
    extras: ['market', 'competitor', 'pitchdeck'],
  },
};

/** Extra documents that are not part of the five-stage chain. */
export const EXTRA_DOCUMENTS = {
  proposal: { title: '开题报告', after: 'spec', hint: '需求确认后可选，基于已确认需求生成' },
  thesis: { title: '毕业论文', after: 'verify', hint: '把已确认的需求、设计与验证整理成论文结构' },
  defense: { title: '答辩文稿', after: 'verify', hint: '按论文/成果整理成可念的答辩稿' },
  slides: { title: '答辩 PPT', after: 'verify', deck: true, hint: '按页生成演示文稿（Markdown/打印版）' },
  market: { title: '行业调研', after: 'spec', hint: '行业规模、趋势与机会点' },
  competitor: { title: '竞品分析', after: 'spec', hint: '主要竞品、定位与差异' },
  pitchdeck: { title: '概念演示', after: 'spec', deck: true, hint: '面向投资人的概念演示（Markdown/打印版）' },
};

/** Stages plus the extra documents a scenario may ask for. */
export const TEMPLATE_STAGES = [...STAGES, ...Object.keys(EXTRA_DOCUMENTS)];

/** @returns whether a template stage is an extra document. */
export function isExtraStage(stage) {
  return Object.prototype.hasOwnProperty.call(EXTRA_DOCUMENTS, stage);
}

/** @returns the stage whose confirmation unlocks one template stage. */
export function gateStageFor(stage) {
  return isExtraStage(stage) ? EXTRA_DOCUMENTS[stage].after : stage;
}

export const DELIVERY_TITLES = {
  proposal: '开题报告',
  thesis: '毕业论文',
  defense: '答辩文稿',
  slides: '答辩演示文稿',
  market: '行业调研报告',
  competitor: '竞品分析报告',
  pitchdeck: '概念演示文稿',
  spec: '需求说明书',
  design: '设计方案',
  build: '制作与运行说明',
  verify: '测试报告',
  ship: '交付清单',
};

/**
 * Built-in templates. `full` follows the usual industry outline; `simple` is
 * the short version for small internal projects. Sections list the document
 * headings a reader expects; `body: true` marks the section that carries the
 * confirmed stage document.
 */
export const DEFAULT_TEMPLATES = {
  spec: {
    simple: [
      { title: '项目概述', body: false },
      { title: '需求说明', body: true },
      { title: '验收标准', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '修订记录', body: false },
      { title: '1 背景与目标', body: true },
      { title: '2 范围与非目标', body: false },
      { title: '3 用户与场景', body: false },
      { title: '4 功能需求', body: false },
      { title: '5 非功能需求', body: false },
      { title: '6 验收标准', body: false },
      { title: '7 假设、依赖与风险', body: false },
      { title: '附录', body: false },
    ],
  },
  design: {
    simple: [
      { title: '设计概述', body: false },
      { title: '详细设计', body: true },
      { title: '实施计划', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 概述', body: true },
      { title: '2 总体架构', body: false },
      { title: '3 模块划分', body: false },
      { title: '4 数据结构', body: false },
      { title: '5 接口契约', body: false },
      { title: '6 交互与状态', body: false },
      { title: '7 异常与权限', body: false },
      { title: '8 部署与运维', body: false },
      { title: '9 变更影响与风险', body: false },
    ],
  },
  build: {
    simple: [
      { title: '环境与依赖', body: false },
      { title: '构建与启动', body: true },
      { title: '已知限制', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 环境与依赖', body: false },
      { title: '2 目录结构', body: false },
      { title: '3 构建与启动', body: true },
      { title: '4 配置项', body: false },
      { title: '5 关键实现说明', body: false },
      { title: '6 已知限制', body: false },
    ],
  },
  verify: {
    simple: [
      { title: '测试范围', body: false },
      { title: '测试结果', body: true },
      { title: '结论与遗留问题', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 测试范围与环境', body: false },
      { title: '2 测试用例', body: false },
      { title: '3 执行结果', body: true },
      { title: '4 缺陷与回归结论', body: false },
      { title: '5 遗留风险', body: false },
    ],
  },
  proposal: {
    simple: [
      { title: '课题名称', body: false },
      { title: '研究背景与意义', body: true },
      { title: '研究内容与目标', body: false },
      { title: '研究方法与技术路线', body: false },
      { title: '进度安排', body: false },
      { title: '预期成果', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 课题名称与来源', body: false },
      { title: '2 研究背景与意义', body: true },
      { title: '3 国内外研究现状', body: false },
      { title: '4 研究内容与目标', body: false },
      { title: '5 研究方法与技术路线', body: false },
      { title: '6 进度安排', body: false },
      { title: '7 预期成果与创新点', body: false },
      { title: '8 参考文献', body: false },
    ],
  },
  thesis: {
    simple: [
      { title: '摘要', body: false },
      { title: '绪论', body: false },
      { title: '需求分析', body: true },
      { title: '系统设计', body: false },
      { title: '实现与测试', body: false },
      { title: '结论与展望', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '摘要与关键词', body: false },
      { title: '1 绪论', body: false },
      { title: '2 需求分析', body: true },
      { title: '3 系统设计', body: false },
      { title: '4 系统实现', body: false },
      { title: '5 系统测试', body: false },
      { title: '6 结论与展望', body: false },
      { title: '参考文献', body: false },
      { title: '致谢', body: false },
    ],
  },
  defense: {
    simple: [
      { title: '开场与课题介绍', body: false },
      { title: '研究内容与目标', body: true },
      { title: '实现与验证结果', body: false },
      { title: '结论与展望', body: false },
    ],
    full: [
      { title: '开场与课题介绍', body: false },
      { title: '研究背景与目标', body: true },
      { title: '方案与实现', body: false },
      { title: '验证结果', body: false },
      { title: '结论与展望', body: false },
      { title: '可能的问题与回答', body: false },
    ],
  },
  slides: {
    simple: [
      { title: '封面：课题与姓名', body: false },
      { title: '背景与问题', body: true },
      { title: '方案与实现', body: false },
      { title: '验证结果', body: false },
      { title: '结论与致谢', body: false },
    ],
    full: [
      { title: '封面：课题与姓名', body: false },
      { title: '研究背景与意义', body: true },
      { title: '目标与范围', body: false },
      { title: '技术方案', body: false },
      { title: '关键实现', body: false },
      { title: '测试与验证', body: false },
      { title: '结论与展望', body: false },
      { title: '致谢', body: false },
    ],
  },
  market: {
    simple: [
      { title: '行业概况', body: false },
      { title: '市场规模与增长', body: false },
      { title: '趋势与机会', body: true },
      { title: '结论与建议', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 行业概况', body: false },
      { title: '2 市场规模与增长', body: false },
      { title: '3 产业链与关键角色', body: false },
      { title: '4 趋势与机会', body: true },
      { title: '5 风险与结论', body: false },
    ],
  },
  competitor: {
    simple: [
      { title: '竞品概览', body: false },
      { title: '功能与定价对比', body: false },
      { title: '差异与机会', body: true },
      { title: '结论', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 竞品概览', body: false },
      { title: '2 功能与体验对比', body: false },
      { title: '3 定价与商业模式', body: false },
      { title: '4 差异与机会', body: true },
      { title: '5 结论与建议', body: false },
    ],
  },
  pitchdeck: {
    simple: [
      { title: '封面：一句话定位', body: false },
      { title: '问题与机会', body: true },
      { title: '解决方案', body: false },
      { title: '市场与竞争', body: false },
      { title: '目标与计划', body: false },
    ],
    full: [
      { title: '封面：一句话定位', body: false },
      { title: '问题', body: true },
      { title: '解决方案', body: false },
      { title: '市场规模', body: false },
      { title: '竞争与差异', body: false },
      { title: '产品与进展', body: false },
      { title: '计划与诉求', body: false },
      { title: '团队', body: false },
    ],
  },
  ship: {
    simple: [
      { title: '交付物清单', body: true },
      { title: '部署与验证', body: false },
      { title: '回滚方案', body: false },
    ],
    full: [
      { title: '封面', cover: true },
      { title: '1 版本信息', body: false },
      { title: '2 交付物清单', body: true },
      { title: '3 部署步骤', body: false },
      { title: '4 验证步骤', body: false },
      { title: '5 回滚方案', body: false },
      { title: '6 联系人', body: false },
    ],
  },
};

/** @returns the built-in template list for a stage, expanded into sections. */
export function defaultTemplates(stage) {
  const entry = DEFAULT_TEMPLATES[stage];
  if (entry === undefined) return [];
  return [
    {
      id: 'default-simple',
      name: '简化版（默认）',
      kind: 'default',
      stage,
      selected: false,
      confirmed: false,
      sections: entry.simple.map((item, index) => ({
        id: `s${index + 1}`,
        title: item.title,
        body: item.body === true,
        cover: item.cover === true,
      })),
    },
    {
      id: 'default-full',
      name: '完整版（参考通行结构）',
      kind: 'default',
      stage,
      selected: false,
      confirmed: false,
      sections: entry.full.map((item, index) => ({
        id: `s${index + 1}`,
        title: item.title,
        body: item.body === true,
        cover: item.cover === true,
      })),
    },
  ];
}

/** @returns the templates directory for one board. */
export function templateDirectory(id, stage) {
  return `${boardDirectory(id)}/templates/${stage}`;
}

/** @returns the board-level template index path. */
function indexFile(id) {
  return `${boardDirectory(id)}/templates/index.json`;
}

async function readIndex(root, id) {
  try {
    const parsed = JSON.parse(await readFile(await managedPath(root, indexFile(id)), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, selected: {}, templates: [] };
  } catch (error) {
    return { version: 1, selected: {}, templates: [] };
  }
}

async function writeIndex(root, id, index) {
  const file = await managedPath(root, indexFile(id));
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

/**
 * Derive a section skeleton from a document's text (Markdown style headings or
 * Word heading paragraphs both survive the text extraction).
 * @returns sections in reading order; an empty list falls back to one body.
 */
export function sectionsFromText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading === null) continue;
    const title = heading[2].trim();
    if (title === '') continue;
    sections.push({ id: `s${sections.length + 1}`, title, level: heading[1].length, body: false, cover: /封面|cover/i.test(title) });
  }
  if (sections.length === 0) return [{ id: 's1', title: '正文', body: true, cover: false }];
  // Uploaded templates carry their own headings: each one is filled by the
  // matching part of the confirmed document, never by the whole document.
  return sections;
}

/**
 * Read the heading outline of a real DOCX template from its paragraph styles,
 * so the confirmation card can list the sections the user will get.
 */
export function docxSections(bytes) {
  const entries = zipEntries(bytes);
  const document = entries.find((entry) => entry.name === 'word/document.xml');
  if (document === undefined) return [];
  const xml = document.data.toString('utf8');
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  const sections = [];
  for (const paragraph of paragraphs) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(paragraph);
    if (style === null) continue;
    const title = paragraphText(paragraph).trim();
    if (title === '' || /^\{\{\s*[^{}]+?\s*\}\}$/.test(title)) continue;
    const match = /(?:heading|Heading|标题|bheading)\s*([1-6])/.exec(style[1]) || /^([1-6])$/.exec(style[1]);
    if (match === null) continue;
    sections.push({
      id: `s${sections.length + 1}`,
      title,
      level: Number(match[1]),
      body: false,
      cover: /封面|cover/i.test(title),
    });
  }
  return sections;
}

/** @returns a safe template id. */
function templateId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Save an uploaded template file and its extracted text.
 * @returns the stored template row.
 */
export async function saveUploadedTemplate(root, id, input, extractors) {
  const stage = TEMPLATE_STAGES.includes(input.stage) ? input.stage : 'spec';
  const filename = basename(String(input.name || 'template'));
  const ext = extname(filename).toLowerCase();
  if (!TEMPLATE_EXTENSIONS.includes(ext)) throw new Error('模板只支持 .docx、.md 或 .txt');
  const bytes = input.bytes;
  if (!bytes || bytes.length === 0) throw new Error('模板文件为空');
  if (bytes.length > MAX_TEMPLATE_BYTES) throw new Error('模板文件超过 8 MB');
  let text = '';
  if (ext === '.docx') {
    text = extractors.docxText(bytes);
    if (text === null) throw new Error('无法读取这个 DOCX 模板');
  } else {
    text = bytes.toString('utf8');
  }
  text = text.slice(0, MAX_TEMPLATE_TEXT);
  const tid = templateId();
  const directory = await managedPath(root, templateDirectory(id, stage));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${tid}${ext}`), bytes);
  const detected = ext === '.docx' ? docxSections(bytes) : [];
  const sections = detected.length > 0 ? detected : sectionsFromText(text);
  const index = await readIndex(root, id);
  const row = {
    id: tid,
    name: filename,
    stage,
    kind: 'uploaded',
    ext: ext.slice(1),
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    text: text.slice(0, 20_000),
    sections,
    createdAt: new Date().toISOString(),
    selected: false,
    confirmed: false,
  };
  index.templates = [row, ...(index.templates || [])].slice(0, 40);
  await writeIndex(root, id, index);
  return row;
}

export function templateFingerprint(row) {
  const {selected,confirmed,confirmedAt,...content}=row;
  return sha256(JSON.stringify(content));
}

/** @returns every selectable template for one board, defaults included. */
export async function listTemplates(root, id) {
  const index = await readIndex(root, id);
  const uploaded = (index.templates || []).filter((row) => TEMPLATE_STAGES.includes(row.stage));
  const selected = index.selected || {};
  const byStage = {};
  for (const stage of TEMPLATE_STAGES) {
    const rows = [
      ...defaultTemplates(stage).map((row) => ({ ...row, selected: (selected[stage] || 'default-simple') === row.id })),
      ...uploaded.filter((row) => row.stage === stage).map((row) => ({ ...row, selected: selected[stage] === row.id })),
    ];
    byStage[stage] = rows;
  }
  const confirmed=Object.fromEntries(Object.entries(index.confirmed || {}).filter(([stage,receipt])=>{const row=byStage[stage]?.find(r=>r.id===receipt.template);return row && receipt.hash===templateFingerprint(row);}));
  return { selected, confirmed, stages: byStage, templates: uploaded };
}

/** Select one template for a stage. */
export async function selectTemplate(root, id, { stage, template }) {
  if (!TEMPLATE_STAGES.includes(stage)) throw new Error('无效的阶段');
  const known = [
    ...defaultTemplates(stage).map((row) => row.id),
    ...(await readIndex(root, id)).templates.filter((row) => row.stage === stage).map((row) => row.id),
  ];
  if (!known.includes(template)) throw new Error('模板不存在');
  const index = await readIndex(root, id);
  index.selected = { ...(index.selected || {}), [stage]: template };
  await writeIndex(root, id, index);
  return listTemplates(root, id);
}

/** Mark one template as confirmed by the user (selected and locked). */
export async function confirmTemplate(root, id, { stage, template }) {
  if (!TEMPLATE_STAGES.includes(stage)) throw new Error('无效的阶段');
  const index = await readIndex(root, id);
  const row = (index.templates || []).find((item) => item.id === template);
  if (!defaultTemplates(stage).some(t=>t.id===template) && (!row || row.stage!==stage)) throw new Error('模板不存在');
  index.selected = { ...(index.selected || {}), [stage]: template };
  if (row !== undefined) {
    row.confirmed = true;
    row.confirmedAt = new Date().toISOString();
  }
  index.confirmed = { ...(index.confirmed || {}), [stage]: { template, hash:templateFingerprint(row || defaultTemplates(stage).find(t=>t.id===template)), at: new Date().toISOString() } };
  await writeIndex(root, id, index);
  return listTemplates(root, id);
}

/** Remove an uploaded template. */
export async function deleteTemplate(root, id, { stage, template }) {
  if (!TEMPLATE_STAGES.includes(stage)) throw new Error('无效的阶段');
  const index = await readIndex(root, id);
  const row = (index.templates || []).find((item) => item.id === template);
  if (row === undefined) throw new Error('模板不存在');
  index.templates = (index.templates || []).filter((item) => item.id !== template);
  if ((index.selected || {})[stage] === template) delete index.selected[stage];
  if ((index.confirmed || {})[stage]?.template === template) delete index.confirmed[stage];
  await writeIndex(root, id, index);
  const directory = await managedPath(root, templateDirectory(id, stage));
  await rm(join(directory, `${template}${row.ext ? `.${row.ext}` : ''}`), { force: true });
  return listTemplates(root, id);
}

/** @returns the confirmed (or selected) template row for one stage. */
export async function templateFor(root, id, stage) {
  const index = await readIndex(root, id);
  const selected = (index.selected || {})[stage] || 'default-simple';
  const uploaded = (index.templates || []).find((row) => row.id === selected && row.stage === stage);
  if (uploaded !== undefined) {
    return { ...uploaded, confirmed: (index.confirmed || {})[stage]?.template === selected && index.confirmed[stage].hash===templateFingerprint(uploaded) };
  }
  const builtin = defaultTemplates(stage).find((row) => row.id === selected) || defaultTemplates(stage)[0];
  return { ...builtin, confirmed: (index.confirmed || {})[stage]?.template === selected && index.confirmed[stage].hash===templateFingerprint(builtin) };
}

/**
 * Split a Markdown document into `##`-level sections so a template heading can
 * be filled with the matching part of the confirmed document.
 * @returns a map from normalized heading text to the section body.
 */
export function splitMarkdownSections(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const map = new Map();
  let current = '';
  let buffer = [];
  const flush = () => {
    if (current !== '') map.set(normalizeHeading(current), buffer.join('\n').trim());
    buffer = [];
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      flush();
      current = heading[1].trim();
      continue;
    }
    if (current === '' && line.trim() === '') continue;
    buffer.push(line);
  }
  flush();
  return map;
}

/** @returns a comparison key for a heading. */
function normalizeHeading(value) {
  return String(value || '')
    .replace(/^[0-9一二三四五六七八九十]+[.、\s]*/, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** @returns the Markdown table for one knowledge type, or ''. */
export function knowledgeTable(nodes, type) {
  const rows = (nodes || []).filter((node) => node.type === type);
  if (rows.length === 0) return '';
  const head = type === 'AC' ? '| 编号 | 验收标准 | 来源 |\n| --- | --- | --- |' : '| 编号 | 内容 | 来源 |\n| --- | --- | --- |';
  const cell = (value) => String(value || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  return [
    head,
    ...rows.map((row) => `| ${cell(row.id)} | ${cell(row.title || row.body)} | ${cell(row.source && row.source.path)} |`),
  ].join('\n');
}

/**
 * Compose the delivery Markdown from a template and the confirmed document.
 * Deterministic: same inputs, same output.
 */
export function composeDeliverable({ stage, template, documentText, documentTexts, knowledgeNodes, projectName, date, preview = false, mappings = {}, strict = false }) {
  const title = DELIVERY_TITLES[stage] || '交付文档';
  const sections = template.sections || [];
  const sources = Array.isArray(documentTexts) && documentTexts.length > 0
    ? documentTexts
    : documentText
      ? [{ name: '', text: documentText }]
      : [];
  const docSections = new Map();
  const candidates=[]; const gaps=[]; const sourceMap=[];
  for (const source of sources) {
    for (const [key, body] of splitMarkdownSections(source.text)) {
      if (!docSections.has(key)) docSections.set(key, body);
      if(body.trim())candidates.push({id:source.name+'::'+key, source:source.name, heading:key, text:body});
    }
  }
  const wholeText = sources.map((source) => source.text.trim()).filter(Boolean).join('\n\n');
  const pending = (section) => (preview
    ? `_（将由已确认文档中的「${section.title}」内容填充）_`
    : '_（本节待补充：确认的阶段文档中没有对应内容）_');
  const out = [`# ${projectName ? `${projectName} · ${title}` : title}`, ''];
  const provenance = sources.map((source) => source.name).filter(Boolean);
  if (provenance.length > 1) out.push(`> 资料来源：${provenance.join('、')}`, '');
  if (sections.some((section) => section.cover)) {
    out.push(`> 项目：${projectName || '（未命名）'}`, `> 文档：${title}`, `> 日期：${date}`, '');
  }
  for (const section of sections) {
    if (section.cover) continue;
    out.push(`## ${section.title}`, '');
    const key = normalizeHeading(section.title);
    const explicit=mappings[section.id || section.title];
    const exact=candidates.filter(c=>c.heading===key);
    const fuzzy=candidates.filter(c=>c.heading.includes(key) || key.includes(c.heading));
    const matches=explicit?candidates.filter(c=>c.id===explicit):(exact.length?exact:fuzzy);
    const picked=matches.length===1?matches[0]:undefined;
    const matchedBody=strict ? picked?.text : docSections.get(key);
    sourceMap.push({section:section.title,id:section.id || section.title,source:picked?.id || '',status:section.body && wholeText?'whole':picked?'matched':matches.length>1?'ambiguous':'missing'});

    if (section.body === true) {
      // A body section prefers the document part with its own heading; only a
      // section without a match carries the whole document.
      if (preview || wholeText === '') { if(!preview)gaps.push({section:section.title,reason:'缺少正文'});out.push(pending(section), ''); }
      else out.push(matchedBody !== undefined && matchedBody !== '' ? matchedBody : wholeText, '');
      continue;
    }
    let filled = strict ? picked?.text : docSections.get(key);
    if (filled === undefined && !strict) {
      for (const [name, body] of docSections) {
        if (name.includes(key) || key.includes(name)) {
          filled = body;
          break;
        }
      }
    }
    if (!preview && filled !== undefined && filled !== '') {
      out.push(filled, '');
      continue;
    }
    if (!preview && /验收标准|acceptance/i.test(section.title)) {
      const table = knowledgeTable(knowledgeNodes, 'AC');
      if (table !== '') {
        out.push(table, '');
        continue;
      }
    }
    if (!preview && /测试用例|cases|TC/i.test(section.title)) {
      const table = knowledgeTable(knowledgeNodes, 'TC');
      if (table !== '') {
        out.push(table, '');
        continue;
      }
    }
    if(!preview)gaps.push({section:section.title,id:section.id || section.title,reason:matches.length>1?'存在多个来源，请选择':'缺少对应的已确认内容'});
    out.push(pending(section), '');
  }
  return { title, gaps, sourceMap, candidates:candidates.map(({text,...c})=>c), markdown: `${out.join('\n').trimEnd()}\n` };
}

/** Escape text for the print view. */
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

/**
 * Render one Markdown block list into a printable HTML document (A4, margins,
 * page breaks before level-2 headings, table styling).
 */
export function renderPrintHtml({ title, blocks, deck = false }) {
  const body = [];
  for (const block of blocks) {
    if (block.kind === 'blank') continue;
    if (/^h[1-6]$/.test(block.kind)) {
      body.push(`<h${block.kind[1]}>${escapeHtml(block.text)}</h${block.kind[1]}>`);
      continue;
    }
    if (block.kind === 'bullet') {
      body.push(`<p class="li">• ${escapeHtml(block.text)}</p>`);
      continue;
    }
    if (block.kind === 'number') {
      body.push(`<p class="li">${escapeHtml(block.text)}</p>`);
      continue;
    }
    if (block.kind === 'quote') {
      body.push(`<blockquote>${escapeHtml(block.text)}</blockquote>`);
      continue;
    }
    if (block.kind === 'code') {
      body.push(`<pre>${escapeHtml(block.text)}</pre>`);
      continue;
    }
    body.push(`<p>${escapeHtml(block.text)}</p>`);
  }
  const pageCss = deck
    ? `@page { size: 13.33in 7.5in; margin: 0; }
body { font-size: 16pt; line-height: 1.6; }
h1 { font-size: 30pt; text-align: left; }
h2 { font-size: 24pt; margin: 0 0 12pt; }
p { font-size: 15pt; }
.slide { padding: 40pt 56pt; box-sizing: border-box; min-height: 7.5in; page-break-after: always; }
.slide:last-child { page-break-after: auto; }
h1 + p, h1 + blockquote { font-size: 16pt; }`
    : `@page { size: A4; margin: 25mm 22mm; }`;
  const inner = body.join('\n');
  const content = deck
    ? `<section class="slide">${inner.replace(/<h2>/g, '</section><section class="slide"><h2>')}</section>`
    : inner;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
${pageCss}
body { font-family: "Songti SC", "SimSun", "Noto Serif CJK SC", serif; font-size: 11pt; line-height: 1.75; color: #111; }
h1 { font-size: 20pt; text-align: center; margin: 0 0 18pt; }
h2 { font-size: 14pt; margin: 18pt 0 8pt; page-break-before: auto; }
h3 { font-size: 12pt; margin: 14pt 0 6pt; }
p { margin: 0 0 8pt; text-align: justify; }
blockquote { margin: 0 0 10pt; padding: 6pt 10pt; border-left: 3px solid #999; color: #444; }
pre { font-family: "SFMono-Regular", Menlo, monospace; font-size: 9.5pt; background: #f4f5f7; padding: 8pt; white-space: pre-wrap; }
.li { margin-left: 14pt; text-indent: -8pt; }
</style></head><body>
${content}
</body></html>
`;
}

/** @returns the delivery directory for one board and stage. */
export function deliveryDirectory(id, stage) {
  return `${boardDirectory(id)}/delivery/${stage}`;
}

/**
 * Render the delivery files for one stage.
 * @returns the file names written (relative to the board directory).
 */
export async function renderDeliverable(root, id, { stage, template, markdown, title, blocks, docx, docxBytes, pdf, deck = false, provenance }) {
  const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
  const relativeDirectory=deliveryDirectory(id,stage)+'/'+runId;
  const directory = await managedPath(root, deliveryDirectory(id,stage)+'/.pending-'+runId);
  const finalDirectory=await managedPath(root,relativeDirectory);
  await mkdir(directory, { recursive: true });
  try {
    const slug = (provenance?.status==='draft'?'草稿-':'')+(template.kind === 'uploaded' ? `${slugify(template.name)}-${template.id.slice(-4)}` : template.id);
    const mdName = `${slug}.md`;
    const docxName = `${slug}.docx`;
    const htmlName = `${slug}.html`;
    await writeFile(join(directory, mdName), markdown, 'utf8');
    await writeFile(join(directory, docxName), docxBytes === undefined ? docx(markdown, title) : docxBytes);
    await writeFile(join(directory, htmlName), renderPrintHtml({ title, blocks, deck }), 'utf8');
    const pdfName = `${slug}.pdf`;
    let converted = false; const warnings=[]; let pdfEngine='';
    if (pdf !== undefined && pdf !== null) {
      const output = await convertToPdf(pdf, join(directory, docxName), directory);
      converted = output !== null && existsSync(join(directory,pdfName));
      if(converted)pdfEngine='libreoffice';
    }
    if(!converted) {
      try {await writePdf(join(directory,pdfName),{markdown,title});converted=true;pdfEngine='local-semantic';if(docxBytes)warnings.push('PDF 使用内容排版，未复刻上传 Word 模板的版式。');}
      catch(error){await rm(join(directory,pdfName),{force:true});warnings.push(String(error.message || error));}
    }
    let pptxName='';
    if(deck){pptxName=`${slug}.pptx`;await writePptx(join(directory,pptxName),{markdown,title});}
    const fileNames=[mdName,docxName,htmlName,...(converted?[pdfName]:[]),...(pptxName?[pptxName]:[])];
    const manifest={...provenance,createdAt:new Date().toISOString(),pdfEngine,warnings,files:await Promise.all(fileNames.map(async name=>({name,sha256:sha256(await readFile(join(directory,name)))})))};
    await writeFile(join(directory,'delivery-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    await rename(directory,finalDirectory);
    return {
      mdName, pptxName, warnings, pdfEngine, manifestPath:relativeDirectory+'/delivery-manifest.json',
      docxName,
      htmlName,
      pdfName: converted ? pdfName : '',
      directory: relativeDirectory,
    };
  } catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
}

/** @returns a filesystem-safe slug. */
export function slugify(value) {
  return String(value || 'deliverable')
    .replace(extname(String(value || '')), '')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'deliverable';
}

/** @returns the delivery files currently on disk for one stage. */
export async function listDeliverables(root, id, stage) {
  const directory = await managedPath(root, deliveryDirectory(id, stage));
  let entries = [];
  try {
    entries = await readdir(directory);
  } catch (error) {
    return [];
  }
  const files=[];
  const visit=async(directoryPath,relativePath,depth)=>{
    const rows=await readdir(directoryPath,{withFileTypes:true});
    for(const row of rows) {
      if(row.isDirectory() && !row.name.startsWith('.') && depth===0){const sub=await managedPath(root,relativePath+'/'+row.name);await visit(sub,relativePath+'/'+row.name,1);}
      else if(row.isFile() && (/\.(md|docx|html|pdf|pptx)$/i.test(row.name) || row.name==='delivery-manifest.json'))files.push({name:row.name,path:relativePath+'/'+row.name,kind:extname(row.name).slice(1).toLowerCase(),version:depth?relativePath.split('/').pop():'旧版'});
    }
  };
  await visit(directory,deliveryDirectory(id,stage),0);
  return files.sort((a,b)=>b.path.localeCompare(a.path));
}
