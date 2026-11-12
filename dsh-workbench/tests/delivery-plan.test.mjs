import { approvedSources, sha256 } from '../delivery-plan.js';
import { composeDeliverable } from '../templates.js';
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
  const routes = Object.fromEntries(['state', 'boards', 'rounds', 'file', 'raw', 'library', 'artifacts', 'review', 'knowledge', 'context', 'templates'].map(
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

test('delivery preflight, formal blocking, explicit drafts and immutable provenance',async()=>{
  const f=await fixture();await f.fill();await f.confirm('spec');
  let result=await f.call('templates',{method:'POST',body:{action:'confirm',stage:'spec',template:'default-full'}});assert.equal(result.status,200);
  result=await f.call('templates',{method:'POST',body:{action:'preflight',stage:'spec'}});assert.equal(result.status,200);assert.ok(result.json.report.gaps.length);
  result=await f.call('templates',{method:'POST',body:{action:'render',stage:'spec'}});assert.equal(result.status,409);
  result=await f.call('templates',{method:'POST',body:{action:'render',stage:'spec',draft:true}});assert.equal(result.status,200,JSON.stringify(result.json));
  const manifest=JSON.parse(await readFile(join(f.root,result.json.files.manifestPath),'utf8'));assert.equal(manifest.status,'draft');assert.ok(manifest.sources[0].approvalId);
  for(const file of manifest.files)assert.equal(sha256(await readFile(join(f.root,result.json.files.directory,file.name))),file.sha256);
  const originalDirectory=result.json.files.directory;
  const next=await f.call('templates',{method:'POST',body:{action:'render',stage:'spec',draft:true}});assert.notEqual(next.json.files.directory,originalDirectory);
  await writeFile(join(f.root,f.initial.artifactStorage.directory,'documents','需求分析阶段.md'),'changed after approval');
  const changed=await f.call('templates',{method:'POST',body:{action:'render',stage:'spec',draft:true}});assert.equal(changed.status,400);
});
test('strict source mapping refuses ambiguous same headings and accepts explicit selection',()=>{
  const input={stage:'thesis',template:{sections:[{id:'intro',title:'概述'}]},documentTexts:[{name:'a.md',text:'## 概述\n第一份'},{name:'b.md',text:'## 概述\n第二份'}],strict:true,knowledgeNodes:[]};
  let result=composeDeliverable(input);assert.equal(result.gaps.length,1);assert.ok(!result.markdown.includes('第一份'));
  result=composeDeliverable({...input,mappings:{intro:'b.md::概述'}});assert.equal(result.gaps.length,0);assert.ok(result.markdown.includes('第二份'));assert.ok(!result.markdown.includes('第一份'));
});
test('snapshot resolver verifies approval identity and snapshot integrity',async()=>{
  const f=await fixture();await f.fill();const confirmed=await f.confirm('spec');const state=confirmed.json.state;
  let result=await approvedSources(f.root,f.id,state,['需求分析阶段.md']);assert.equal(result.sources.length,1);
  const artifact=confirmed.json.approval.artifacts.find(a=>a.name==='需求分析阶段.md');await writeFile(join(f.root,artifact.snapshot),'tampered');
  await assert.rejects(approvedSources(f.root,f.id,state,['需求分析阶段.md']),/快照校验失败/);
});
test('formal delivery succeeds only with approved complete content and retains exact provenance',async()=>{
  const f=await fixture();await f.fill();
  const markdown='## 项目概述\n帮助门店预约。\n\n## 需求说明\n用户选择服务和时间。\n\n## 验收标准\n预约成功后显示确认。';
  await writeFile(join(f.root,f.initial.artifactStorage.directory,'documents','需求分析阶段.md'),markdown);await f.confirm('spec');
  await f.call('templates',{method:'POST',body:{action:'confirm',stage:'spec',template:'default-simple'}});
  let result=await f.call('templates',{method:'POST',body:{action:'preflight',stage:'spec'}});assert.equal(result.json.report.canFinalize,true);
  result=await f.call('templates',{method:'POST',body:{action:'render',stage:'spec'}});assert.equal(result.status,200,JSON.stringify(result.json));
  const manifest=JSON.parse(await readFile(join(f.root,result.json.files.manifestPath),'utf8'));assert.equal(manifest.status,'final');assert.equal(manifest.sources[0].contentHash,sha256(markdown));assert.equal(manifest.gaps.length,0);
});
