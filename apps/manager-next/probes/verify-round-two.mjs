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
        encodeURIComponent("http://localhost:3117/login"),
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
      join(root, "dsh-workbench/docs/round-two-" + name + ".png"),
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

  await fill("[name=email]", "next-admin@example.test");
  await fill("[name=password]", "Next-Fixture-2026!");
  await click("登录");
  await wait("document.querySelector('.project-card')");
  await check(
    "logout is available after login",
    "[...document.querySelectorAll('button')].some(b=>b.textContent==='退出登录')",
  );
  const project = async (text) => {
    await ev(
      `[...document.querySelectorAll('.sidebar nav button')].find(x=>x.textContent.includes(${JSON.stringify(text)})).click()`,
    );
    await wait(
      `document.querySelector('h1')?.textContent.includes(${JSON.stringify(text)})`,
    );
  };
  await project("小店预约");
  await wait("document.querySelector('#message-text')");
  await wait("document.querySelector('.message-sources a')");
  await check(
    "verified source footer has safe original link",
    "document.querySelector('.message-sources a').href==='https://example.com/guide'",
  );
  await fill("#message-text", "这是虚构的长草稿。".repeat(80));
  const before = await ev(
    "document.querySelector('#message-text').getBoundingClientRect().height",
  );
  const grip = await ev(
    "(()=>{const r=document.querySelector('.input-resize-handle').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  await cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: grip.x,
    y: grip.y,
    button: "left",
    clickCount: 1,
  });
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: grip.x,
    y: grip.y - 100,
    button: "left",
    buttons: 1,
  });
  await cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: grip.x,
    y: grip.y - 100,
    button: "left",
    clickCount: 1,
  });
  await sleep(150);
  assert.ok(
    (await ev(
      "document.querySelector('#message-text').getBoundingClientRect().height",
    )) >
      before + 60,
  );
  checks.push("pointer drag enlarges input without losing draft");
  await check(
    "draft survives resizing",
    "document.querySelector('#message-text').value.length>500",
  );
  await shot("composer");
  await ev(
    "document.querySelector('.input-resize-handle').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  await check(
    "keyboard can restore minimum input size",
    "document.querySelector('#message-text').getBoundingClientRect().height===80",
  );
  await project("多题问答");
  await wait("document.querySelectorAll('.interaction fieldset').length===2");
  await check(
    "switching project starts empty composer",
    "document.querySelector('#message-text').value===''",
  );
  await fill("#message-text", "另一个项目的草稿");
  await project("小店预约");
  await wait("document.querySelector('#message-text')");
  await check(
    "returning to project does not restore stale draft",
    "document.querySelector('#message-text').value===''",
  );
  await project("多题问答");
  await wait("document.querySelectorAll('.interaction fieldset').length===2");
  await ev(
    "document.querySelector('.interaction input[type=checkbox]').click()",
  );
  await fill(
    ".interaction fieldset:nth-of-type(1) textarea",
    "补充：给两人使用",
  );
  await fill(".interaction fieldset:nth-of-type(2) textarea", "先学预约流程");
  await size(1440, 1250);
  await shot("questions");
  await size(1440);
  await click("提交全部回答");
  await wait("!document.querySelector('.interaction fieldset')");
  await check(
    "grouped answer submission retires the whole interaction",
    "!document.querySelector('.interaction fieldset')",
  );
  await project("操作授权");
  await wait("document.querySelector('.authorization-composer')");
  await check(
    "permission replaces ordinary composer",
    "!document.querySelector('#message-text')&&[...document.querySelectorAll('.authorization-composer button')].some(b=>b.textContent==='允许授权')",
  );
  await shot("authorization");
  await click("拒绝");
  await wait("document.querySelector('#message-text')");
  await check(
    "denied permission restores ordinary input",
    "!document.querySelector('.authorization-composer')&&document.querySelector('#message-text').value===''",
  );
  await project("小店预约");
  await wait("document.querySelector('#message-text')");
  await click("修改已有项目");
  await wait("document.querySelector('input[webkitdirectory]')");
  await cdp("DOM.enable");
  const tree = await cdp("DOM.getDocument"),
    fileNode = await cdp("DOM.querySelector", {
      nodeId: tree.root.nodeId,
      selector: "input[webkitdirectory]",
    });
  await cdp("DOM.setFileInputFiles", {
    nodeId: fileNode.nodeId,
    files: [samples],
  });
  await wait("document.querySelectorAll('.source-candidates li').length===2");
  await check(
    "modify-project route opens real folder picker and filters hidden files",
    "!document.querySelector('.source-candidates').textContent.includes('.env')",
  );
  await ev(
    "[...document.querySelectorAll('dialog label')].find(x=>x.textContent.includes('我已检查资料')).querySelector('input').click()",
  );
  await click("上传选中的资料");
  await wait(
    "document.querySelector('dialog')?.textContent.includes('已上传 2 份')",
  );
  await ev(
    "[...document.querySelectorAll('dialog label')].find(x=>x.textContent.includes('我授权创建')).querySelector('input').click()",
  );
  await shot("project-import");
  await click("导入为可修改副本");
  await wait(
    "document.querySelector('dialog')?.textContent.includes('已导入可修改副本')",
  );
  await click("继续描述修改需求");
  await wait("!document.querySelector('dialog')");
  await check(
    "import prepares editable draft without sending a model request",
    "document.querySelector('#message-text').value.includes('修改的是')",
  );
  await project("深度澄清");
  await wait(
    "document.querySelectorAll('.core-clarification fieldset').length===2",
  );
  await check(
    "shared manager also renders grouped choices",
    "document.querySelectorAll('.core-clarification input[type=radio]').length===4",
  );
  await ev(
    "document.querySelector('.core-clarification fieldset:nth-of-type(1) input').click();document.querySelector('.core-clarification fieldset:nth-of-type(2) input').click()",
  );
  await fill(
    ".core-clarification fieldset:nth-of-type(1) textarea",
    "补充：先给两人试用",
  );
  await project("小店预约");
  await wait("document.querySelector('#message-text')");
  await project("深度澄清");
  await wait("document.querySelector('.core-clarification textarea')");
  await check(
    "shared question drafts remain bound to their task after navigation",
    "document.querySelector('.core-clarification textarea').value.includes('两人')&&document.querySelector('.core-clarification input[type=radio]').checked",
  );
  await size(1440, 1250);
  await shot("deep-questions");
  await size(1440);
  await click("提交全部回答");
  await wait("!document.querySelector('.core-clarification')");
  await check(
    "one shared-core submission resolves both questions",
    "!document.querySelector('.core-clarification')",
  );
  await project("小店预约");
  await wait("document.querySelector('#message-text')");
  await size(390, 844);
  await check(
    "mobile layout fits viewport",
    "document.documentElement.scrollWidth<=innerWidth",
  );
  await shot("mobile");
  await click("退出登录");
  await wait("document.querySelector('input[name=email]')");
  await check(
    "logout revokes the server session",
    "(async()=>{const r=await fetch('/api/v1/me');return r.status===401})()",
  );
  assert.equal(consoleErrors.length, 0, "uncaught browser errors");
  console.log(
    JSON.stringify({
      fixture: true,
      modelCalls: 0,
      checks: checks.length,
      passed: checks,
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
