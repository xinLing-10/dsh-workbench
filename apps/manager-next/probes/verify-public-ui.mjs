/** Real Chrome against the disposable local fixture. No production/model/real tool approval. */
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
if (!process.argv.includes("--public-ui"))
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
        encodeURIComponent(
          process.argv.includes("--default-entry")
            ? "https://8.153.164.227/login"
            : "https://8.153.164.227/_manager/next",
        ),
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
    throw Error(
      "Timeout " +
        expression +
        " " +
        JSON.stringify(
          await ev(
            "({path:location.pathname,text:document.body.innerText.slice(-800),errors:window.uiProbeErrors||[],emailFilled:!!document.querySelector('input[name=email]')?.value,passwordFilled:!!document.querySelector('input[name=password]')?.value})",
          ),
        ),
    );
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

  await ev(
    "window.NativeEventSource=window.EventSource;window.liveSources=0;window.EventSource=class extends window.NativeEventSource{constructor(...args){super(...args);window.liveSources++;this.fixtureClosed=false;}close(){if(!this.fixtureClosed){window.liveSources--;this.fixtureClosed=true;}super.close();}};window.originalFetch=window.fetch;window.sentRequests=[];window.loseOnce=false;window.fetch=async(...args)=>{if(args[1]?.method==='POST'&&String(args[0]).endsWith('/messages')){window.sentRequests.push(JSON.parse(args[1].body));const r=await window.originalFetch(...args);if(window.loseOnce){window.loseOnce=false;throw Error('fixture lost ack');}return r;}return window.originalFetch(...args);};",
  );
  await wait(
    "Object.keys(document.querySelector('input[name=email]')).some(k=>k.startsWith('__reactProps'))",
  );
  await wait("!document.querySelector('input[name=email]').disabled");
  const probe = JSON.parse(
    await readFile("/tmp/manager-next-public-smoke.json", "utf8"),
  );
  await fill("[name=email]", probe.email);
  await fill("[name=password]", probe.password);
  await click("登录");
  await wait("document.querySelector('.sidebar')&&location.pathname==='/'");

  await check(
    "public HTTPS login uses original API cookie",
    "location.pathname==='/'&&document.querySelector('.sidebar')!==null",
  );
  await check(
    "disposable tenant is isolated",
    "(async()=>{const r=await(await fetch('/api/v1/projects')).json();return r.data.projects.every(p=>p.name==='虚构公网灰度检查')})()",
  );
  await click("＋ 新建项目");
  await wait("document.querySelector('dialog[open] input')");
  await fill("dialog input", "虚构公网灰度检查");
  await fill("dialog textarea", "仅验证页面，不调用模型或执行工具。");
  await click("创建并开始");
  await wait("document.querySelector('h1')?.textContent==='虚构公网灰度检查'");
  await wait("document.querySelector('.live-state')?.textContent==='实时连接'");
  await check(
    "project and live SSE work on public proxy",
    "location.pathname.startsWith('/projects/')&&window.liveSources===1",
  );
  await check(
    "ordinary customer cannot open admin API",
    "(async()=>{const r=await fetch('/api/v1/admin/service');return r.status===403})()",
  );
  await check(
    "updated customer guide is available",
    "(async()=>{const r=await fetch('/help');return r.ok&&(await r.text()).includes('回复逐步显示与断线恢复')})()",
  );
  await check(
    "browser never sent a model task",
    "window.sentRequests.length===0",
  );
  assert.equal(consoleErrors.length, 0);
  console.log(
    JSON.stringify({
      publicUi: true,
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
