/** Isolated disposable local fixture. No credentials, real users, model or shell execution. */
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDatabase } from "../../../services/product-api/src/db.mjs";
import {
  createApp,
  appendEvent,
} from "../../../services/product-api/src/app.mjs";
import {
  createTenant,
  createInvite,
  redeemInvite,
} from "../../../services/product-api/src/auth.mjs";
import { registerWorker } from "../../../services/product-api/src/workers.mjs";
import { createBridge } from "../../../services/product-api/src/bridge.mjs";
import { createDispatcher } from "../../../services/product-api/src/dispatcher.mjs";
import { createServiceBudget } from "../../../services/product-api/src/service-budget.mjs";
if (!process.argv.includes("--fixture"))
  throw Error("Explicit --fixture required");
const dir = await mkdtemp(join(tmpdir(), "manager-next-fixture-")),
  db = openDatabase(join(dir, "product.sqlite")),
  tenant = createTenant(db, { name: "虚构 Next.js 预览空间" }),
  invite = createInvite(db, { tenantId: tenant.id, ttlMs: 60000 }),
  user = await redeemInvite(db, {
    token: invite.token,
    email: "next-admin@example.test",
    password: "Next-Fixture-2026!",
  }),
  at = new Date().toISOString();
db.prepare("INSERT INTO platform_admins VALUES(?,?)").run(user.userId, at);
registerWorker(db, {
  workerId: "wrk_next_fixture",
  tenantId: tenant.id,
  secret: "synthetic-next-worker-secret-never-used-2026",
});
const other = createTenant(db, { name: "虚构独立客户" }),
  otherInvite = createInvite(db, { tenantId: other.id, ttlMs: 60000 });
