"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "./workspace-provider";
import type {
  Service,
  Invitations,
  IssuedInvitation,
  PendingCall,
} from "../lib/contracts";
import { errorText } from "../lib/api-client";
import { operationLabels } from "../lib/send-ledger";
const number = (v: number) => new Intl.NumberFormat("zh-CN").format(v || 0);
const sections = [
  ["overview", "服务概览"],
  ["budgets", "额度与用量"],
  ["executions", "任务与 Worker"],
  ["invitations", "邀请码"],
  ["audit", "管理记录"],
];
function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={
        "badge " +
        (["unknown", "uncertain", "failed"].includes(state)
          ? "warning"
          : state === "completed"
            ? "good"
            : "")
      }
    >
      {operationLabels[state] || state}
    </span>
  );
}
function PendingForm({
  call,
  act,
}: {
  call: PendingCall;
  act: (path: string, body: unknown) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <article className="console-card">
      <p>{call.id}</p>
      <p>
        预占 {number(call.reservation)} token · 已知实际{" "}
        {call.actual === null ? "未知" : number(call.actual)}
      </p>
      {call.state === "unknown" ? (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const f = new FormData(e.currentTarget);
            setBusy(true);
            try {
              await act("reconcile", {
                id: call.id,
                kind: call.kind,
                revision: call.revision,
                actual: Number(f.get("actual")),
                reason: f.get("reason"),
                evidence: f.get("evidence"),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            服务商实际 token
            <input
              name="actual"
              type="number"
              min={call.actual || 0}
              step={1}
              required
            />
          </label>
          <label>
            核对原因
            <input name="reason" minLength={4} maxLength={1000} required />
          </label>
          <label>
            账单或服务商凭证编号
            <input name="evidence" minLength={8} maxLength={2000} required />
          </label>
          <button disabled={busy}>登记实际用量并核销预占</button>
        </form>
      ) : (
        <p>请求仍在进行，请先刷新核对，不要重复派发。</p>
      )}
    </article>
  );
}
export function AdminPanel() {
  const { session, api, notice } = useWorkspace(),
    [data, setData] = useState<Service | null>(null),
    [invitations, setInvitations] = useState<Invitations | null>(null),
    [section, setSection] = useState("overview"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [scope, setScope] = useState("global"),
    [target, setTarget] = useState("*"),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [mode, setMode] = useState("new"),
    [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const load = useCallback(async () => {
    const [s, i] = await Promise.all([
      api<Service>("GET", "/api/v1/admin/service"),
      api<Invitations>("GET", "/api/v1/admin/invitations"),
    ]);
    setData(s);
    setInvitations(i);
    setError("");
  }, [api]);
  useEffect(() => {
    if (session.user.platformAdmin)
      void load().catch((e) => setError(errorText(e)));
  }, [load, session.user.platformAdmin]);
  useEffect(() => {
    setIssued(null);
  }, [section]);
  async function act(path: string, body: unknown) {
    if (busy) return false;
    setBusy(true);
    try {
      await api("POST", "/api/v1/admin/" + path, body);
      notice(
        path === "executions/check"
          ? "已核对原执行回执，没有重新派发。"
          : "已保存；没有重新派发任务或批准工具。",
      );
      try {
        await load();
      } catch {
        notice("操作已保存，但控制台刷新失败，请重新加载后核对。");
      }
      return true;
    } catch (e) {
      notice(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  if (!session.user.platformAdmin)
    return (
      <main className="admin-page">
        <h1>仅平台管理员可访问</h1>
        <Link href="/">返回项目</Link>
      </main>
    );
  if (!data || !invitations)
    return (
      <main className="admin-page">
        <h1>服务控制台</h1>
        <p>{error || "正在读取真实服务快照…"}</p>
        {error && (
          <button
            onClick={() => void load().catch((e) => setError(errorText(e)))}
          >
            重新加载
          </button>
        )}
      </main>
    );
  const d = data.dashboard,
    global = data.policies.find((p) => p.scope === "global"),
    targets =
      scope === "global"
        ? [{ id: "*", name: "所有用户和项目" }]
        : scope === "user"
          ? data.users.map((u) => ({ id: u.id, name: u.email }))
          : data.projects;
  const selected = data.policies.find(
      (p) => p.scope === scope && p.scopeId === target,
    ),
    pending = [
      ...data.pending,
      ...data.carryovers
        .filter((c) => (c.held || 0) > 0)
        .map((c) => ({
          ...c,
          kind: "legacy",
          state: "unknown",
          reservation: c.held || 0,
          actual: c.used || 0,
        })),
    ];
  const label = (s: string, id: string) =>
    s === "global"
      ? "所有用户和项目"
      : s === "user"
        ? data.users.find((u) => u.id === id)?.email || id
        : data.projects.find((p) => p.id === id)?.name || id;
  return (
    <main className="admin-page">
      <header className="console-header">
        <div>
          <p className="eyebrow">项目管家 / 服务管理</p>
          <h1>服务控制台</h1>
          <p className="muted">掌握运行状况，让每一次服务都有据可查。</p>
        </div>
        <div className="row">
          <Link className="button" href="/">
            返回项目
          </Link>
          <button
            onClick={() => void load().catch((e) => notice(errorText(e)))}
          >
            刷新数据 ↻
          </button>
        </div>
      </header>
      <nav className="console-tabs" aria-label="控制台分区">
        {sections.map(([key, title]) => (
          <button
            key={key}
            aria-current={section === key ? "page" : undefined}
            onClick={() => setSection(key)}
          >
            {title}
          </button>
        ))}
      </nav>
      <p className="console-status">
        {d.fixture ? "虚构演示 · 未调用模型 · " : ""}
        {data.enabled ? "正式服务已启用" : "正式服务未启用"} · 隔离 Worker{" "}
        {data.environment.workerReady ? "就绪" : "未就绪"} · 更新于{" "}
        {new Date(d.at).toLocaleTimeString("zh-CN")}
      </p>
      {section === "overview" && (
        <>
          <div className="console-metrics">
            {[
              ["已结算用量", number(d.model.settledTokens), "累计 token"],
              [
                "待核对请求",
                number(d.model.unknownRequests),
                "回执不完整时保留额度",
              ],
              ["排队任务", number(d.counts.queued), "等待执行的操作"],
              [
                "进行中任务",
                number((d.counts.running || 0) + (d.counts.waiting || 0)),
                "执行中与等待回答",
              ],
              [
                "活跃用户",
                number(d.totals.users),
                number(d.totals.tenants) + " 个租户",
              ],
              [
                "全局可用额度",
                global?.frozen ? "已冻结" : number(global?.remaining || 0),
                "受全局硬授权限制",
              ],
            ].map(([title, value, note]) => (
              <article className="metric-card" key={title}>
                <span>{title}</span>
                <strong>{value}</strong>
                <small>{note}</small>
              </article>
            ))}
          </div>
          <div className="console-grid">
            <article className="console-card">
              <h2>最近 7 天模型用量</h2>
              <p className="muted">UTC 自然日 · 已结算 token，不是人民币账单</p>
              <div className="usage-trend">
                {d.trend.map((x) => (
                  <div className="trend-column" key={x.date}>
                    <small>{number(x.tokens)}</small>
                    <div className="trend-track">
                      <div
                        style={{
                          height:
                            Math.max(
                              1,
                              (x.tokens /
                                Math.max(1, ...d.trend.map((v) => v.tokens))) *
                                100,
                            ) + "%",
                        }}
                      />
                    </div>
                    <small>{x.date.slice(5)}</small>
                  </div>
                ))}
              </div>
            </article>
            <article className="console-card">
              <h2>服务就绪检查</h2>
              {[
                ["模型准入", !d.paused],
                ["模型网关", data.environment.modelGateway],
                ["隔离 Worker", data.environment.workerReady],
                [
                  "全局预算",
                  !!global && !global.frozen && global.remaining > 0,
                ],
              ].map(([name, ready]) => (
                <p className="readiness-row" key={String(name)}>
                  <span>{name}</span>
                  <span className={"badge " + (ready ? "good" : "warning")}>
                    {ready ? "就绪" : "需核对"}
                  </span>
                </p>
              ))}
              <p className="muted">
                握手正常不代表队列正在推进，请同时查看待核对任务。
              </p>
            </article>
            <article className="console-card">
              <h2>需要关注</h2>
              <p>
                待核对任务 {number(d.counts.uncertain)} 项；未知模型用量{" "}
                {number(d.model.unknownRequests)} 笔。
              </p>
              {data.authorization && (
                <p>
                  硬授权 {number(data.authorization.tokenLimit)} token /{" "}
                  {number(data.authorization.maxRequests)} 次请求。
                </p>
              )}
              <p>未知用量先核对服务商回执，不重发原任务。</p>
            </article>
            <article className="console-card">
              <h2>API 运行信息</h2>
              <p>
                {d.process.node} · Schema {d.process.schema}
              </p>
              <p>
                已运行 {Math.floor(d.process.uptimeSeconds / 60)} 分钟 · 内存{" "}
                {Math.round(d.process.memoryBytes / 1048576)} MiB
              </p>
              <p className="muted">
                这是 API 进程快照；不提供宿主命令、进程重启或模型密钥编辑。
              </p>
            </article>
          </div>
        </>
      )}
      {section === "budgets" && (
        <>
          <h2>用户、项目与全局额度</h2>
          <p className="muted">
            三层均需可用。调整额度不重做任务，也不自动批准工具。
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "范围",
                    "对象",
                    "周期",
                    "上限",
                    "已用",
                    "预占",
                    "可用",
                    "状态",
                  ].map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.policies.map((p) => (
                  <tr key={p.scope + p.scopeId}>
                    <td>{p.scope}</td>
                    <td>{label(p.scope, p.scopeId)}</td>
                    <td>{p.window}</td>
                    <td>{number(p.limit)}</td>
                    <td>{number(p.used)}</td>
                    <td>{number(p.held)}</td>
                    <td>{number(p.remaining)}</td>
                    <td>
                      {p.frozen
                        ? "待核对，已冻结"
                        : p.remaining
                          ? "可用"
                          : "已用完或暂停"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form
            key={scope + target + selected?.revision}
            className="inline-form console-card"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act("budgets", {
                scope,
                scopeId: target,
                limit: Number(f.get("limit")),
                window: f.get("window"),
                revision: selected?.revision || 0,
                reason: f.get("reason"),
              });
            }}
          >
            <label>
              范围
              <select
                value={scope}
                onChange={(e) => {
                  const s = e.target.value;
                  setScope(s);
                  setTarget(
                    s === "global"
                      ? "*"
                      : s === "user"
                        ? data.users[0]?.id || ""
                        : data.projects[0]?.id || "",
                  );
                }}
              >
                <option value="global">全局</option>
                <option value="user">用户</option>
                <option value="project">项目</option>
              </select>
            </label>
            <label>
              对象
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {targets.map((x) => (
                  <option value={x.id} key={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              额度周期
              <select name="window" defaultValue={selected?.window || "month"}>
                <option value="month">UTC 自然月</option>
                <option value="day">UTC 自然日</option>
                <option value="lifetime">累计</option>
              </select>
            </label>
            <label>
              token 上限
              <input
                name="limit"
                type="number"
                min={0}
                step={1}
                defaultValue={selected?.limit}
                required
              />
            </label>
            <label>
              调整原因
              <input name="reason" minLength={4} maxLength={1000} required />
            </label>
            <button className="primary" disabled={busy || !target}>
              保存额度
            </button>
          </form>
          <h2>待核对用量</h2>
          {pending.map((c) => (
            <PendingForm key={c.id} call={c} act={act} />
          ))}
          {!pending.length && <p>没有待核对用量。</p>}
        </>
      )}
      {section === "executions" && (
        <>
          <h2>任务与 Worker</h2>
          <div className="row">
            {Object.entries(operationLabels).map(([key, title]) => (
              <span className="badge" key={key}>
                {title} {d.counts[key] || 0}
              </span>
            ))}
          </div>
          <div className="row queue-filter">
            <label>
              搜索项目、用户或任务
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <label>
              任务状态
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">全部状态</option>
                {Object.entries(operationLabels).map(([key, title]) => (
                  <option key={key} value={key}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>项目 / 用户</th>
                  <th>状态</th>
                  <th>Worker</th>
                  <th>更新时间</th>
                  <th>任务编号</th>
                </tr>
              </thead>
              <tbody>
                {d.queue
                  .filter(
                    (x) =>
                      (filter === "all" || x.state === filter) &&
                      [x.id, x.projectName, x.actorEmail, x.tenantName]
                        .join(" ")
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                  )
                  .map((x) => (
                    <tr key={x.id}>
                      <td>
                        {x.projectName}
                        <small>{x.actorEmail}</small>
                      </td>
                      <td>
                        <StateBadge state={x.state} />
                      </td>
                      <td>{x.workerId || "尚未分配"}</td>
                      <td>{new Date(x.updated_at).toLocaleString("zh-CN")}</td>
                      <td>{x.id}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="console-grid">
            {d.workers.map((w) => (
              <article className="console-card" key={w.id}>
                <h3>{w.id}</h3>
                <p>
                  {w.status === "active" ? "登记有效" : "已停用"} · 握手{" "}
                  {w.reported ? (w.connected ? "已连接" : "未连接") : "未报告"}
                </p>
                <p>
                  隔离{" "}
                  {w.reported ? (w.isolated ? "已验证" : "未就绪") : "未报告"} ·
                  非终态执行 {w.active}
                </p>
              </article>
            ))}
          </div>
          <h2>待核对执行回执</h2>
          {data.executions.map((x) => (
            <div className="console-card row" key={x.operation_id}>
              <span>
                {label("project", x.project_id)} ·{" "}
                {operationLabels[x.state] || x.state} · {x.operation_id}
              </span>
              <button
                disabled={busy}
                onClick={() => {
                  if (!d.capabilities.recovery) {
                    notice("观察通道未连接，请先由运维配置，不会重发任务。");
                    return;
                  }
                  void act("executions/check", { operationId: x.operation_id });
                }}
              >
                核对执行回执
              </button>
            </div>
          ))}
          {!data.executions.length && <p>没有进行中或待核对执行。</p>}
        </>
      )}
      {section === "invitations" && (
        <>
          <h2>邀请码管理</h2>
          <p>
            一次性邀请创建普通账号，不授予管理员身份，也不会自动分配模型额度。
          </p>
          <p role="status">
            {invitations.enabled
              ? "邀请兑换已开放。"
              : "邀请兑换关闭，请由运维启用后刷新；此页面不会自动开放注册。"}
          </p>
          <form
            className="console-card inline-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              if (!invitations.enabled) {
                notice("邀请兑换未开放，请由运维启用后刷新。");
                return;
              }
              const f = new FormData(e.currentTarget);
              setBusy(true);
              setIssued(null);
              try {
                const result = await api<IssuedInvitation>(
                  "POST",
                  "/api/v1/admin/invitations",
                  {
                    mode,
                    name: f.get("name") || "",
                    tenantId: f.get("tenantId") || "",
                    hours: Number(f.get("hours")),
                    confirmShared: f.get("confirmShared") === "on",
                  },
                );
                setIssued(result);
                try {
                  await load();
                } catch {
                  notice("邀请码已生成，列表未刷新，请勿重复生成。");
                }
              } catch (e) {
                notice(
                  errorText(e) +
                    " 如连接中断，请先刷新列表核对，不会自动重试。",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              邀请方式
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="new">新建独立租户（推荐）</option>
                <option value="existing">加入已有租户</option>
              </select>
            </label>
            {mode === "new" ? (
              <label>
                新租户名称
                <input name="name" maxLength={80} required />
              </label>
            ) : (
              <>
                <label>
                  已有租户
                  <select name="tenantId">
                    {invitations.tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="question-option">
                  <input type="checkbox" name="confirmShared" required />
                  我确认新用户将加入该租户并共享其项目权限。
                </label>
              </>
            )}
            <label>
              有效期
              <select name="hours" defaultValue="72">
                <option value="24">24 小时</option>
                <option value="72">72 小时</option>
                <option value="168">7 天</option>
              </select>
            </label>
            <button className="primary" disabled={busy}>
              生成一次性邀请码
            </button>
          </form>
          {issued && (
            <article className="console-card invite-result">
              <h3>请及时复制，本次明文仅在这里显示</h3>
              <p>
                {issued.tenantName} · 有效至{" "}
                {new Date(issued.expiresAt).toLocaleString("zh-CN")}
              </p>
              <input
                aria-label="本次邀请码"
                readOnly
                value={issued.token}
                onFocus={(e) => e.target.select()}
              />
              <div className="row">
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(issued.token);
                      notice("已复制，请通过私密渠道交给指定用户。");
                    } catch {
                      notice("浏览器未允许自动复制，请选中后手动复制。");
                    }
                  }}
                >
                  复制邀请码
                </button>
                <button onClick={() => setIssued(null)}>隐藏明文</button>
              </div>
            </article>
          )}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>租户</th>
                  <th>状态</th>
                  <th>到期时间</th>
                  <th>使用账号</th>
                  <th>编号</th>
                </tr>
              </thead>
              <tbody>
                {invitations.invitations.map((i) => (
                  <tr key={i.id}>
                    <td>{i.tenantName}</td>
                    <td>
                      {(
                        {
                          available: "待使用",
                          used: "已使用",
                          expired: "已过期",
                        } as Record<string, string>
                      )[i.status] || i.status}
                    </td>
                    <td>{new Date(i.expiresAt).toLocaleString("zh-CN")}</td>
                    <td>{i.redeemedBy || "—"}</td>
                    <td>{i.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {section === "audit" && (
        <>
          <h2>管理记录</h2>
          {data.audit.map((x, i) => (
            <details className="console-card" key={i}>
              <summary>
                {x.at} · {x.action} · {x.target} · {x.actor}
              </summary>
              <pre>{x.meta_json}</pre>
            </details>
          ))}
          {!data.audit.length && <p>暂无管理记录。</p>}
        </>
      )}
    </main>
  );
}
