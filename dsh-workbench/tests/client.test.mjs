import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function client(fetcher = async () => { throw new Error('Unexpected request'); }, reactOverrides = {}) {
  let factory;
  const timers = new Map(); let nextTimer = 0;
  const React = { Component: class {}, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState: (initial) => [initial, () => {}], ...reactOverrides };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: (module) => { factory = module.factory; } } },
    console, fetch: fetcher, crypto: { randomUUID: () => 'test-id' },
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id), setInterval: () => 1, clearInterval: () => {},
    URL, AbortController,
  });
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8')).replace(
    "    return {\n      inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'layout'],", "    globalThis.testClient = { ManagerSetup, managerModePreference, managerApprovalReason, ManagerResultsSheet, supportsManagerPresentation, ManagerActionCard, Button, useToast, disabledToastListeners, workbenchStore, managerBlocks, proposalLines, projectContext, buildStagePrompt, requirementKey, removeRequirementRecords, requirementName, stageGuidance, personaQueue, TaskGuide, PersonaCard, ArtifactReviewPanel, stageStatus, copyFor, apiFetch, paragraphAnchors, buildReviewFeedback, ConversationDock, DiffView, sendContextPrompt };\n    return {\n      inject: ['slots', 'locale', 'uiWorkspace', 'sessions', 'layout'],");
  assert.ok(source.includes('globalThis.testClient'), 'client test seam inserted');
  vm.runInContext(source, context);
  factory((name) => { if (name === 'react') return React; throw new Error(name); });
  return context.testClient;
}

function state(id = 'board-one') {
  return { boardId: id, version: 3, stateRevision: 1, flow: 'new',
    artifactStorage: { version: 1, directory: `.dsh/workbench/changes/${id}`, warning: '' },
    project: { name: 'Example', goal: 'Demo' }, stageData: {} };
}

test('all stage prompts contain explicit board-owned document paths', async () => {
  const c = await client(); c.workbenchStore.adopt(state());
  for (const stage of ['spec', 'design', 'build', 'verify', 'ship']) {
    const prompt = c.buildStagePrompt(c.workbenchStore.get(), stage);
    assert.match(prompt, /\.dsh\/workbench\/changes\/board-one\/documents\/需求交接.md/);
    assert.match(prompt, /不得读取其他轮次/);
  }
});

test('autosave and document requests carry exact board identity', async () => {
  const calls = [];
  const c = await client(async (url, options) => {
    calls.push({ url, options });
    const data = options.method === 'PUT' ? JSON.parse(options.body) : {};
    return { ok: true, json: async () => ({ ...data, stateRevision: 2 }) };
  });
  c.workbenchStore.adopt(state());
  c.workbenchStore.patchProject({ name: 'Changed' });
  await c.workbenchStore.flush();
  await c.apiFetch('/workbench/file?path=需求交接.md');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers['x-workbench-board'], 'board-one');
  assert.equal(calls[1].options.headers['x-workbench-board'], 'board-one');
  assert.equal(c.workbenchStore.get().stateRevision, 2);
});

test('an edit during an in-flight save is preserved and flushed with the new revision', async () => {
  let release; let count = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const submitted = [];
  const c = await client(async (url, options) => {
    const data = JSON.parse(options.body); submitted.push(data);
    if (++count === 1) await pending;
    return { ok: true, json: async () => ({ ...data, stateRevision: data.stateRevision + 1 }) };
  });
  c.workbenchStore.adopt(state());
  c.workbenchStore.patchProject({ name: 'First' });
  const save = c.workbenchStore.flush();
  c.workbenchStore.patchProject({ name: 'Second' });
  release(); await save;
  assert.equal(submitted.length, 2);
  assert.equal(submitted[1].stateRevision, 2);
  assert.equal(c.workbenchStore.get().project.name, 'Second');
  assert.equal(c.workbenchStore.get().stateRevision, 3);
});

