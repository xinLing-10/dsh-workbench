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
        encodeURIComponent("http://localhost:3118/login"),
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
      `(()=>{const b=[...document.querySelectorAll('button,a,summary')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing control '+${JSON.stringify(text)});b.click();})()`,
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
      join(root, "dsh-workbench/docs/round-three-" + name + ".png"),
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
  await size(1440, 1100);
  await wait("document.querySelector('input[name=email]')");
  await wait("!document.querySelector('input[name=email]').disabled");

  await fill("[name=email]", "next-admin@example.test");
  await fill("[name=password]", "Next-Fixture-2026!");
  await click("登录");
  await wait("document.querySelector('.project-card')");
  await cdp("Page.navigate", {
    url: "http://localhost:3118/projects/prj_round_three",
  });
  await wait("document.querySelectorAll('.katex').length>=4");
  await check(
    "inline, block, Greek and matrix formulas render",
    "document.querySelectorAll('.katex').length>=4 && document.querySelectorAll('.math-block').length>=2",
  );
  await check(
    "invalid formula preserves original",
    "[...document.querySelectorAll('.math-fallback')].some(x=>x.textContent.includes('unknownFormula'))",
  );
  await check(
    "money and inline code stay literal",
    "document.body.innerText.includes('$5 and $10') && [...document.querySelectorAll('code')].some(c=>c.textContent==='$x$')",
  );
  await check(
    "fonts are bundled and load",
    "document.fonts.ready.then(()=>document.fonts.check('16px KaTeX_Main'))",
  );
  await check(
    "raw math is available for copy",
    "document.querySelectorAll('button[aria-label=\"复制公式源码\"]').length>=4",
  );
  await shot("formulas");
  await click("任务与学习");
  await wait("document.querySelector('.lesson-quiz')");
  await check(
    "verified resource metadata shown in curriculum",
    "!!document.querySelector('.learning-resources a[href=\"https://example.com/guide\"]')",
  );
  await check(
    "answers start folded",
    "!document.querySelector('.lesson-quiz details').open",
  );
  await click("查看答案与解析");
  await check(
    "answers expand and render math",
    "document.querySelector('.lesson-quiz details').open && !!document.querySelector('.lesson-quiz details .katex')",
  );
  await ev(
    "document.querySelector('.learning-lessons').scrollIntoView({block:'start'})",
  );
  await shot("learning");
  await click("任务与学习");
  await ev(
    "[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith('我的成果')).click()",
  );
  await click("阅读");
  await wait("document.querySelector('.artifact-content .katex')");
  await check(
    "artifact preview uses the same renderer",
    "!!document.querySelector('.artifact-content .math-block .katex')",
  );
  await ev(
    "document.querySelector('.artifacts-panel button[aria-label=\"关闭成果\"]').click()",
  );
  await size(390, 844);
  await check(
    "mobile formulas do not overflow page",
    "document.documentElement.scrollWidth<=innerWidth",
  );
  await check(
    "long math scrolls within its own region",
    "[...document.querySelectorAll('.math-block')].some(e=>e.scrollWidth>e.clientWidth)",
  );
  await shot("mobile");
  await size(1440, 1100);
  await ev(
    "(async()=>{const r=await fetch('/api/v1/__fixture/stream-math',{method:'POST',headers:{'x-fixture-control':'1'}});if(!r.ok)throw Error('fixture stream failed')})()",
  );
  await wait(
    "document.querySelector('.stream-label') && document.body.innerText.includes('虚构公式流式测试')",
  );
  await sleep(900);
  await check(
    "unfinished math does not break streaming UI",
    "!!document.querySelector('#message-text') && document.body.innerText.includes('虚构公式流式测试')",
  );
  await wait(
    "!document.querySelector('.stream-label') && document.querySelectorAll('.katex').length>=6",
  );
  await check(
    "closed streaming math renders after terminal receipt",
    "[...document.querySelectorAll('.message.assistant')].at(-1).querySelectorAll('.katex').length===2",
  );
  await cdp("Page.reload");
  await wait("document.querySelectorAll('.katex').length>=6");
  await check(
    "formula history survives page reload",
    "document.querySelectorAll('.math-copy').length>=6",
  );
  assert.equal(consoleErrors.length, 0, "uncaught browser exceptions");
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
