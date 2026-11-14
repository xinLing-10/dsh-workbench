// A running older BFF may not yet serve the formatter; keep its preview usable.
let renderMessage = (document, text) => document.createTextNode(text);
try { ({renderMessage} = await import('./message-format.mjs')); } catch { /* Plain text remains safe until the BFF restarts. */ }
/**
 * Standalone manager web client (first slice).
 *
 * Plain ES module, no build step: the design suggested React + Vite, but this
 * repository is offline and the first slice must stay runnable. It only talks
 * to the product API with a cookie session and a CSRF header; it never sees a
 * DSH path, session id or model credential.
 */

const state = {
  csrf: '',
  simulationOperationId: null,
  projects: [],
  project: null,
  messages: [],
  interactions: [],
  interactionDrafts: new Map(),
  interactionExpiryTimer: null,
  artifacts: [],
  currentArtifact: null,
  currentVersionId: '',
  latestVersionId: '',
  events: null,
  refreshTimer: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

/** Bind one listener only when the element exists, so a missing node cannot
 *  abort boot and leave the page blank. */
function on(id, event, handler) {
  const element = $(id);
  if (element) element.addEventListener(event, handler);
}

/** @returns the JSON payload, throwing a stable error with the API code. */
async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'x-csrf-token': state.csrf }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败（${response.status}）`);
    error.code = payload?.error?.code || 'unavailable';
    error.status = response.status;
    throw error;
  }
  return payload;
}

function setBusy(value) {
  state.busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  if (!value) {
    const send = $('send');
    if (send) send.disabled = $('message-text')?.value.trim() === '';
    const confirm = $('confirm-artifact');
    if (confirm) confirm.disabled = !state.currentArtifact || state.currentArtifact.confirmed || state.currentVersionId !== state.latestVersionId;
  }
}

function show(name) {
  document.body.dataset.view = name;
  if(name!=='admin'&&$('invite-token')) { $('invite-token').value='';$('invite-result').hidden=true; }
  for (const id of ['sidebar-new','sidebar-label','sidebar-projects']) $(id).hidden = name === 'admin';
  $('admin-nav').hidden = name !== 'admin';
  for (const id of ['entry', 'projects', 'project','admin']) $(id).hidden = id !== name;
}

function fail(message) {
  const target = $('entry-error');
  if (target && !$('entry').hidden) target.textContent = message;
  else window.alert(message);
}

async function loadMe() {
  const me = await api('GET', '/api/v1/me');
  state.csrf = me.data.csrfToken;
  $('whoami').textContent = me.data.user.email;
  $('admin-open').hidden=!me.data.user.platformAdmin;
  const missing = Object.entries(me.data.capabilities || {}).filter(([, on]) => !on).map(([name]) => name);
  $('dispatch-note').textContent = me.data.capabilities?.paused ? '模型调用已暂停，请联系管理员核对用量；历史仍可查看。' : me.data.capabilities?.readonly ? '真实模型答疑验证：可讨论需求与学习，不执行工具或修改项目。' : me.data.capabilities?.simulation ? '模拟模式：只验证消息派发，不调用真实模型。' : missing.includes('bridge') ? '执行服务尚未接通，消息会先保存。' : '';
  return me.data;
}

async function loadProjects() {
  const payload = await api('GET', '/api/v1/projects');
  state.projects = payload.data.projects;
  renderProjectNavigation();
  const list = $('project-list');
  list.replaceChildren(...state.projects.map((project) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = project.name;
    const open = document.createElement('button');
    open.textContent = '打开';
    open.addEventListener('click', () => openProject(project.id).catch((error) => fail(error.message)));
    item.append(label, open);
    return item;
  }));
  $('projects-empty').hidden = state.projects.length > 0;
  show('projects');
}

function renderProjectNavigation() {
  $('sidebar-projects').replaceChildren(...state.projects.map(project => {
    const button = document.createElement('button');button.type = 'button';
    button.className = 'project-nav-item';button.textContent = project.name;
    if (project.id === state.project?.id) button.setAttribute('aria-current','page');
    button.addEventListener('click', () => openProject(project.id).catch(error => fail(error.message)));
    return button;
  }));
}
function toggleArtifacts(open) {
  const visible = open ?? $('artifacts').hidden;
  $('artifacts').hidden = !visible;
  $('toggle-artifacts').setAttribute('aria-expanded', String(visible));
  $('project-layout').classList.toggle('with-artifacts', visible);
  if (visible) $('close-artifacts').focus();
  else $('toggle-artifacts').focus();
}
function goToLatest() {
  const scroll = $('conversation-scroll');scroll.scrollTop = scroll.scrollHeight;
  $('jump-latest').hidden = true;
}
function updateScrollHint() {
  const scroll = $('conversation-scroll');
  $('jump-latest').hidden = scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop < 100;
}

async function openProject(id) {
  setBusy(true);
  try {
    const [detail, messages] = await Promise.all([
      api('GET', `/api/v1/projects/${id}`),
      api('GET', `/api/v1/projects/${id}/messages`),
    ]);
    if (state.project?.id !== id) {
      state.currentArtifact = null;state.currentVersionId = '';state.latestVersionId = '';
      $('artifact-view').hidden = true;
      $('artifacts').hidden = true;
      $('toggle-artifacts').setAttribute('aria-expanded','false');
      $('project-layout').classList.remove('with-artifacts');
    }
    state.project = detail.data.project;
    state.interactions = detail.data.interactions || [];
    state.messages = messages.data.messages || [];
    $('project-name').textContent = state.project.name;
    renderProjectNavigation();
    renderInteractions();
    renderMessages();
    renderDispatchStatus(detail.data);
    await loadArtifacts(id);
    show('project');
    requestAnimationFrame(goToLatest);
    connectEvents(id);
  } finally {
    setBusy(false);
  }
}

/** Reload the project view in place without leaving the page. */
async function refreshProject() {
  if (!state.project) return;
  const id = state.project.id;
  const [detail, messages] = await Promise.all([
    api('GET', `/api/v1/projects/${id}`),
    api('GET', `/api/v1/projects/${id}/messages`),
  ]);
  state.interactions = detail.data.interactions || [];
  state.messages = messages.data.messages || [];
  const scroll = $('conversation-scroll');
  const follow = scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop < 100;
  renderInteractions();
  renderMessages(follow);
  renderDispatchStatus(detail.data);
  await loadArtifacts(id);
  if (state.currentArtifact) await openArtifact(state.currentArtifact.id, { keepSelection: true });
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    refreshProject().catch(() => {});
  }, 400);
}

function connectEvents(projectId) {
  closeEvents();
  const source = new EventSource(`/api/v1/projects/${projectId}/events`);
  state.events = source;
  source.addEventListener('open', () => {
    $('live-state').textContent = '实时连接';
    $('live-state').classList.add('live');
  });
  const types = ['message_created', 'message_completed', 'interaction_created', 'interaction_answered', 'interaction_cancelled', 'artifact_version', 'task_status', 'recovery_check'];
  for (const type of types) source.addEventListener(type, () => scheduleRefresh());
  source.onerror = () => {
    $('live-state').textContent = '正在重连…';
    $('live-state').classList.remove('live');
  };
}

function closeEvents() {
  clearTimeout(state.interactionExpiryTimer);
  if (state.events) {
    state.events.close();
    state.events = null;
  }
  clearTimeout(state.refreshTimer);
  $('live-state').textContent = '';
  $('live-state').classList.remove('live');
}

function renderDispatchStatus(detail) {
  $('stop-native').hidden = true;
  state.nativeOperationId = null;
  if (detail.capabilities?.nativeStop || detail.capabilities?.workerProtocol) {
    const active = detail.operations?.find(item => (detail.capabilities?.workerProtocol?['queued','running','waiting']:['running','waiting']).includes(item.state));
    state.nativeOperationId = active?.id;
    $('stop-native').hidden = !active;
  }
  $('cancel-simulation').hidden = true;
  state.simulationOperationId = null;
  if (detail.capabilities?.paused) {
    $('dispatch-note').textContent = detail.capabilities?.workerProtocol ? '本轮验证已暂停，历史和成果仍可查看；新的调用需管理员开启。' : '模型调用已暂停，请联系管理员核对用量；历史仍可查看，不要重复发送。';
    return;
  }
  if (detail.capabilities?.workerProtocol) {
    const current=detail.operations?.find(item=>['waiting','running','uncertain'].includes(item.state)) || detail.operations?.[0];
    const labels={queued:'已排队，等待执行服务接下任务。',running:'管家正在处理；操作和结果会保存在同一条任务记录中。',waiting:'请先回答上方问题或决定是否允许；工具不会自动获得许可。',completed:'执行服务已返回结束回执；成果仍需你阅读和确认。',cancelled:'执行服务已确认停止；已经生成的文档会保留。',failed:'执行已失败，请核对处理记录后再决定下一步。',uncertain:'执行结果待核对，请联系管理员检查原任务，不要重复发送。'};
    $('dispatch-note').textContent=current?labels[current.state] || '正在核对执行状态。':'执行服务已连接，可以开始沟通。';
    return;
  }
  if (detail.capabilities?.readonly) {
    const current = detail.operations?.find(item => ['waiting','running','uncertain'].includes(item.state)) || detail.operations?.[0];
    const labels = { queued:'真实答疑正在排队。', running:'管家正在使用真实模型回答；当前仅支持文本答疑。', completed:'真实答疑已完成；未执行工具或修改项目。', uncertain:'本次答疑结果待核对，已暂停自动执行，请联系管理员。' };
    $('dispatch-note').textContent = current ? labels[current.state] || '真实模型答疑验证。' : '真实模型答疑验证：可讨论需求与学习，不执行工具或修改项目。';
    return;
  }
  if (!detail.capabilities?.simulation) return;
  const current = detail.operations?.find(item => ['waiting','running','uncertain'].includes(item.state)) || detail.operations?.[0];
  state.simulationOperationId = current?.id;
  $('cancel-simulation').hidden = !current || !['queued','waiting'].includes(current.state);
  const labels = { waiting: '请先回答上方问题或决定是否允许。', cancelled: '模拟任务已取消。', queued: '模拟任务正在排队。', running: '正在进行模拟验证。', completed: '模拟验证已完成；回复不代表真实成果。', uncertain: '模拟结果待核对，请联系管理员；不会自动重试。' };
  $('dispatch-note').textContent = current ? labels[current.state] || '模拟验证中。' : '模拟模式：只验证消息派发，不调用真实模型。';
}

function renderMessages(followLatest) {
  const list = $('messages'), scroll = $('conversation-scroll');
  const follow = followLatest ?? (scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop < 100);
  $('chat-welcome').hidden = state.messages.length > 0 || state.interactions.length > 0;
  list.replaceChildren(...state.messages.map(message => {
    const item = document.createElement('li');item.className = 'message '+(message.role === 'user' ? 'mine' : 'assistant');
    const avatar = document.createElement('span');avatar.className='message-avatar';avatar.textContent=message.role==='user'?'你':'✳';avatar.setAttribute('aria-hidden','true');
    const body = document.createElement('div');body.className='message-body';
    const role = document.createElement('div');role.className='message-role';role.textContent=message.role==='user'?'你':'项目管家';
    const content = document.createElement('div');content.className=message.role==='user'?'user-message':'formatted-message';
    if(message.role==='user') content.textContent=message.text;else content.append(renderMessage(document,message.text));
    body.append(role,content);item.append(avatar,body);return item;
  }));
  requestAnimationFrame(() => { if(follow) goToLatest();else updateScrollHint(); });
}

function renderInteractions() {
  clearTimeout(state.interactionExpiryTimer);
  state.interactions = state.interactions.filter(item => !item.expiresAt || Date.parse(item.expiresAt) > Date.now());
  const expires = state.interactions.map(item => Date.parse(item.expiresAt)).filter(Number.isFinite);
  if (expires.length) state.interactionExpiryTimer = setTimeout(() => renderInteractions(), Math.max(1, Math.min(2147483647, Math.min(...expires) - Date.now() + 1)));
  const active = new Set(state.interactions.map(item => item.id));
  for (const id of state.interactionDrafts.keys()) if (!active.has(id)) state.interactionDrafts.delete(id);
  const box = $('interactions');
  if (state.interactions.length === 0) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(...state.interactions.map((interaction) => {
    const card = document.createElement('div');
    card.className = 'interaction';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = interaction.kind === 'permission' ? '需要你的许可' : '需要你回答';
    const title = document.createElement('h3');
    title.textContent = interaction.prompt;
    if (interaction.kind === 'permission') {
      const allow = document.createElement('button');
      allow.textContent = '允许一次';
      allow.addEventListener('click', () => respond(interaction.id, 'allow').catch(error => fail(error.message)));
      const deny = document.createElement('button');
      deny.textContent = '拒绝';
      deny.addEventListener('click', () => respond(interaction.id, 'deny').catch(error => fail(error.message)));
      card.append(kind, title, wrap(allow, deny));
      return card;
    }
    const questions = interaction.questions || [];
    const draft = state.interactionDrafts.get(interaction.id) || {};
    state.interactionDrafts.set(interaction.id, draft);
    const fields = [];
    const rendered = questions.length ? questions : [{ id: 'legacy', question: interaction.prompt, options: [] }];
    for (const question of rendered) {
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent = question.question;
      fieldset.append(legend);
      if (question.options?.length) { const hint = document.createElement('span'); hint.className = 'muted'; hint.textContent = question.multiSelect ? '可以选择多项，也可以补充说明。' : '请选择一项，或填写其他回答。'; fieldset.append(hint); }
      if (question.detail) {
        const detail = document.createElement('p'); detail.textContent = question.detail; fieldset.append(detail);
      }
      const saved = draft[question.id] || { selected: [], custom: '' };
      const choices = [];
      for (const option of question.options || []) {
        const label = document.createElement('label'); label.className = 'question-option';
        const input = document.createElement('input');
        input.type = question.multiSelect ? 'checkbox' : 'radio';
        input.name = `${interaction.id}-${question.id}`;
        input.value = option.label;
        input.checked = saved.selected.includes(option.label);
        const text = document.createElement('span');
        text.textContent = option.description ? `${option.label}：${option.description}` : option.label;
        label.append(input, text); fieldset.append(label); choices.push(input);
      }
      const customLabel = document.createElement('label');
      customLabel.textContent = question.options?.length ? '补充说明或其他回答' : '你的回答';
      const custom = document.createElement('textarea'); custom.rows = 2; custom.maxLength = 2000; custom.value = saved.custom;
      customLabel.append(custom); fieldset.append(customLabel);
      const value = () => ({ id: question.id, selected: choices.filter(input => input.checked).map(input => input.value), custom: custom.value });
      const remember = () => { draft[question.id] = value(); };
      fieldset.addEventListener('input', remember);
      fields.push(value); card.append(fieldset);
    }
    const submit = document.createElement('button');
    submit.className = 'primary'; submit.textContent = '提交全部回答';
    submit.addEventListener('click', () => {
      const answers = fields.map(value => value());
      if (answers.some(a => !a.selected.length && !a.custom.trim())) return fail('请先回答每一道问题');
      const answer = questions.length ? { answers } : answers[0].custom;
      respond(interaction.id, answer).catch(error => fail(error.message));
    });
    card.prepend(kind, title);
    card.append(wrap(submit));
    return card;
  }));
}

function wrap(...children) {
  const row = document.createElement('div');
  row.className = 'row';
  row.append(...children);
  return row;
}

async function loadArtifacts(projectId) {
  const payload = await api('GET', `/api/v1/projects/${projectId}/artifacts`);
  state.artifacts = payload.data.artifacts;
  $('artifact-count').textContent = String(state.artifacts.length);
  const list = $('artifact-list');
  list.replaceChildren(...state.artifacts.map((artifact) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = `${artifact.name}${artifact.confirmed ? ' · 已确认' : ''}`;
    const open = document.createElement('button');
    open.textContent = '阅读';
    open.addEventListener('click', () => openArtifact(artifact.id).catch((error) => fail(error.message)));
    item.append(label, open);
    return item;
  }));
  $('artifacts-empty').hidden = state.artifacts.length > 0;
}

async function openArtifact(id, { keepSelection = false } = {}) {
  setBusy(true);
  try {
    const [payload, versions] = await Promise.all([
      api('GET', `/api/v1/projects/${state.project.id}/artifacts/${id}`),
      api('GET', `/api/v1/projects/${state.project.id}/artifacts/${id}/versions`),
    ]);
    state.currentArtifact = payload.data.artifact;
    state.currentVersionId = payload.data.artifact.id;
    state.latestVersionId = versions.data.latestId || payload.data.artifact.id;
    const select = $('artifact-version');
    select.replaceChildren(...versions.data.versions.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `v${item.version}${item.confirmed ? ' · 已确认' : ''}`;
      option.selected = (keepSelection ? state.currentVersionId : item.id) === item.id;
      return option;
    }));
    $('artifact-version').value = state.currentVersionId;
    $('artifact-name').textContent = payload.data.artifact.name;
    $('artifact-meta').textContent = `版本 ${payload.data.artifact.version}${payload.data.artifact.confirmed ? ' · 已确认' : ' · 未确认'}${payload.data.truncated ? ' · 仅显示前 200k 字符' : ''}`;
    $('artifact-text').textContent = payload.data.text;
    $('artifact-note').textContent = '';
    $('artifact-view').hidden = false;
    $('artifact-view').classList.toggle('confirmed', payload.data.artifact.confirmed);
    $('confirm-artifact').disabled = payload.data.artifact.confirmed || state.currentVersionId !== state.latestVersionId;
    $('artifact-note').textContent = state.currentVersionId === state.latestVersionId ? (state.currentArtifact.confirmed ? '这一版已确认，无需重复确认。' : '') : '这是历史版本，只能阅读与下载；确认请切到最新一版。';
  } finally { setBusy(false); }
}

async function confirmArtifact() {
  if (!state.currentArtifact) return;
  setBusy(true);
  try {
    const payload = await api('POST', `/api/v1/projects/${state.project.id}/artifacts/${state.currentArtifact.id}/confirm`, { hash: state.currentArtifact.sha256 });
    state.currentArtifact = payload.data.artifact;
    $('artifact-meta').textContent = `版本 ${payload.data.artifact.version} · 已确认`;
    $('artifact-note').textContent = '已保存这一版的确认。';
    $('confirm-artifact').disabled = true;
    $('artifact-view').classList.add('confirmed');
    await loadArtifacts(state.project.id);
  } catch (error) {
    $('artifact-note').textContent = error.message;
  } finally { setBusy(false); }
}

function downloadArtifact() {
  if (!state.currentArtifact) return;
  const link = document.createElement('a');
  link.href = `/api/v1/projects/${state.project.id}/artifacts/${state.currentArtifact.id}/download`;
  link.download = state.currentArtifact.name;
  document.body.append(link);
  link.click();
  link.remove();
}

async function respond(id, answer) {
  if (typeof answer === 'string' && !answer.trim()) return fail('请先写下回答');
  setBusy(true);
  try {
    await api('POST', `/api/v1/projects/${state.project.id}/interactions/${id}/respond`, { answer: typeof answer === 'string' ? answer.trim() : answer });
    state.interactionDrafts.delete(id);
    await openProject(state.project.id);
  } finally {
    setBusy(false);
  }
}

async function sendMessage() {
  const text = $('message-text').value.trim();
  if (!text) return;
  setBusy(true);
  try {
    await api('POST', `/api/v1/projects/${state.project.id}/messages`, { text, requestId: crypto.randomUUID() });
    $('message-text').value = '';
    $('send').disabled = true;
    await openProject(state.project.id);
  } finally {
    setBusy(false);
  }
}

async function createProject() {
  const name = window.prompt('给这个项目起个名字');
  if (!name) return;
  setBusy(true);
  try {
    const payload = await api('POST', '/api/v1/projects', { name: name.trim().slice(0, 80) });
    await loadProjects();
    await openProject(payload.data.project.id);
  } finally {
    setBusy(false);
  }
}

async function entry(event) {
  event.preventDefault();
  const email = $('email').value.trim();
  const password = $('password').value;
  const invite = $('invite').value.trim();
  $('entry-error').textContent = '';
  setBusy(true);
  try {
    if (invite !== '') {
      await api('POST', '/api/v1/invitations/redeem', { token: invite, email, password });
    } else {
      await api('POST', '/api/v1/auth/login', { email, password });
    }
    await loadMe();
    await loadProjects();
  } catch (error) {
    fail(error.message);
  } finally {
    setBusy(false);
  }
}

let serviceView=null;
function adminText(tag,text){const e=document.createElement(tag);e.textContent=text;return e;}
function budgetTargets(){
 const scope=$('budget-scope').value;const targets=scope==='global'?[{id:'*',name:'所有用户和项目'}]:scope==='user'?serviceView.users:serviceView.projects;
 $('budget-target').replaceChildren(...targets.map(x=>{const e=adminText('option',x.email||x.name||x.id);e.value=x.id;return e;}));budgetSelection();
}
function budgetSelection(){const p=serviceView.policies.find(p=>p.scope===$('budget-scope').value&&p.scopeId===$('budget-target').value);$('budget-limit').value=p?.limit??'';$('budget-window').value=p?.window||'month';}
const number = value => new Intl.NumberFormat('zh-CN').format(Number(value)||0);
const operationLabels = {accepted:'已接收',queued:'排队中',running:'执行中',waiting:'等待回答',uncertain:'待核对',completed:'已完成',failed:'失败',cancelled:'已取消'};
function adminSection(name) {
  if(name!=='invitations'){$('invite-token').value='';$('invite-result').hidden=true;}
  for(const panel of document.querySelectorAll('[data-admin-panel]')) panel.hidden=panel.dataset.adminPanel!==name;
  for(const button of document.querySelectorAll('[data-admin-section]')) {
    if(button.dataset.adminSection===name)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  }
}
function badge(text,kind='neutral') {const span=adminText('span',text);span.className='console-badge '+kind;return span;}
function renderQueue() {
  const search=$('admin-queue-search').value.trim().toLowerCase(),filter=$('admin-queue-filter').value;
  const rows=(serviceView?.dashboard?.queue||[]).filter(x=>(filter==='all'||filter===x.state)&&[x.projectName,x.actorEmail,x.id,x.tenantName].join(' ').toLowerCase().includes(search));
  $('admin-queue').replaceChildren(...rows.map(x=>{
    const row=document.createElement('tr'),name=document.createElement('td');name.append(adminText('strong',x.projectName),adminText('small',x.actorEmail||'未记录发起人'));
    const status=document.createElement('td');status.append(badge(operationLabels[x.state]||x.state,['uncertain','failed'].includes(x.state)?'warning':x.state==='completed'?'good':'neutral'));
    row.append(name,status,adminText('td',x.workerId||'尚未分配'),adminText('td',new Date(x.updated_at).toLocaleString('zh-CN')),adminText('td',x.id));return row;
  }));
  if(!rows.length){const row=document.createElement('tr'),cell=adminText('td','没有符合条件的任务。');cell.colSpan=5;row.append(cell);$('admin-queue').append(row);}
}
function renderDashboard(data) {
  const d=data.dashboard;
  if(!d){$('admin-updated').textContent='当前 API 未提供概览，请更新服务端后刷新。';$('admin-metrics').replaceChildren(adminText('p','当前服务版本尚未提供概览数据。'));return;}
  $('admin-updated').textContent=(d.fixture?'虚构演示 · 未调用模型 · ':'')+'更新于 '+new Date(d.at).toLocaleTimeString('zh-CN');
  const global=data.policies.find(x=>x.scope==='global'),active=(d.counts.running||0)+(d.counts.waiting||0);
  const metrics=[['已结算用量',number(d.model.settledTokens),'本服务账本累计 · token'],['待核对请求',number(d.model.unknownRequests),'回执不完整时保留额度'],['排队任务',number(d.counts.queued),'等待执行的操作'],['进行中任务',number(active),'执行中与等待回答'],['活跃用户',number(d.totals.users),number(d.totals.tenants)+' 个租户'],['全局可用额度',global?(global.frozen?'已冻结':number(global.remaining)):'未配置',global?(global.frozen?'余额 '+number(global.remaining)+' token，需先核对':'当前全局策略 · token'):'配置后才可执行正式任务']];
  $('admin-metrics').replaceChildren(...metrics.map(([title,value,note],index)=>{const card=document.createElement('article');card.className='metric-card';if(index===1&&d.model.unknownRequests)card.classList.add('needs-attention');card.append(adminText('span',title),adminText('strong',value),adminText('small',note));return card;}));
  const max=Math.max(1,...d.trend.map(x=>x.tokens));$('admin-trend').replaceChildren(...d.trend.map(x=>{const col=document.createElement('div');col.className='trend-column';col.title=x.date+'：'+number(x.tokens)+' token，'+number(x.requests)+' 次请求';const value=adminText('span',number(x.tokens));value.className='trend-value';const track=document.createElement('div');track.className='trend-track';const bar=document.createElement('div');bar.className='trend-bar';bar.style.height=(x.tokens/max*100)+'%';track.append(bar);col.append(value,track,adminText('small',x.date.slice(5)));return col;}));
  const checks=[['正式服务',data.enabled?'已启用':'未启用',data.enabled],['模型准入',d.paused?'已暂停':'未暂停',!d.paused],['模型网关',data.environment.modelGateway?'已配置':'未配置',data.environment.modelGateway],['隔离 Worker',data.environment.workerReady?'握手就绪':'未就绪',data.environment.workerReady],['全局预算',!global?'未配置':global.frozen?'待核对，已冻结':global.remaining>0?'尚有额度':'已用完或暂停',global&&!global.frozen&&global.remaining>0]];
  $('admin-readiness').replaceChildren(...checks.map(([title,text,good])=>{const li=document.createElement('li');li.append(adminText('span',title),badge(text,good?'good':'warning'));return li;}));
  const attention=[];if(d.model.unknownRequests)attention.push(number(d.model.unknownRequests)+' 个模型请求待核对，请依据服务商回执登记实际用量。');if(d.paused)attention.push('模型调用已暂停，历史和成果仍可查看。');if(d.counts.uncertain)attention.push(number(d.counts.uncertain)+' 项任务结果待核对，请勿重复派发。');if(data.carryovers.some(x=>x.held>0))attention.push('存在历史账本预占，未并入上方已结算用量。');if(data.authorization)attention.push('本实例受独立授权硬上限约束：'+number(data.authorization.tokenLimit)+' token / '+number(data.authorization.maxRequests)+' 次请求。');
  $('admin-attention').replaceChildren(...(attention.length?attention:['当前没有待核对提醒。就绪检查不等于公网或持续运行验收已通过。']).map(text=>adminText('p',text)));
  const info=[['运行时',d.process.node],['API 已运行',Math.floor(d.process.uptimeSeconds/3600)+' 小时 '+Math.floor(d.process.uptimeSeconds%3600/60)+' 分钟'],['API 内存',Math.round(d.process.memoryBytes/1048576)+' MiB'],['数据库版本','Schema '+d.process.schema],['活跃项目',number(d.totals.projects)]];
  $('admin-process').replaceChildren(...info.flatMap(([key,value])=>[adminText('dt',key),adminText('dd',value)]));
  $('admin-queue-counts').replaceChildren(...Object.entries(operationLabels).map(([key,label])=>badge(label+' '+number(d.counts[key]),key==='uncertain'?'warning':'neutral')));
  renderQueue();
  $('admin-workers').replaceChildren(...d.workers.map(w=>{const card=document.createElement('article');card.className='worker-card';card.append(adminText('strong',w.id),badge(w.status==='active'?'登记有效':'已停用',w.status==='active'?'good':'neutral'),adminText('p','握手：'+(w.reported?(w.connected?'已连接':'未连接'):'未报告')+' · 隔离：'+(w.reported?(w.isolated?'已验证':'未就绪'):'未报告')),adminText('small','非终态执行 '+number(w.active)+' · 代次 '+number(w.generation)));return card;}));
  if(!d.workers.length)$('admin-workers').append(adminText('p','尚未登记 Worker。登记身份不等于执行环境已经就绪。'));
}
let invitationData=null,issuingInvite=false;
function inviteMode() {
 const existing=$('invite-mode').value==='existing';
 $('invite-name-label').hidden=existing;$('invite-name').required=!existing;
 $('invite-tenant-label').hidden=!existing;$('invite-shared-label').hidden=!existing;
 $('invite-shared').required=existing;
}
async function loadInvitations() {
 const {data}=await api('GET','/api/v1/admin/invitations');invitationData=data;
 $('invite-gate').textContent=data.enabled?'邀请兑换已开放；用户在本服务登录页填写邀请码、邮箱和密码注册。':'邀请兑换当前关闭，暂不能生成。请由运维配置 PRODUCT_API_ALLOW_REDEEM=1 后刷新；此页面不会自动打开注册入口。';
 const selected=$('invite-tenant').value;$('invite-tenant').replaceChildren(...data.tenants.map(t=>{const o=adminText('option',t.name);o.value=t.id;return o;}));if(data.tenants.some(t=>t.id===selected))$('invite-tenant').value=selected;
 $('admin-invitations').replaceChildren(...data.invitations.map(i=>{const row=document.createElement('tr'),status=document.createElement('td');status.append(badge(({available:'待使用',used:'已使用',expired:'已过期'})[i.status],i.status==='available'?'good':'neutral'));row.append(adminText('td',i.tenantName),status,adminText('td',new Date(i.expiresAt).toLocaleString('zh-CN')),adminText('td',i.redeemedBy||'—'),adminText('td',i.id));return row;}));
 if(!data.invitations.length){const row=document.createElement('tr'),cell=adminText('td','还没有邀请记录。');cell.colSpan=5;row.append(cell);$('admin-invitations').append(row);}
}
async function issueInvite(event) {
 event.preventDefault();if(issuingInvite)return;
 if(!invitationData?.enabled){$('admin-result').textContent='邀请兑换未开放，请先由运维启用后刷新；没有生成邀请码。';return;}
 issuingInvite=true;$('issue-invite').disabled=true;$('invite-token').value='';$('invite-result').hidden=true;
 try {
 const {data}=await api('POST','/api/v1/admin/invitations',{mode:$('invite-mode').value,name:$('invite-name').value,tenantId:$('invite-tenant').value,hours:Number($('invite-hours').value),confirmShared:$('invite-shared').checked});
 $('invite-token').value=data.token;$('invite-result').hidden=false;$('invite-copy-status').textContent='';$('invite-result-meta').textContent=data.tenantName+' · 有效至 '+new Date(data.expiresAt).toLocaleString('zh-CN');$('admin-result').textContent='邀请码已生成，请及时复制；用户仍需单独配置额度才能运行正式模型任务。';
 await loadInvitations();$('invite-token').focus();$('invite-result').scrollIntoView({block:'nearest'});
 }catch(error){$('admin-result').textContent=error.message+'。如果连接中断，生成结果可能已保存，请先刷新邀请列表核对，不会自动重试。';}
 finally{issuingInvite=false;$('issue-invite').disabled=false;}
}
async function loadService(){
 const {data}=await api('GET','/api/v1/admin/service');serviceView=data;closeEvents();show('admin');renderDashboard(data);
 await loadInvitations();
 $('admin-environment').textContent=(data.enabled?'正式服务已启用':'正式服务未启用')+' · 隔离 Worker：'+(data.environment.workerReady?'就绪':'未就绪')+' · 模型网关：'+(data.environment.modelGateway?'已配置':'未配置')+'。未配置额度或隔离服务未就绪时不会派发正式任务。';
 const label=p=>p.scope==='global'?'所有用户和项目':p.scope==='user'?data.users.find(u=>u.id===p.scopeId)?.email||p.scopeId:data.projects.find(x=>x.id===p.scopeId)?.name||p.scopeId;
 $('admin-policies').replaceChildren(...data.policies.map(p=>{const row=document.createElement('tr');for(const v of [({user:'用户',project:'项目',global:'全局'})[p.scope],label(p),({month:'UTC 月',day:'UTC 日',lifetime:'累计'})[p.window],p.limit,p.used,p.held,p.remaining,p.frozen?'待核对，已冻结':p.remaining?'可用':'已用完或暂停'])row.append(adminText('td',v));return row;}));
 if(!data.policies.length){const row=document.createElement('tr'),cell=adminText('td','尚未配置额度。正式请求需要用户、项目、全局三项都可用。');cell.colSpan=8;row.append(cell);$('admin-policies').append(row);}
 budgetTargets();$('admin-pending').replaceChildren(...[...data.pending,...data.carryovers.filter(c=>c.held>0).map(c=>({...c,kind:'legacy',state:'unknown',reservation:c.held,actual:c.used}))].map(c=>{
  const box=document.createElement('article');box.className='service-call';box.append(adminText('p',c.id+' · '+(c.state==='held'?'预占中':'待核对')+' · 预占 '+c.reservation+' token · 已知实际 '+(c.actual??'未知')));
  const receipt=JSON.parse(c.evidence_json||'{}');if(receipt.requestId||receipt.messageId)box.append(adminText('p','服务商回执：'+(receipt.requestId||receipt.messageId)));
  if(c.state==='unknown'){
   const form=document.createElement('form');const controls={};for(const [key,title]of [['actual',c.kind==='legacy'?'历史账本累计实际 token（含已结算）':'服务商实际 token'],['reason','核对原因'],['evidence','账单或服务商凭证编号']]){const label=adminText('label',title);const input=document.createElement('input');input.required=true;input.type=key==='actual'?'number':'text';if(key==='actual'){input.min=String(c.actual??0);input.step='1';}else{input.minLength=key==='reason'?4:8;input.maxLength=key==='reason'?1000:2000;}label.append(input);form.append(label);controls[key]=input;}
   const button=adminText('button','登记实际用量并核销预占');button.type='submit';form.append(button);form.addEventListener('submit',async e=>{e.preventDefault();button.disabled=true;try{await api('POST','/api/v1/admin/reconcile',{id:c.id,kind:c.kind,revision:c.revision,actual:Number(controls.actual.value),reason:controls.reason.value,evidence:controls.evidence.value});$('admin-result').textContent='用量已登记。任务没有重发，工具没有获得授权。';await loadService();}catch(error){$('admin-result').textContent=error.message;}finally{button.disabled=false;}});box.append(form);
  }else box.append(adminText('p','调用仍在进行；超过回执等待时间后将进入待核对，请先刷新。'));
  return box;
 }));if(!data.pending.length&&!data.carryovers.some(c=>c.held>0))$('admin-pending').append(adminText('p','没有待核对用量。'));
 $('admin-executions').replaceChildren(...data.executions.map(x=>{const li=adminText('li',(data.projects.find(p=>p.id===x.project_id)?.name||x.project_id)+' · '+(operationLabels[x.state]||x.state)+' · '+x.operation_id+' ');const button=adminText('button','核对执行回执');button.addEventListener('click',async()=>{if(!data.dashboard?.capabilities.recovery){$('admin-result').textContent='观察服务尚未连接，需管理员先配置 Worker 恢复通道；不会重新派发任务。';return;}button.disabled=true;try{await api('POST','/api/v1/admin/executions/check',{operationId:x.operation_id});$('admin-result').textContent='已核对观察回执；没有重新派发任务。';await loadService();}catch(e){$('admin-result').textContent=e.message;}finally{button.disabled=false;}});li.append(button);return li;}));
 if(!data.executions.length)$('admin-executions').append(adminText('li','当前没有进行中或待核对的执行。'));
 $('admin-audit').replaceChildren(...data.audit.map(x=>{const li=document.createElement('li'),details=document.createElement('details');details.append(adminText('summary',x.at+' · '+x.action+' · '+x.target+' · '+x.actor));details.append(adminText('pre',JSON.stringify(JSON.parse(x.meta_json||'{}'),null,2)));li.append(details);return li;}));
}
function boot() {
 on('invite-mode','change',inviteMode);on('admin-invite-form','submit',issueInvite);
 on('hide-invite','click',()=>{$('invite-token').value='';$('invite-result').hidden=true;});
 on('copy-invite','click',async()=>{if(!$('invite-token').value)return;try{await navigator.clipboard.writeText($('invite-token').value);$('invite-copy-status').textContent='已复制，请通过私密渠道交给指定用户。';}catch{$('invite-token').focus();$('invite-token').select();$('invite-copy-status').textContent='浏览器未允许自动复制，已选中邀请码，请手动复制。';}});

 for(const button of document.querySelectorAll('[data-admin-section]'))button.addEventListener('click',()=>adminSection(button.dataset.adminSection));
 on('admin-queue-search','input',renderQueue);on('admin-queue-filter','change',renderQueue);

 on('sidebar-new','click',()=>createProject().catch(error=>fail(error.message)));
 on('toggle-artifacts','click',()=>toggleArtifacts());on('close-artifacts','click',()=>toggleArtifacts(false));
 on('conversation-scroll','scroll',updateScrollHint);on('jump-latest','click',goToLatest);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('artifacts').hidden)toggleArtifacts(false);});
 for(const button of document.querySelectorAll('[data-prompt]'))button.addEventListener('click',()=>{$('message-text').value=button.dataset.prompt;$('message-text').dispatchEvent(new Event('input'));$('message-text').focus();});

 on('admin-open','click',()=>loadService().catch(e=>fail(e.message)));
 on('admin-refresh','click',()=>loadService().catch(e=>fail(e.message)));
 on('admin-back','click',()=>loadProjects().catch(e=>fail(e.message)));
 on('budget-scope','change',budgetTargets);on('budget-target','change',budgetSelection);
 on('admin-policy','submit',async e=>{e.preventDefault();const scope=$('budget-scope').value,scopeId=$('budget-target').value,p=serviceView.policies.find(x=>x.scope===scope&&x.scopeId===scopeId);try{await api('POST','/api/v1/admin/budgets',{scope,scopeId,limit:Number($('budget-limit').value),window:$('budget-window').value,revision:p?.revision??0,reason:$('budget-reason').value});$('admin-result').textContent='额度已保存。';await loadService();}catch(error){$('admin-result').textContent=error.message;}});

  on('login-form', 'submit', entry);
  on('new-project', 'click', () => createProject().catch((error) => fail(error.message)));
  on('back', 'click', () => { closeEvents(); loadProjects().catch((error) => fail(error.message)); });
  on('message-form', 'submit', (event) => { event.preventDefault(); sendMessage().catch((error) => fail(error.message)); });
  on('message-text', 'input', (event) => { $('send').disabled = event.target.value.trim() === ''; });
  if ($('send')) $('send').disabled = true;
  on('confirm-artifact', 'click', () => confirmArtifact().catch((error) => fail(error.message)));
  on('artifact-version', 'change', (event) => {
    if (event.target.value) openArtifact(event.target.value).catch((error) => fail(error.message));
  });
  on('download-artifact', 'click', downloadArtifact);
  on('stop-native', 'click', async () => {
    if (!state.nativeOperationId || !state.project) return;
    try { await api('POST', `/api/v1/projects/${state.project.id}/actions`, {action:'cancel_operation',operationId:state.nativeOperationId,requestId:crypto.randomUUID()}); await refreshProject(); }
    catch (error) { fail(error.message); await refreshProject(); }
  });
  on('cancel-simulation', 'click', async () => {
    if (!state.simulationOperationId || !state.project) return;
    try { await api('POST', `/api/v1/projects/${state.project.id}/actions`, {action:'cancel_operation',operationId:state.simulationOperationId,requestId:crypto.randomUUID()}); await refreshProject(); }
    catch(error) { fail(error.message); }
  });
  on('refresh-artifacts', 'click', () => {
    if (state.project) loadArtifacts(state.project.id).catch((error) => fail(error.message));
  });

  api('GET', '/api/v1/me')
    .then(async (me) => {
      state.csrf = me.data.csrfToken;
      await loadProjects();
      $('whoami').textContent = me.data.user.email;
      $('admin-open').hidden=!me.data.user.platformAdmin;
    })
    .catch(() => show('entry'));
}

boot();