test('server invalidation updates review status without replacing a local draft', async () => {
  const c = await client(); c.workbenchStore.adopt(state());
  c.workbenchStore.patchProject({ goal: 'Unsaved draft' });
  const server = JSON.parse(JSON.stringify(c.workbenchStore.get()));
  server.stageData.spec.needsReview = true;
  server.stateRevision = 2; server.reviewRevisionBase = 1;
  c.workbenchStore.applyReview({ boardId: 'board-one', state: server });
  assert.equal(c.workbenchStore.get().project.goal, 'Unsaved draft');
  assert.equal(c.workbenchStore.get().stateRevision, 2);
  assert.equal(c.stageStatus(c.workbenchStore.get(), 'spec'), 'review');
});

test('review polling cannot authorize overwriting an unrelated newer save', async () => {
  const c = await client(); c.workbenchStore.adopt(state());
  const server = JSON.parse(JSON.stringify(c.workbenchStore.get()));
  server.stageData.spec.needsReview = true; server.stateRevision = 9;
  c.workbenchStore.applyReview({ boardId: 'board-one', state: server });
  assert.equal(c.workbenchStore.get().stateRevision, 1);
});

test('review panel renders current hashes, stale warning and downloadable historical versions', async () => {
  const c = await client(); c.workbenchStore.adopt(state());
  const s = c.workbenchStore.get(); s.stageData.spec.needsReview = true;
  const tree = c.ArtifactReviewPanel({ state: s, stage: 'spec', localeId: 'zh',
    review: { phase: 'ready', data: { boardId: s.boardId, stages: { spec: { hashes: { '需求分析阶段.md': 'abcdef1234567890' } } },
      history: [{ id: 'receipt', stage: 'spec', confirmedAt: '2026-11-12T00:00:00Z', artifacts: [{ name: '需求分析阶段.md', revision: 2, contentHash: 'abc', snapshot: 'path' }] }] } },
    onRefresh: () => {}, showToast: () => {} });
  const text = JSON.stringify(tree);
  assert.match(text, /原确认已失效/);
  assert.match(text, /abcdef123456/);
  assert.match(text, /v2/);
});


test('paragraph anchors retain exact source lines for paragraphs, lists, tables and fenced code', async () => {
  const c = await client();
  const text = '# Title\n\nParagraph one.\nSecond line.\n\n```js\n\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
  const anchors = c.paragraphAnchors(text);
  assert.equal(anchors.length, 4);
  assert.equal(anchors[1].startLine, 3); assert.equal(anchors[1].endLine, 4);
  assert.equal(anchors[2].quote, '```js\n\nconst a = 1;\n```');
  for (const anchor of anchors) assert.equal(text.split('\n').slice(anchor.startLine - 1, anchor.endLine).join('\n'), anchor.quote);
});

test('review feedback includes stable references, version and only unresolved comments', async () => {
  const c = await client();
  const data = { name: '需求分析阶段.md', contentHash: 'hash', comments: [
    { id: 'open', status: 'open', stale: true, anchor: { startLine: 3, endLine: 4, quote: 'old text' }, text: 'Please clarify' },
    { id: 'done', status: 'resolved', anchor: { startLine: 5, endLine: 5, quote: 'done' }, text: 'Resolved issue' },
  ] };
  const prompt = c.buildReviewFeedback(data, '.dsh/workbench/changes/board-one');
  assert.match(prompt, /reviews.json/); assert.match(prompt, /hash/); assert.match(prompt, /L3–4/);
  assert.match(prompt, /引用旧版本/); assert.match(prompt, /不要自行确认阶段或标记评论已解决/);
  assert.doesNotMatch(prompt, /Resolved issue/);
});

test('conversation dock remains a dedicated sibling without document/preview switches', async () => {
  const c = await client();
  const tree = c.ConversationDock({ state: { ...state(), round: 2 }, localeId: 'zh', copy: c.copyFor('zh'), stage: 'spec', chatPane: 'native-chat', onOpenSession: () => {}, hasSession: true });
  assert.equal(tree.type, 'aside');
  const text = JSON.stringify(tree);
  assert.match(text, /native-chat/); assert.doesNotMatch(text, /dshwb-dockTabs/);
  assert.match(text, /当前需求：Example · 第 2 轮/);
  const switched = c.ConversationDock({ state: { ...state('other-board'), project: { name: '设备分类统计' }, round: 3 }, localeId: 'zh', copy: c.copyFor('zh'), stage: 'build', hasSession: false });
  assert.match(JSON.stringify(switched), /当前需求：设备分类统计 · 第 3 轮/);
  assert.doesNotMatch(JSON.stringify(switched), /Example/);
});

