import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TEMPLATES,
  defaultTemplates,
  sectionsFromText,
  splitMarkdownSections,
  composeDeliverable,
  knowledgeTable,
  renderPrintHtml,
  slugify,
} from '../templates.js';

test('every stage has a simplified and a full default template', () => {
  for (const stage of ['spec', 'design', 'build', 'verify', 'ship']) {
    const rows = defaultTemplates(stage);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'default-simple');
    assert.equal(rows[1].id, 'default-full');
    assert.ok(DEFAULT_TEMPLATES[stage].full.length > DEFAULT_TEMPLATES[stage].simple.length);
  }
});

test('a default template carries at least one body section', () => {
  for (const stage of ['spec', 'design', 'build', 'verify', 'ship']) {
    for (const row of defaultTemplates(stage)) {
      assert.ok(row.sections.some((section) => section.body === true), `${stage} ${row.id}`);
    }
  }
});

test('uploaded template headings become sections without hijacking the document body', () => {
  const sections = sectionsFromText('# 论文\n\n## 摘要\n\n## 需求说明\n\n## 验收标准\n');
  assert.deepEqual(sections.map((s) => s.title), ['论文', '摘要', '需求说明', '验收标准']);
  assert.ok(sections.every((s) => s.body === false));
});

test('a template with no headings still gets one body section', () => {
  assert.deepEqual(sectionsFromText('纯文本模板').map((s) => s.title), ['正文']);
});

test('markdown sections split by heading and match by normalized title', () => {
  const map = splitMarkdownSections('# 文档\n\n## 背景与目标\n背景内容\n\n## 需求说明\n说明内容\n');
  assert.equal(map.get('背景与目标'), '背景内容');
  assert.equal(map.get('需求说明'), '说明内容');
  assert.equal(splitMarkdownSections('# 文档\n\n## 1. 背景\n正文\n').get('背景'), '正文');
});

test('compose fills matching sections and marks missing ones', () => {
  const template = {
    id: 't1',
    kind: 'uploaded',
    name: '模板.md',
    sections: [
      { id: 's1', title: '需求说明', body: false },
      { id: 's2', title: '致谢', body: false },
    ],
  };
  const { markdown, title } = composeDeliverable({
    stage: 'spec',
    template,
    documentText: '## 需求说明\n成员提交三件事。\n',
    knowledgeNodes: [],
    projectName: '站会记录',
    date: '2026-11-12',
  });
  assert.equal(title, '需求说明书');
  assert.ok(markdown.includes('## 需求说明'));
  assert.ok(markdown.includes('成员提交三件事。'));
  assert.ok(markdown.includes('本节待补充'));
  assert.ok(markdown.startsWith('# 站会记录 · 需求说明书'));
});

test('compose inserts the whole document for a body section', () => {
  const template = { id: 'default-simple', kind: 'default', name: '简化版', sections: [{ id: 's1', title: '需求说明', body: true }] };
  const doc = '## 目标\nA\n\n## 范围\nB\n';
  const { markdown } = composeDeliverable({ stage: 'spec', template, documentText: doc, knowledgeNodes: [], projectName: 'P', date: 'd' });
  assert.ok(markdown.includes('## 目标\nA'));
  assert.ok(markdown.includes('## 范围\nB'));
});

test('acceptance tabulation comes from knowledge nodes only', () => {
  const table = knowledgeTable([{ id: 'AC-1', type: 'AC', title: '可提交', source: { path: '需求分析阶段.md' } }], 'AC');
  assert.ok(table.includes('| AC-1 | 可提交 | 需求分析阶段.md |'));
  assert.equal(knowledgeTable([], 'AC'), '');
});

test('print view escapes markup and keeps headings', () => {
  const html = renderPrintHtml({ title: '报告', blocks: [{ kind: 'h2', text: '需求 <说明>' }, { kind: 'p', text: 'a & b' }] });
  assert.ok(html.includes('<h2>需求 &lt;说明&gt;</h2>'));
  assert.ok(html.includes('a &amp; b'));
  assert.ok(html.includes('@page'));
});

test('slugs stay filesystem safe', () => {
  assert.equal(slugify('毕业论文 模板.md'), '毕业论文-模板');
  assert.equal(slugify(''), 'deliverable');
});

test('a docx template outline comes from heading styles', async () => {
  const { docxSections } = await import('../templates.js');
  const { zipStored } = await import('../index.js').then((m) => m.__test);
  const xml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>摘要</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>研究背景</w:t></w:r></w:p>
    <w:p><w:r><w:t>普通段落</w:t></w:r></w:p>
  </w:body></w:document>`;
  const bytes = zipStored([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
  const sections = docxSections(bytes);
  assert.deepEqual(sections.map((s) => [s.title, s.level]), [['摘要', 1], ['研究背景', 2]]);
});

test('docx template filling replaces placeholders and keeps the structure', async () => {
  const { fillDocxTemplate } = await import('../templates.js');
  const { zipStored, buildDocx, readDocxText } = await import('../index.js').then((m) => m.__test);
  const templateXml = `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>
    <w:p><w:r><w:t>项目：{{项目名}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>{{正文}}</w:t></w:r></w:p>
  </w:body></w:document>`;
  const template = zipStored([{ name: 'word/document.xml', data: Buffer.from(templateXml) }]);
  const filled = fillDocxTemplate(
    template,
    { fields: { 项目名: '站会记录' }, sections: new Map(), whole: '## 需求\n成员提交三件事。\n' },
    { bodyXml: (markdown) => {
        const body = readDocxText(buildDocx(markdown, 'x'));
        return `<w:p><w:r><w:t>${body.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
      }, zip: zipStored },
  );
  assert.equal(filled.replaced, 2);
  const text = readDocxText(filled.bytes);
  assert.ok(text.includes('项目：站会记录'));
  assert.ok(text.includes('成员提交三件事。'));
  assert.ok(!text.includes('{{'));
});

