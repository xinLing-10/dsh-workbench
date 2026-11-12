import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePdf,writePptx,pdfFont,exportBlocks } from '../delivery-export.js';
import { zipEntries } from '../templates.js';
const base=await mkdtemp(join(tmpdir(),'dsh-export-tests-'));test.after(()=>rm(base,{recursive:true,force:true}));
const markdown='# 中文演示\n\n## 目标\n\n'+('管家帮助用户整理需求并保留正式交付文档。'.repeat(40))+'\n\n## 表格\n\n| 编号 | 说明 |\n|---|---|\n| AC-001 | 可编辑表格单元格 |\n';
test('PPTX contains editable native text and table, paginates long content',async()=>{
  const path=join(base,'editable.pptx');await writePptx(path,{markdown,title:'中文演示'});
  const entries=zipEntries(await readFile(path));const slides=entries.filter(e=>/^ppt\/slides\/slide\d+\.xml$/.test(e.name));assert.ok(slides.length>2);
  const xml=slides.map(e=>e.data.toString()).join('');assert.ok(xml.includes('管家'));assert.ok(xml.includes('<a:tbl>'));assert.ok(xml.includes('可编辑表格单元格'));assert.ok(!entries.some(e=>e.name.startsWith('ppt/media/') && e.data.length>0));
});
test('local PDF embeds Chinese text/font and reports missing fonts explicitly',{skip:!pdfFont()},async()=>{
  const path=join(base,'document.pdf');await writePdf(path,{markdown,title:'中文演示'});const bytes=await readFile(path);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.toString('latin1').includes('/FontFile2'));
  await assert.rejects(writePdf(join(base,'missing.pdf'),{markdown,title:'中文',font:''}),/中文字体/);
});
test('export parser preserves list labels, table cells and code without running HTML',()=>{
  const blocks=exportBlocks('1. 第一个\n2. 第二个\n\n```sh\necho ok\n```\n\n<script>bad()</script>');assert.ok(blocks.some(b=>b.text==='1. 第一个'));assert.ok(blocks.some(b=>b.text==='2. 第二个'));assert.ok(blocks.some(b=>b.kind==='code'));
});