test('diff view exposes change signs, line numbers and truncation notice', async () => {
  const c = await client();
  const tree = c.DiffView({ en: false, diff: { added: 2, removed: 1, simplified: false, truncated: true,
    rows: [{ kind: 'remove', oldLine: 4, newLine: null, text: 'old' }, { kind: 'add', oldLine: null, newLine: 4, text: 'new' }] } });
  const text = JSON.stringify(tree);
  assert.match(text, /dshwb-diff-add/); assert.match(text, /dshwb-diff-remove/); assert.match(text, /2500/);
});


test('workbench delivery builds persisted context and appends it before sending a stage task', async () => {
  const calls = []; let delivered;
  const c = await client(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ boardId: 'board-one', prompt: 'VERSIONED CONTEXT', id: 'ctx' }) };
  });
  c.workbenchStore.adopt(state());
  await c.sendContextPrompt(async (text, options) => { delivered = { text, options }; }, 'Start design', { stage: 'spec' });
  assert.equal(calls[0].url, '/workbench/context');
  assert.equal(calls[0].body.stage, 'spec');
  assert.match(delivered.text, /VERSIONED CONTEXT/);
  assert.match(delivered.text, /必要资料被排除或缺失/);
  assert.equal(delivered.options.stage, 'spec');
});

test('context build errors prevent delivery instead of silently falling back to incomplete handoff', async () => {
  let sent = false;
  const c = await client(async () => ({ ok: false, json: async () => ({ message: 'Missing prerequisite' }) }));
  c.workbenchStore.adopt(state());
  await assert.rejects(c.sendContextPrompt(async () => { sent = true; }, 'task', { stage: 'design' }), /Missing prerequisite/);
  assert.equal(sent, false);
});

test('switching boards during context construction stops stale task delivery', async () => {
  let release; const wait = new Promise((resolve) => { release = resolve; }); let sent = false;
  const c = await client(async () => { await wait; return { ok: true, json: async () => ({ boardId: 'board-one', prompt: 'old' }) }; });
  c.workbenchStore.adopt(state());
  const pending = c.sendContextPrompt(async () => { sent = true; }, 'task', { stage: 'spec' });
  await new Promise((resolve) => setImmediate(resolve));
  c.workbenchStore.adopt(state('board-two')); release();
  await assert.rejects(pending, /看板已切换/); assert.equal(sent, false);
});

test('a missing Host context route gives restart guidance and never sends a task', async () => {
  let sent = false;
  const c = await client(async () => new Response(null, { status: 404 }));
  c.workbenchStore.adopt(state());
  await assert.rejects(c.sendContextPrompt(async () => { sent = true; }, 'task', { stage: 'spec' }), /后端接口未就绪.*workbench\/context.*重启 DSH Host/);
  assert.equal(sent, false);
});

test('empty authentication rejections give connection guidance rather than JSON errors', async () => {
  for (const status of [401, 403]) {
    const c = await client(async () => new Response(null, { status }));
    c.workbenchStore.adopt(state());
    await assert.rejects(c.sendContextPrompt(async () => assert.fail('must not deliver'), 'task', { stage: 'spec' }), /登录|拒绝访问/);
  }
});

test('empty success and non-JSON server errors stop context delivery with useful diagnostics', async () => {
  for (const [status, body] of [[200, null], [502, '<html>Bad gateway</html>']]) {
    const c = await client(async () => new Response(body, { status }));
    c.workbenchStore.adopt(state());
    await assert.rejects(c.sendContextPrompt(async () => assert.fail('must not deliver'), 'task', { stage: 'spec' }), /空响应或无效 JSON.*workbench\/context/);
  }
});

