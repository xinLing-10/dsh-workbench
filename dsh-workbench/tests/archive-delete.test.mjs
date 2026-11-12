import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { __test as host } from '../index.js';

const base = await mkdtemp(join(tmpdir(), 'dsh-archive-delete-'));
process.env.DSH_HOME = join(base, 'home');
test.after(() => rm(base, { recursive: true, force: true }));
const handler = host.requirementsHandler({}, () => false);
async function call(body, { method = 'POST', query = '' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url: '/workbench/requirements' + query, headers: {} });
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  res.setHeader = () => {}; res.writeHead = code => { res.statusCode = code; };
  const done = new Promise(resolve => res.on('finish', resolve));
  await handler(req, res); await done;
  return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) };
}
const record = (root, boardId) => ({ root, boardId, name: boardId || 'legacy' });
const batch = items => ({ action: 'remove-many', items });

test('bulk removal uses exact identities across projects and preserves files',async()=>{
  const a=join(base,'a'), b=join(base,'b');
  for(const root of [a,b]){await mkdir(root);await writeFile(join(root,'需求.md'),'keep');}
  const rows=[record(a,'one'),record(a,'two'),record(b,'one')];
  await host.writeRequirementIndex(rows);
  const result=await call(batch([rows[0],rows[2],rows[0]]));
  assert.equal(result.status,200);assert.equal(result.body.removed,2);
  assert.deepEqual((await host.readRequirementIndex()).map(r=>r.boardId),['two']);
  for(const root of [a,b])assert.equal(await readFile(join(root,'需求.md'),'utf8'),'keep');
});

test('selecting a legacy row without board ID cannot remove other rounds in its project',async()=>{
  const rows=[record(join(base,'legacy'),''),record(join(base,'legacy'),'round-two')];
  await host.writeRequirementIndex(rows);
  await call(batch([rows[0]]));
  assert.deepEqual((await host.readRequirementIndex()).map(r=>r.boardId),['round-two']);
});

test('select-all snapshot keeps records added afterwards and repeated deletion is harmless',async()=>{
  const selected=[record('/project/a','one'),record('/project/b','two')];
  await host.writeRequirementIndex([...selected,record('/project/c','new')]);
  const first=await call(batch(selected));assert.equal(first.body.removed,2);
  const second=await call(batch(selected));assert.equal(second.body.removed,0);
  assert.equal((await host.readRequirementIndex())[0].boardId,'new');
});

test('malformed and oversized selections cannot partly mutate the archive',async()=>{
  const row=record('/project/a','one');await host.writeRequirementIndex([row]);
  for(const body of [null,batch([]),batch([row,{root:'relative',boardId:'bad'}]),batch(Array(201).fill(row)),{action:'unknown'}]){
    assert.equal((await call(body)).status,400);
    assert.deepEqual(await host.readRequirementIndex(),[row]);
  }
});

test('concurrent archive deletions do not overwrite each other',async()=>{
  const rows=[record('/project/a','one'),record('/project/b','two'),record('/project/c','keep')];
  await host.writeRequirementIndex(rows);
  const results=await Promise.all([call(batch([rows[0]])),call(batch([rows[1]]))]);
  assert.ok(results.every(r=>r.status===200));
  assert.deepEqual((await host.readRequirementIndex()).map(r=>r.boardId),['keep']);
});

test('legacy single-record DELETE remains supported',async()=>{
  const row=record('/project/a','one');await host.writeRequirementIndex([row]);
  const result=await call(undefined,{method:'DELETE',query:'?root=%2Fproject%2Fa&id=one'});
  assert.equal(result.status,200);assert.equal((await host.readRequirementIndex()).length,0);
});