await redeemInvite(db, {
  token: otherInvite.token,
  email: "next-customer@example.test",
  password: "Next-Fixture-2026!",
});
for (const [id, name, t] of [
  ["prj_next", "虚构演示 · 小店预约", tenant.id],
  ["prj_next_question", "虚构演示 · 多题问答", tenant.id],
  ["prj_next_other", "虚构独立客户项目", other.id],
])
  db.prepare(
    "INSERT INTO projects(id,tenant_id,name,workspace_key,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(id, t, name, id, at, at);
for (const [type, text] of [
  ["message_created", "我想给小店做一个简单的预约工具。"],
  [
    "message_completed",
    "# 先把最重要的事情做好\n\n这是虚构界面预览，**没有调用模型**。\n\n我们先完成：\n\n- 顾客预约时间\n- 店主查看安排\n- 提前取消预约\n\n你可以从“我的成果”阅读说明，也可以选择已有项目资料，和管家一起学习。",
  ],
])
  appendEvent(db, {
    tenantId: tenant.id,
    projectId: "prj_next",
    type,
    payload: { text, fixture: true },
  });
for (const version of [1, 2]) {
  const bytes = Buffer.from(
    "# 小店预约需求说明\n\n虚构文档，未调用模型。\n\n版本 " +
      version +
      "：顾客选择时间，店主确认预约。",
  );
  const id = "art_next_" + version;
  db.prepare("INSERT INTO artifact_index VALUES(?,?,?,?,?,?,0,?)").run(
    id,
    tenant.id,
    "prj_next",
    "reply-eng_fixture_0123456789.md",
    createHash("sha256").update(bytes).digest("hex"),
    version,
    at,
  );
  db.prepare("INSERT INTO artifact_contents VALUES(?,?,NULL,NULL,NULL)").run(
    id,
    bytes,
  );
}
const qs = [
  {
    id: "audience",
    question: "希望帮助哪些人？",
    multiSelect: true,
    options: [{ label: "店主" }, { label: "顾客" }],
  },
  { id: "goal", question: "最想学懂什么？", options: [] },
];
db.prepare(
  "INSERT INTO interaction_requests(id,tenant_id,project_id,kind,prompt,state,created_at,expires_at,questions_json) VALUES(?,?,?,'question',?,'pending',?,?,?)",
).run(
  "int_next_question",
  tenant.id,
  "prj_next_question",
  "虚构演示：先回答两个小问题",
  at,
  new Date(Date.now() + 3600000).toISOString(),
  JSON.stringify(qs),
);
const budget = createServiceBudget({ db });
for (const [scope, scopeId, limit] of [
  ["global", "*", 200000],
  ["user", user.userId, 50000],
  ["project", "prj_next", 30000],
])
  budget.policy(user.userId, {
    scope,
    scopeId,
    limit,
    window: "lifetime",
    revision: 0,
    reason: "虚构界面验证，不调用模型",
  });
const workspaceRoot = join(dir, "workspaces");
await mkdir(workspaceRoot);
const config = {
  port: 8106,
  simulate: true,
  simulationFlow: true,
  previewFixture: true,
  allowRedeem: true,
  maxBodyBytes: 65536,
  publicOrigin: "http://localhost:3100",
  workspaceRoot,
  sessionTtlMs: 86400000,
};
const app = createApp({ db, config, bridge: createBridge({ config }) }),
  dispatcher = createDispatcher({
    db,
    enabled: true,
    interactive: true,
    publish: app.publish,
  });
let pending = Promise.resolve();
const timer = setInterval(() => {
  pending = pending.then(() => dispatcher.tick()).catch(() => {});
}, 200);
const streams = new Set();
const server = createServer((q, r) => {
  if (
    q.method === "POST" &&
    q.url === "/api/v1/__fixture/stream" &&
    q.headers["x-fixture-control"] === "1" &&
    q.headers.origin === config.publicOrigin
  ) {
    const op = "op_fixture_stream_" + Date.now(),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO operations(id,tenant_id,project_id,type,request_id,payload_hash,state,created_at,updated_at) VALUES(?,?,?,'send_message',?,'fixture','running',?,?)",
    ).run(op, tenant.id, "prj_next", op, now, now);
    const chunks = [
      "# 虚构流式演示\n\n",
      "正在逐步展示模型文字。",
      "这是离线模拟，未调用真实模型。",
      "\n\n- 连接中断后可以继续查看。",
      "\n- 不会重新发送模型请求。",
    ];
    let index = 0,
      text = "";
    const tick = setInterval(() => {
      if (index < chunks.length) {
        text += chunks[index++];
        app.publish(
          appendEvent(db, {
            tenantId: tenant.id,
            projectId: "prj_next",
            operationId: op,
            type: "message_stream",
            payload: { requestId: "call_fixture", text, preview: true },
          }),
        );
      } else {
        clearInterval(tick);
        db.prepare("UPDATE operations SET state='completed' WHERE id=?").run(
          op,
        );
        app.publish(
          appendEvent(db, {
            tenantId: tenant.id,
            projectId: "prj_next",
            operationId: op,
            type: "message_completed",
            payload: { text, fixture: true },
          }),
        );
      }
    }, 1500);
    tick.unref();
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ fixture: true, modelCalls: 0 }));
    return;
  }

  if (
    q.method === "POST" &&
    q.url === "/api/v1/__fixture/disconnect-events" &&
    q.headers["x-fixture-control"] === "1" &&
    q.headers.origin === config.publicOrigin
  ) {
    r.writeHead(204);
    r.end();
    for (const stream of streams) stream.destroy();
    return;
  }
  if (q.method === "GET" && q.url?.endsWith("/events")) {
    streams.add(r);
    r.on("close", () => streams.delete(r));
  }
  void app.handle(q, r);
});
server.listen(8106, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      fixture: true,
      url: config.publicOrigin,
      apiPort: 8106,
      modelCalls: 0,
      directory: dir,
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    clearInterval(timer);
    server.closeAllConnections();
    await pending;
    server.close(() => {
      app.managerCore.dispose();
      db.close();
      process.exit(0);
    });
  });