test('an empty autosave response retains the draft and can be retried before context delivery', async () => {
  let saveCount = 0; let contextCount = 0; let sent = false;
  const c = await client(async (url, options) => {
    if (url === '/workbench/state') {
      if (++saveCount === 1) return new Response(null, { status: 200 });
      const data = JSON.parse(options.body);
      return Response.json({ ...data, stateRevision: 2 });
    }
    contextCount++;
    return Response.json({ boardId: 'board-one', prompt: 'context' });
  });
  c.workbenchStore.adopt(state());
  c.workbenchStore.patchProject({ name: 'Unsaved draft' });
  await assert.rejects(c.sendContextPrompt(async () => { sent = true; }, 'task', { stage: 'spec' }), /空响应或无效 JSON.*workbench\/state/);
  assert.equal(c.workbenchStore.get().project.name, 'Unsaved draft');
  assert.equal(c.workbenchStore.getMeta().save, 'local');
  assert.equal(contextCount, 0);
  assert.equal(sent, false);
  await c.sendContextPrompt(async () => { sent = true; }, 'task', { stage: 'spec' });
  assert.equal(saveCount, 2);
  assert.equal(contextCount, 1);
  assert.equal(sent, true);
});

test('a JSON context response without prompt content cannot send an incomplete task', async () => {
  const c = await client(async () => Response.json({ boardId: 'board-one' }));
  c.workbenchStore.adopt(state());
  await assert.rejects(c.sendContextPrompt(async () => assert.fail('must not deliver'), 'task', { stage: 'spec' }), /上下文缺少有效内容/);
});


test('guidance follows the first unconfirmed stage rather than the stage being browsed',async()=>{
 const c=await client();c.workbenchStore.adopt(state());const value=c.workbenchStore.get();
 value.stageData.spec.confirmed=true;value.stage='ship';
 assert.equal(c.stageGuidance(value,'ship',false).current,'design');
 assert.equal(c.stageGuidance(value,'ship',false).phase,'return');
 assert.equal(c.stageGuidance(value,'design',false).phase,'start');
 value.stageData.design.startedAt='2026-11-12T00:00:00Z';
 assert.equal(c.stageGuidance(value,'design',true).phase,'running');
 assert.equal(c.stageGuidance(value,'design',false).phase,'review');
 for(const item of Object.values(value.stageData))item.confirmed=true;
 assert.equal(c.stageGuidance(value,'ship',false).phase,'complete');
});

test('every task and modification carries the requirement name and plugin read-only invariant',async()=>{
 const c=await client();c.workbenchStore.adopt(state());const value=c.workbenchStore.get();
 assert.equal(c.requirementName(value),'Example');
 for(const stage of ['spec','design','build','verify','ship']){
  const prompt=c.buildStagePrompt(value,stage);
  assert.match(prompt,/Example · 具体工作/);assert.match(prompt,/不得修改工作台插件本体/);
 }
 value.project.name='';value.project.goal='按分类查找资料\n详细描述';
 assert.equal(c.requirementName(value),'按分类查找资料');
 value.project.goal='';assert.doesNotMatch(c.requirementName(value),/board-one/);
});

test('each agent queue shows ready and upstream requirements in order without changing stages',async()=>{
 const c=await client();
 const boards=[{id:'late',name:'后续需求',round:2,confirmed:1},{id:'first',name:'当前需求',round:1,confirmed:1},{id:'upstream',name:'需求草稿',round:3,confirmed:0},{id:'done',round:1,confirmed:2}];
 assert.deepEqual(Array.from(c.personaQueue({boards},1),item=>item.id),['first','late','upstream']);
});


test('bulk removal sends explicit board identities including legacy records without root wildcard',async()=>{
 let request;
 const c=await client(async(url,options)=>{request={url,options};return Response.json({removed:2,items:[]});});
 const a={root:'/project/#a',boardId:'one'},b={root:'/project',boardId:'#a#one'};
 assert.notEqual(c.requirementKey(a),c.requirementKey(b));
 await c.removeRequirementRecords([a,{root:'/project'}]);
 assert.equal(request.options.method,'POST');
 const body=JSON.parse(request.options.body);
 assert.equal(body.action,'remove-many');assert.equal(body.items[1].boardId,'');
 assert.deepEqual(body.items[0],a);
});

