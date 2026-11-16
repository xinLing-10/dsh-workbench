/** Real Chrome against the disposable local fixture. No production/model/real tool approval. */
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--fixture"))
  throw Error("Explicit --fixture required");
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  profile = await mkdtemp(join(tmpdir(), "manager-next-chrome-")),
  samples = await mkdtemp(join(tmpdir(), "manager-next-sources-")),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  checks = [],
  consoleErrors = [];
await writeFile(
  join(samples, "README.md"),
  "# 虚构预约项目\n仅验证资料导入，不调用模型。",
);
await writeFile(
  join(samples, "app.py"),
  'def reserve():\n    return "fixture"\n',
);
await writeFile(join(samples, ".env"), "DUMMY=not-a-real-key");
let browser,
  ws,
  id = 0;
const pending = new Map();
try {
  browser = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!port) throw Error("Chrome failed");
  const target = await (
    await fetch(
      "http://127.0.0.1:" +
        port +
        "/json/new?" +
        encodeURIComponent("http://localhost:3100/login"),
      { method: "PUT" },
    )
  ).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => {
        pending.delete(n);
        reject(Error("CDP timeout " + method));
      }, 30000);
      pending.set(n, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (p)
        m.error
          ? p.reject(Error(JSON.stringify(m.error)))
          : p.resolve(m.result);
    } else if (m.method === "Runtime.exceptionThrown")
      consoleErrors.push(m.params.exceptionDetails.text);
  });
  const ev = async (expression) => {
    const r = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 240; i++) {
      if (await ev("!!(" + expression + ")")) return;
      await sleep(100);
    }
    throw Error("Timeout " + expression);
  };
  const check = async (name, expression) => {
    assert.equal(await ev(expression), true, name);
    checks.push(name);
    console.error("PASS", name);
  };
  const click = async (text) => {
    await ev(
      `(()=>{const b=[...document.querySelectorAll('button,a')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing control '+${JSON.stringify(text)});b.click();})()`,
    );
  };
  const fill = (selector, value) =>
    ev(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing field');const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e instanceof HTMLSelectElement?'change':'input',{bubbles:true}));})()`,
    );
  const shot = async (name) => {
    const result = await cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(
      join(root, "dsh-workbench/docs/next-" + name + ".png"),
      Buffer.from(result.data, "base64"),
    );
  };
  const size = (width, height = 940) =>
    cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 760,
    });
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await size(1440);
  await wait("document.querySelector('input[name=email]')");
  await wait("!document.querySelector('input[name=email]').disabled");
  await shot("login");
  await ev(
    "window.NativeEventSource=window.EventSource;window.liveSources=0;window.EventSource=class extends window.NativeEventSource{constructor(...args){super(...args);window.liveSources++;this.fixtureClosed=false;}close(){if(!this.fixtureClosed){window.liveSources--;this.fixtureClosed=true;}super.close();}};window.originalFetch=window.fetch;window.sentRequests=[];window.loseOnce=false;window.fetch=async(...args)=>{if(args[1]?.method==='POST'&&String(args[0]).endsWith('/messages')){window.sentRequests.push(JSON.parse(args[1].body));const r=await window.originalFetch(...args);if(window.loseOnce){window.loseOnce=false;throw Error('fixture lost ack');}return r;}return window.originalFetch(...args);};",
  );
  await fill("[name=email]", "next-admin@example.test");
  await fill("[name=password]", "Next-Fixture-2026!");
  await click("登录");
  await wait("document.querySelector('.project-card')");
  await check(
    "App Router login preserves cookie session",
    "location.pathname==='/'&&document.body.textContent.includes('next-admin@example.test')",
  );
  if (process.argv.includes("--stream-only")) {
    await ev(
      "document.querySelector('a[href=\"/projects/prj_next\"]').click()",
    );
    await wait(
      "document.querySelector('.live-state')?.textContent==='实时连接'",
    );
    await ev(
      "fetch('/api/v1/__fixture/stream',{method:'POST',headers:{'x-fixture-control':'1'}}).then(r=>r.ok)",
    );
    await wait(
      "document.querySelector('.stream-label')?.textContent.includes('尚未交付')",
    );
    await check(
      "incremental preview appears before terminal receipt",
      "document.querySelector('.messages').textContent.includes('虚构流式演示')&&!document.querySelector('.messages').textContent.includes('不会重新发送模型请求')",
    );
    await ev(
      "fetch('/api/v1/__fixture/disconnect-events',{method:'POST',headers:{'x-fixture-control':'1'}}).then(r=>r.ok)",
    );
    await wait(
      "document.querySelector('.live-state')?.textContent==='实时连接'&&document.querySelector('.messages').textContent.includes('未调用真实模型')",
    );
    await shot("streaming");
    await check(
      "reconnect restores latest durable preview without sending",
      "window.sentRequests.length===0&&document.querySelectorAll('.stream-label').length===1",
    );
    await wait(
      "!document.querySelector('.stream-label')&&document.querySelector('.messages').textContent.includes('不会重新发送模型请求')",
    );
    await check(
      "final reply replaces transient preview exactly once",
      "[...document.querySelectorAll('.message-body')].filter(x=>x.textContent.includes('虚构流式演示')).length===1",
    );
  } else if (process.argv.includes("--capture-admin")) {
    await click("服务管理");
    await wait("document.querySelector('.console-metrics')");
    await click("邀请码");
    await fill("input[name=name]", "虚构截图受邀空间");
    await click("生成一次性邀请码");
    await wait(
      "document.querySelector('.invite-result input')?.value.length>20",
    );
    await ev(
      "document.querySelector('.invite-result input').value='[redacted fixture invitation]'",
    );
    await shot("admin-invitation");
  } else {
    await ev(
      "document.querySelector('a[href=\"/projects/prj_next\"]').click()",
    );
    await wait(
      "document.querySelector('.messages')?.textContent.includes('没有调用模型')&&document.querySelector('.live-state')?.textContent==='实时连接'",
    );
    await check(
      "SSE and fixture history are connected",
      "document.querySelector('h1').textContent.includes('小店预约')",
    );
    await shot("conversation");
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await check(
      "light theme follows system preference",
      "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()==='#fbfbfc'",
    );
    await shot("conversation-light");
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await size(390, 844);
    await check(
      "mobile conversation fits viewport",
      "document.documentElement.scrollWidth<=innerWidth",
    );
    await shot("conversation-mobile");
    await size(1440);
    await ev(
      "fetch('/api/v1/__fixture/disconnect-events',{method:'POST',headers:{'x-fixture-control':'1'}}).then(r=>r.status===204)",
    );
    await wait(
      "document.querySelector('.live-state')?.textContent==='正在重连…'",
    );
    await wait(
      "document.querySelector('.live-state')?.textContent==='实时连接'",
    );
    await check(
      "SSE reconnect never resends a message",
      "window.sentRequests.length===0&&window.liveSources===1",
    );
    await ev(
      "[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.includes('多题问答')).click()",
    );
    await wait("document.querySelectorAll('.interaction fieldset').length===2");
    await fill(".interaction textarea", "虚构问答草稿");
    await ev(
      "document.querySelector('.interaction input[type=checkbox]').click()",
    );
    await ev(
      "[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.includes('小店预约')).click()",
    );
    await wait(
      "document.querySelector('h1')?.textContent.includes('小店预约')",
    );
    await ev(
      "[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.includes('多题问答')).click()",
    );
    await wait(
      "document.querySelector('.interaction textarea')?.value==='虚构问答草稿'",
    );
    await check(
      "question drafts survive navigation and old SSE closes",
      "document.querySelector('.interaction input[type=checkbox]').checked&&window.liveSources===1",
    );
    await ev(
      "[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.includes('小店预约')).click()",
    );
    await wait(
      "document.querySelector('h1')?.textContent.includes('小店预约')",
    );
    await ev(
      "[...document.querySelectorAll('button')].find(x=>x.textContent.startsWith('我的成果')).click()",
    );
    await wait("document.querySelector('.artifact-list button')");
    await click("阅读");
    await wait(
      "document.querySelector('.artifact-reader select')?.options.length===2",
    );
    await fill(".artifact-reader select", "art_next_1");
    await wait(
      "document.querySelector('.artifact-content')?.textContent.includes('版本 1')",
    );
    await check(
      "historical versions cannot be confirmed",
      "document.querySelector('.artifact-reader .primary').getAttribute('aria-disabled')==='true'",
    );
    await click("确认这一版");
    await check(
      "disabled feature explains its condition",
      "document.querySelector('.toast')?.textContent.includes('最新版本')",
    );
    await fill(".artifact-reader select", "art_next_2");
    await wait(
      "document.querySelector('.artifact-content')?.textContent.includes('版本 2')",
    );
    await click("确认这一版");
    await wait(
      "document.querySelector('.artifact-reader')?.textContent.includes('这一版已确认')",
    );
    await check(
      "download endpoint preserves meaningful filename",
      "(async()=>{const r=await fetch('/api/v1/projects/prj_next/artifacts/art_next_2/download');return r.ok&&decodeURIComponent(r.headers.get('content-disposition')).includes('小店预约需求说明')})()",
    );
    await shot("artifact");
    await click("×");
    await click("＋ 新建项目");
    await wait("document.querySelector('dialog[open] input')");
    await check(
      "new-project dialog focuses a form field",
      "document.activeElement===document.querySelector('dialog input')",
    );
    await fill("dialog input", "虚构 Next 验证项目");
    await fill("dialog textarea", "仅用虚构资料验证迁移，不调用真实模型。");
    await shot("create-project");
    await click("创建并开始");
    await wait(
      "document.querySelector('h1')?.textContent==='虚构 Next 验证项目'",
    );
    await check(
      "project notes persist through existing API",
      "(async()=>{const r=await(await fetch('/api/v1/projects')).json();return r.data.projects.some(p=>p.name==='虚构 Next 验证项目'&&p.notes.includes('虚构资料'))})()",
    );
    await click("项目资料 / 学习");
    await wait("document.querySelector('dialog[open] input[type=file]')");
    await cdp("DOM.enable");
    const tree = await cdp("DOM.getDocument");
    const fileNode = await cdp("DOM.querySelector", {
      nodeId: tree.root.nodeId,
      selector: "input[webkitdirectory]",
    });
    await cdp("DOM.setFileInputFiles", {
      nodeId: fileNode.nodeId,
      files: [samples],
    });
    await wait("document.querySelectorAll('.source-candidates li').length===2");
    await check(
      "folder preview skips hidden secret files",
      "!document.querySelector('.source-candidates').textContent.includes('.env')",
    );
    await click("上传选中的资料");
    await check(
      "upload requires explicit consent",
      "document.querySelector('dialog')?.textContent.includes('勾选上传授权')",
    );
    await ev(
      "[...document.querySelectorAll('dialog label')].find(x=>x.textContent.includes('我已检查资料')).querySelector('input').click()",
    );
    await size(390, 844);
    await shot("sources-mobile");
    await check(
      "sources modal fits mobile",
      "document.querySelector('dialog').getBoundingClientRect().width<=innerWidth",
    );
    await size(1440);
    await click("上传选中的资料");
    await wait(
      "document.querySelector('dialog')?.textContent.includes('已上传 2 份只读资料')",
    );
    await click("带我学懂这个项目");
    await wait(
      "!document.querySelector('dialog')&&document.querySelector('#message-text').value.includes('上传的项目资料')",
    );
    await check(
      "learning only prepares editable draft",
      "document.querySelectorAll('.messages li').length===0&&!document.querySelector('.send-button').disabled",
    );
    // Simulate a lost browser HTTP receipt after the fixture accepted the original request.
    await ev(
      "window.loseOnce=true;document.querySelector('.composer').requestSubmit()",
    );
    await wait(
      "document.querySelector('.toast')?.textContent.includes('操作可能已送达')&&!document.querySelector('.send-button').disabled",
    );
    await check(
      "failed send keeps draft without automatic retry",
      "window.sentRequests.length===1&&document.querySelector('#message-text').value.length>0",
    );
    await ev("document.querySelector('.composer').requestSubmit()");
    await wait(
      "window.sentRequests.length===2&&document.querySelector('.interaction')?.textContent.includes('需要你的许可')",
    );
    await check(
      "explicit same-draft retry reuses request ID",
      "window.sentRequests[0].requestId===window.sentRequests[1].requestId",
    );
    await check(
      "idempotent replay does not duplicate user message",
      "document.querySelectorAll('.messages .mine').length===1",
    );
    await click("允许一次");
    await wait("document.querySelectorAll('.interaction fieldset').length===2");
    await fill(".interaction textarea", "第一次使用电脑的店主");
    await ev(
      "document.querySelector('.interaction input[type=radio]').click()",
    );
    await click("提交全部回答");
    await wait(
      "document.querySelector('.messages')?.textContent.includes('示例文档已生成')",
    );
    await check(
      "simulation permission-question-delivery chain completes",
      "!document.querySelector('.interaction')&&document.querySelector('.messages').textContent.includes('模拟执行')",
    );
    await fill("#message-text", "虚构停止任务验证");
    await ev("document.querySelector('.composer').requestSubmit()");
    await wait(
      "document.querySelector('.interaction')?.textContent.includes('需要你的许可')",
    );
    await fill("#message-text", "停止后我还想继续提问");
    await click("停止当前任务");
    await wait(
      "!document.querySelector('.send-button').disabled&&!document.querySelector('.interaction')",
    );
    await check(
      "stop preserves next draft and unlocks composer",
      "document.querySelector('#message-text').value.includes('继续提问')",
    );
    await click("服务管理");
    await wait("document.querySelector('.console-metrics')");
    await shot("admin");
    await check(
      "leaving project closes realtime subscription",
      "window.liveSources===0",
    );
    await check(
      "admin page has five working sections",
      "document.querySelectorAll('.console-tabs button').length===5",
    );
    await click("任务与 Worker");
    await check(
      "queue is rendered by project name",
      "document.querySelector('table').textContent.includes('虚构 Next 验证项目')",
    );
    await click("邀请码");
    await fill("input[name=name]", "虚构受邀空间");
    await click("生成一次性邀请码");
    await wait(
      "document.querySelector('.invite-result input')?.value.length>20",
    );
    await check(
      "issued invite stays only in current result",
      "document.querySelector('.invite-result').textContent.includes('本次明文')",
    );
    await ev(
      "document.querySelector('.invite-result input').value='[redacted fixture invitation]'",
    );
    await shot("admin-invitation");
    await click("管理记录");
    await check(
      "switching section clears invite plaintext",
      "!document.querySelector('.invite-result')",
    );
    await check(
      "customer help is same-origin offline manual",
      "(async()=>{const r=await fetch('/help');return r.ok&&(await r.text()).includes('管家')})()",
    );
    // Separate fictional customer session validates route and API boundaries.
    await ev(
      "fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'next-customer@example.test',password:'Next-Fixture-2026!'})}).then(()=>location.assign('/admin'))",
    );
    await wait("document.body.textContent.includes('仅平台管理员可访问')");
    await check(
      "ordinary user admin API remains denied",
      "(async()=>{const r=await fetch('/api/v1/admin/service');return r.status===403})()",
    );
    await check(
      "other tenant project remains invisible",
      "(async()=>{const r=await fetch('/api/v1/projects/prj_next');return r.status===404})()",
    );
  }
  assert.equal(consoleErrors.length, 0, "uncaught browser errors");
  console.log(
    JSON.stringify({
      fixture: true,
      modelCalls: 0,
      checks: checks.length,
      passed: checks,
      screenshots: process.argv.includes("--stream-only")
        ? 1
        : process.argv.includes("--capture-admin")
          ? 2
          : 9,
      consoleErrors,
    }),
  );
} finally {
  ws?.close();
  browser?.kill("SIGTERM");
  await sleep(200);
  await rm(profile, { recursive: true, force: true });
  await rm(samples, { recursive: true, force: true });
}