test('the proposal document has simplified and full defaults', () => {
  const rows = defaultTemplates('proposal');
  assert.equal(rows.length, 2);
  assert.ok(rows[1].sections.some((s) => s.title.includes('研究背景')));
  assert.ok(rows[0].sections.some((s) => s.body === true));
});

test('a body section uses the matching part of the document when it exists', () => {
  const template = { id: 'd', kind: 'default', name: 'd', sections: [{ id: 's', title: '研究背景与意义', body: true }] };
  const doc = '## 研究背景与意义\n背景正文\n\n## 需求说明\n需求正文\n';
  const { markdown } = composeDeliverable({ stage: 'proposal', template, documentText: doc, knowledgeNodes: [], projectName: 'P', date: 'd' });
  assert.ok(markdown.includes('背景正文'));
  assert.ok(!markdown.includes('需求正文'));
});

test('scenarios declare their extra documents and gates', async () => {
  const { SCENARIOS, EXTRA_DOCUMENTS, gateStageFor, TEMPLATE_STAGES } = await import('../templates.js');
  assert.deepEqual(SCENARIOS.thesis.extras, ['proposal', 'thesis', 'defense', 'slides']);
  assert.deepEqual(SCENARIOS.pitch.extras, ['market', 'competitor', 'pitchdeck']);
  assert.deepEqual(SCENARIOS.product.extras, []);
  assert.equal(gateStageFor('proposal'), 'spec');
  assert.equal(gateStageFor('defense'), 'verify');
  assert.equal(gateStageFor('build'), 'build');
  for (const key of Object.keys(EXTRA_DOCUMENTS)) assert.ok(TEMPLATE_STAGES.includes(key));
});

test('every extra document has default templates', async () => {
  const { EXTRA_DOCUMENTS, defaultTemplates } = await import('../templates.js');
  for (const key of Object.keys(EXTRA_DOCUMENTS)) {
    const rows = defaultTemplates(key);
    assert.ok(rows.length >= 1, key);
    assert.ok(rows[0].sections.length >= 3, key);
  }
});

test('a deck prints one slide per section', async () => {
  const { renderPrintHtml } = await import('../templates.js');
  const html = renderPrintHtml({ title: '演示', deck: true, blocks: [{ kind: 'h1', text: '封面' }, { kind: 'h2', text: '一' }, { kind: 'h2', text: '二' }] });
  // Cover plus one slide per section heading.
  assert.equal((html.match(/class="slide"/g) || []).length, 3);
  assert.ok(html.includes('13.33in'));
  assert.ok(html.indexOf('<h1>封面</h1>') < html.indexOf('<h2>一</h2>'));
});

test('long documents stitch requirements, design and test results', async () => {
  const { composeDeliverable, sourcesFor, defaultTemplates } = await import('../templates.js');
  assert.deepEqual(sourcesFor('thesis'), ['需求分析阶段.md', '产品实现设计文档.md', '测试结果.md']);
  const template = defaultTemplates('thesis')[1];
  const { markdown } = composeDeliverable({
    stage: 'thesis',
    template,
    documentTexts: [
      { name: '需求分析阶段.md', text: '## 需求分析\n需求正文\n' },
      { name: '产品实现设计文档.md', text: '## 系统设计\n设计正文\n' },
      { name: '测试结果.md', text: '## 系统测试\n测试正文\n' },
    ],
    knowledgeNodes: [],
    projectName: '项目',
    date: '2026-11-12',
  });
  assert.ok(markdown.includes('需求正文'));
  assert.ok(markdown.includes('设计正文'));
  assert.ok(markdown.includes('测试正文'));
  assert.ok(markdown.includes('资料来源：需求分析阶段.md、产品实现设计文档.md、测试结果.md'));
});

test('the first source wins when two documents share a heading', async () => {
  const { composeDeliverable } = await import('../templates.js');
  const { markdown } = composeDeliverable({
    stage: 'thesis',
    template: { id: 't', kind: 'uploaded', name: 't', sections: [{ id: 's', title: '概述', body: false }] },
    documentTexts: [
      { name: 'a.md', text: '## 概述\n第一份\n' },
      { name: 'b.md', text: '## 概述\n第二份\n' },
    ],
    knowledgeNodes: [],
    projectName: 'P',
    date: 'd',
  });
  assert.ok(markdown.includes('第一份'));
  assert.ok(!markdown.includes('第二份'));
});