test('a manager reply becomes headings, lists and short paragraphs', async () => {
  const c = await client();
  const blocks = c.managerBlocks('**第一版安排**\n\n1. 用途：记录日记。\n2. 图片：可上传。\n\n请问你希望支持多张图片吗？\n\n其余内容按假设先写好，后面可以再改。');
  assert.equal(JSON.stringify(blocks.map((b) => b.kind)), JSON.stringify(['heading', 'list', 'question', 'para']));
  assert.equal(blocks[1].ordered, true);
  assert.equal(JSON.stringify(blocks[1].items), JSON.stringify(['用途：记录日记。', '图片：可上传。']));
  assert.equal(blocks[2].text, '请问你希望支持多张图片吗？');
});

test('a wall of text is split into sentence groups', async () => {
  const c = await client();
  const long =
    '第一句说明这个项目要解决的问题和背景，以及它为什么现在做。' +
    '第二句说明本次范围包括哪些功能、不包括哪些内容，边界在哪里。' +
    '第三句说明验收标准与如何判断做完，包括必须通过哪些检查。' +
    '第四句说明已知风险、依赖和后续计划，便于评审时逐条核对。';
  const blocks = c.managerBlocks(long);
  assert.ok(blocks.length >= 2, 'expected the paragraph to be split');
  assert.ok(blocks.every((b) => b.kind === 'para'));
  assert.ok(blocks.every((b) => b.text.length < long.length));
});

test('a suggested instruction is split into readable clauses', async () => {
  const c = await client();
  const lines = c.proposalLines('整理日记本需求说明书：支持文字与图片；数据存在本地；明确暂不包含多用户。产出 Markdown 与 Word。');
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.endsWith('。')));
  assert.equal(c.proposalLines('只有一句话').length, 0);
});


test('disabled actions explain requirements without executing or submitting, including repeated clicks',async()=>{
  const c=await client();const messages=[];let runs=0,prevented=0,stopped=0;
  c.disabledToastListeners.add((message,kind)=>messages.push({message,kind}));
  const button=c.Button({disabled:true,disabledReason:'请先确认模板。',type:'submit',onClick:()=>runs++,children:'生成'});
  assert.equal(button.props['aria-disabled'],true);assert.equal(button.props.disabled,undefined);assert.equal(button.props.type,'button');assert.equal(button.props.title,'请先确认模板。');
  for(let i=0;i<2;i++)button.props.onClick({preventDefault:()=>prevented++,stopPropagation:()=>stopped++});
  assert.equal(runs,0);assert.equal(prevented,2);assert.equal(stopped,2);assert.equal(messages.length,2);assert.equal(messages[0].message,'请先确认模板。');
});
test('enabled actions keep submit behavior, custom classes and accessibility labels',async()=>{
  const c=await client();let runs=0;const button=c.Button({disabled:false,type:'submit',className:'custom-action','aria-label':'保存',onClick:()=>runs++,children:'保存'});
  assert.equal(button.props.type,'submit');assert.equal(button.props['aria-disabled'],undefined);assert.equal(button.props.className,'custom-action');assert.equal(button.props['aria-label'],'保存');button.props.onClick({});assert.equal(runs,1);
});

test('disabled-action toast subscribes once, refreshes on repeated clicks and cleans up on unmount',async()=>{
  const effects=[],updates=[];
  const c=await client(undefined,{useState:()=>[null,value=>updates.push(value)],useRef:()=>({current:null}),useCallback:fn=>fn,useEffect:fn=>effects.push(fn)});
  c.useToast();const cleanups=effects.map(effect=>effect());assert.equal(c.disabledToastListeners.size,1);
  const button=c.Button({disabled:true,disabledReason:'请先填写目标。'});const event={preventDefault(){},stopPropagation(){}};
  button.props.onClick(event);button.props.onClick(event);assert.equal(updates.length,2);assert.equal(updates[1].message,'请先填写目标。');assert.notEqual(updates[0],updates[1]);
  cleanups.forEach(cleanup=>cleanup?.());assert.equal(c.disabledToastListeners.size,0);button.props.onClick(event);assert.equal(updates.length,2);
});

test('simple mode rejects unknown presentation versions and unsafe action kinds',async()=>{
 const c=await client();const valid={schemaVersion:1,revision:2,title:'请阅读',description:'说明',blockingReasons:[],primaryAction:{kind:'open_review',label:'查看'},secondaryActions:[]};assert.equal(c.supportsManagerPresentation(valid),true);assert.equal(c.supportsManagerPresentation({...valid,schemaVersion:2}),false);assert.equal(c.supportsManagerPresentation({...valid,primaryAction:{kind:'approve'}}),false);assert.equal(c.supportsManagerPresentation({...valid,secondaryActions:[{kind:'run_shell'}]}),false);
});
test('action card only forwards the bound read intent and revision',async()=>{
 const c=await client();const calls=[];const p={schemaVersion:1,revision:7,phase:'needs_review',title:'请阅读',description:'核对成果',primaryAction:{kind:'open_review',stage:'spec',label:'查看成果'},secondaryActions:[],blockingReasons:[]};
 const card=c.ManagerActionCard({presentation:p,busy:false,onAction:(...args)=>calls.push(args)});
 const nodes=[];const walk=n=>{if(!n || typeof n!=='object')return;nodes.push(n);(n.props?.children || []).flat(Infinity).forEach(walk);};walk(card);
 const button=nodes.find(n=>n.type===c.Button);assert.ok(button);button.props.onClick();assert.equal(calls[0][0].kind,'open_review');assert.equal(calls[0][1],7);
});

test('simple review retains explicit read, missing-file and implementation-check gates',async()=>{
 const c=await client();const input={locked:false,lockedReason:'处理中',missing:[],reviewed:true,stage:'build',checks:['one'],buildChecks:[{id:'one'},{id:'two'}]};
 assert.match(c.managerApprovalReason(input),/实现检查/);assert.match(c.managerApprovalReason({...input,stage:'spec',missing:['原稿.md']}),/原稿/);assert.match(c.managerApprovalReason({...input,stage:'spec',reviewed:false}),/我已阅读/);assert.equal(c.managerApprovalReason({...input,checks:['one','two']}),'');assert.equal(c.managerApprovalReason({...input,locked:true}),'处理中');
});
test('reader switches modal presentation without replacing its document subtree',async()=>{
 const effects=[];const dialog={open:true,modal:false,closed:0,shown:0,matches(){return this.modal;},close(){this.open=false;this.modal=false;this.closed++;},showModal(){this.open=true;this.modal=true;this.shown++;},setAttribute(){this.open=true;}};
 const c=await client(undefined,{useRef:()=>({current:dialog}),useEffect:fn=>effects.push(fn)});const content={type:'article',props:{children:['草稿评论']}};
 let tree=c.ManagerResultsSheet({simple:true,open:true,onClose(){},children:content});effects.pop()();assert.equal(dialog.shown,1);assert.ok(tree.props.children.flat().includes(content));
 tree=c.ManagerResultsSheet({simple:false,open:false,onClose(){},children:content});effects.pop()();assert.equal(dialog.modal,false);assert.equal(dialog.open,true);assert.ok(tree.props.children.flat().includes(content));
});

test('new users default to simple while an explicit full-mode preference is preserved',async()=>{
 const c=await client();assert.equal(c.managerModePreference(null),'simple');assert.equal(c.managerModePreference('simple'),'simple');assert.equal(c.managerModePreference('full'),'full');
});
test('first setup step does not create a contract and second step uses the explicit goal, not purpose',async()=>{
 const sets=[],configured=[];let values=[1,'requirements'];
 const c=await client(undefined,{useState:()=>[values.shift(),value=>sets.push(value)],useRef:()=>({current:null}),useEffect(){}});
 const props={name:'',goal:'让客人预约',scenario:'thesis',setName:value=>sets.push(value),setGoal(){},setScenario(){},busy:false,onConfigure:mode=>configured.push(mode)};
 let form=c.ManagerSetup(props);form.props.onSubmit({preventDefault(){}});assert.equal(configured.length,0);assert.ok(sets.includes(2));
 values=[2,'requirements'];form=c.ManagerSetup(props);form.props.onSubmit({preventDefault(){}});assert.equal(configured[0],'requirements');
 values=[2,'software'];form=c.ManagerSetup(props);form.props.onSubmit({preventDefault(){}});assert.equal(configured[1],'software');
});
