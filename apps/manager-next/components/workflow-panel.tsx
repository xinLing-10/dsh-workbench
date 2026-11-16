"use client";
import { useState, useEffect, useRef } from "react";
import { useWorkspace } from "./workspace-provider";
import { ApiError, errorText } from "../lib/api-client";
import { DeliveryTemplates } from "./delivery-templates";
import { LearningDetails } from "./learning-details";
import type { ComponentProps } from "react";
import { Markdown } from "./markdown";
import type { BusinessTask } from "../lib/contracts";
type Message = { id: string; role: string; text: string };
type Plan = {
  id: string;
  title: string;
  lessons: { id: string; title: string; objective: string }[];
};
type Workflow = {
  revision: number;
  receipts: string[];
  available: boolean;
  complete: boolean;
  nextStage: string | null;
  contract: { goal: string; mode?: string } | null;
  messages: Message[];
  jobs: { id: string; status: string; error?: string }[];
  proposal: { id: string; instruction: string } | null;
  review: { stages: Record<string, { hashes: Record<string, string | null> }> };
  outputs: { name: string; stage: string; hash: string; confirmed: boolean }[];
  buildChecks: { id: string; label?: string; text?: string }[];
  delivery?: { count: number };
  learning: ComponentProps<typeof LearningDetails>["learning"] & {
    plan?: Plan;
    previousPlans?: Plan[];
    messages: Message[];
    coach?: { id: string; step: string; paused?: boolean };
    export?: { format: string };
  };
};
const titles: Record<string, string> = {
  spec: "需求文档",
  design: "设计方案",
  build: "产品制作",
  verify: "验证结果",
  ship: "交付准备",
};
export function WorkflowPanel({
  projectId,
  task,
  onRefresh,
}: {
  projectId: string;
  task: BusinessTask;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice } = useWorkspace(),
    base = `/api/v1/projects/${projectId}/tasks/${task.id}`;
  const [open, setOpen] = useState(false),
    [v, setV] = useState<Workflow | null>(null),
    [busy, setBusy] = useState(false),
    [text, setText] = useState(""),
    [mode, setMode] = useState("software"),
    [paths, setPaths] = useState<string[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [read, setRead] = useState<Record<string, string>>({}),
    [checks, setChecks] = useState<string[]>([]),
    [document, setDocument] = useState<{ name: string; text: string } | null>(
      null,
    ),
    [consent, setConsent] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  async function load() {
    const r = await api<{ manager: Workflow }>("GET", base + "/workflow");
    setV(r.manager);
    if (
      pending.current &&
      r.manager.receipts.includes(String(pending.current.requestId))
    ) {
      pending.current = null;
      setUncertain(false);
    }
    return r.manager;
  }
  useEffect(() => {
    if (!open) return;
    void load().catch((e) => notice(errorText(e)));
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [open, base]);
  async function act(
    action: string,
    extra: Record<string, unknown> = {},
    retry = false,
  ) {
    if (busy) {
      notice("正在保存，请稍候。");
      return;
    }
    if (uncertain && !retry) {
      notice("上次操作回执不明确，请先点击核对上次操作。");
      return;
    }
    if (!v) return;
    const body = retry
      ? pending.current
      : {
          action,
          revision: v.revision,
          requestId: crypto.randomUUID(),
          ...extra,
        };
    if (!body) return;
    setBusy(true);
    pending.current = body;
    try {
      const r = await api<{ manager: Workflow }>(
        "POST",
        base + "/workflow",
        body,
      );
      setV(r.manager);
      pending.current = null;
      setUncertain(false);
      await onRefresh();
    } catch (e) {
      notice(errorText(e));
      if (
        e instanceof ApiError &&
        !["network_uncertain", "response_uncertain"].includes(e.code) &&
        e.status < 500
      ) {
        pending.current = null;
        setUncertain(false);
        await load().catch(() => {});
        return;
      }
      try {
        const latest = await load();
        if (pending.current) {
          if (latest.revision === body.revision) setUncertain(true);
          else {
            pending.current = null;
            notice("项目已有新状态，请核对后重新安排。");
          }
        }
      } catch {
        setUncertain(true);
      }
    } finally {
      setBusy(false);
    }
  }
  const active = v?.jobs.some((j) =>
      [
        "queued",
        "creating",
        "submitting",
        "running",
        "cancelling",
        "uncertain",
      ].includes(j.status),
    ),
    stage = v?.nextStage,
    stageOutputs = v?.outputs.filter((o) => o.stage === stage) || [];
  async function readDocument(name: string) {
    try {
      const d = await api<{ name: string; text: string; contentHash: string }>(
        "GET",
        base + "/document-review?name=" + encodeURIComponent(name),
      );
      setDocument(d);
      setRead((old) => ({ ...old, [name]: d.contentHash }));
    } catch (e) {
      notice(errorText(e));
    }
  }
  async function sources() {
    try {
      const r = await api<{ files: string[] }>(
        "GET",
        base + "/learning-sources",
      );
      const files = r.files.filter(
        (p) =>
          !/^references\/tsk_[a-zA-Z0-9_]+-用户资料\.md$/.test(p) ||
          p === `references/${task.id}-用户资料.md`,
      );
      setPaths(files);
      setSelected(files.filter((p) => p.startsWith("references/")).slice(0, 2));
    } catch (e) {
      notice(errorText(e));
    }
  }
  return (
    <section className="workflow-card">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "收起" : "打开"}
        {task.kind === "learning" ? "深度陪学" : "阶段与交付"}
      </button>
      {open &&
        (!v ? (
          <p>正在读取流程记录…</p>
        ) : (
          <>
            <p className="muted">
              {task.kind === "learning"
                ? "选资料 → 安排课程 → 逐步理解 → 保存学习资料。"
                : "沟通目标 → 准备文档 → 阅读确认 → 进入下一步。每次执行需由你确认。"}
            </p>
            {!v.available && (
              <p role="status">执行服务尚未接通，当前只能查看记录。</p>
            )}
            {uncertain && (
              <button onClick={() => void act("", {}, true)}>
                核对上次操作（沿用原请求编号）
              </button>
            )}
            {task.kind !== "learning" && (
              <>
                <ol className="workflow-stages">
                  {Object.entries(titles)
                    .filter(
                      ([id]) =>
                        (v.contract?.mode !== "requirements" &&
                          v.contract?.mode !== "design") ||
                        id === "spec" ||
                        (v.contract?.mode === "design" && id === "design"),
                    )
                    .map(([id, label]) => (
                      <li
                        key={id}
                        aria-current={stage === id ? "step" : undefined}
                      >
                        {label}
                        {stage === id ? " · 当前" : ""}
                      </li>
                    ))}
                </ol>
                {!v.contract ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act("configure", { goal: text, mode });
                    }}
                  >
                    <label>
                      这次希望交付什么
                      <select
                        value={mode}
                        onChange={(e) => setMode(e.target.value)}
                      >
                        <option value="software">可用产品与文档</option>
                        <option value="requirements">需求文档</option>
                        <option value="design">实施方案</option>
                      </select>
                    </label>
                    <label>
                      描述目标
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        required
                      />
                    </label>
                    <button>保存交付目标</button>
                  </form>
                ) : (
                  <>
                    <p>
                      交付目标：{v.contract.goal} ·{" "}
                      {v.complete
                        ? "全部文档已确认"
                        : `当前：${titles[stage || ""] || "处理中"}`}
                    </p>
                    {v.messages.slice(-8).map((m) => (
                      <article key={m.id}>
                        <strong>{m.role === "user" ? "你" : "管家"}</strong>
                        <Markdown text={m.text} />
                      </article>
                    ))}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (active) {
                          notice("当前仍在处理，请先等待或停止。");
                          return;
                        }
                        void act("message", { text });
                      }}
                    >
                      <label>
                        继续沟通
                        <textarea
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                          required
                        />
                      </label>
                      <button aria-disabled={busy || active}>发送给管家</button>
                    </form>
                    {v.proposal && (
                      <div>
                        <p>下一步安排：{v.proposal.instruction}</p>
                        <button
                          onClick={() =>
                            void act("dispatch", { proposalId: v.proposal!.id })
                          }
                        >
                          按此安排开始
                        </button>
                      </div>
                    )}
                    {stageOutputs.length > 0 && (
                      <fieldset>
                        <legend>阅读并确认当前文档</legend>
                        {stageOutputs
                          .filter((o) => /\.md$/i.test(o.name))
                          .map((o) => (
                            <button
                              key={o.name}
                              onClick={() => void readDocument(o.name)}
                            >
                              {o.name}
                              {read[o.name] === o.hash ? " · 已打开" : ""}
                            </button>
                          ))}
                        {v.buildChecks.length > 0 &&
                          stage === "build" &&
                          v.buildChecks.map((c) => (
                            <label key={c.id}>
                              <input
                                type="checkbox"
                                checked={checks.includes(c.id)}
                                onChange={(e) =>
                                  setChecks(
                                    e.target.checked
                                      ? [...checks, c.id]
                                      : checks.filter((id) => id !== c.id),
                                  )
                                }
                              />
                              {c.label || c.text || c.id}
                            </label>
                          ))}
                        <label>
                          <input
                            type="checkbox"
                            checked={consent}
                            onChange={(e) => setConsent(e.target.checked)}
                          />
                          我已核对当前版本，愿意确认；文件齐全不代表测试通过
                        </label>
                        <button
                          onClick={() => {
                            if (
                              !consent ||
                              stageOutputs.some(
                                (o) =>
                                  /\.md$/i.test(o.name) &&
                                  read[o.name] !== o.hash,
                              )
                            ) {
                              notice("请先打开当前所有文档，阅读后勾选确认。");
                              return;
                            }
                            void act("approve", {
                              stage,
                              reviewed: true,
                              hashes: v.review.stages[stage!].hashes,
                              checks,
                            });
                            setConsent(false);
                          }}
                        >
                          确认这一阶段
                        </button>
                      </fieldset>
                    )}
                    {v.complete && (
                      <button onClick={() => void act("package")}>
                        整理已确认的交付包
                      </button>
                    )}
                    {v.delivery && (
                      <a className="button" href={base + "/workflow/download"}>
                        下载交付包（{v.delivery.count} 份文档）
                      </a>
                    )}
                  </>
                )}
              </>
            )}
            {task.kind === "learning" && (
              <>
                <button onClick={() => void sources()}>
                  选择本项目的学习资料
                </button>
                {paths.map((p) => (
                  <label className="workflow-source" key={p}>
                    <input
                      type="checkbox"
                      checked={selected.includes(p)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, p]
                            : selected.filter((x) => x !== p),
                        )
                      }
                    />
                    {p === `references/${task.id}-用户资料.md`
                      ? "你上传的项目资料（节选）"
                      : p}
                  </label>
                ))}
                <label>
                  想学什么或想问的问题
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                  />
                </label>
                <div className="row">
                  {[
                    ["learning-plan", "制定学习计划"],
                    ["learning-map", "整理知识地图"],
                    ["learning-materials", "整理原理与术语"],
                    ["learn", "解答问题"],
                  ].map(([action, label]) => (
                    <button
                      key={action}
                      onClick={() => {
                        if (!selected.length) {
                          notice("请先选择允许管家阅读的资料。");
                          return;
                        }
                        void act(action, {
                          paths: selected,
                          text,
                          goal: text,
                          level: "zero",
                          minutes: 20,
                        });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {v.learning.plan && (
                  <section>
                    <h4>{v.learning.plan.title}</h4>
                    {v.learning.plan.lessons.map((l) => (
                      <article key={l.id}>
                        <h4>{l.title}</h4>
                        <p>{l.objective}</p>
                        <button
                          onClick={() =>
                            void act("learning-lesson", {
                              paths: selected,
                              planId: v.learning.plan!.id,
                              lessonId: l.id,
                            })
                          }
                        >
                          从这节课开始
                        </button>
                        <button
                          onClick={() =>
                            void act("learning-progress", {
                              planId: v.learning.plan!.id,
                              lessonId: l.id,
                              status: "read",
                            })
                          }
                        >
                          标记已阅读
                        </button>
                        <button
                          onClick={() =>
                            void act("learning-reflect", {
                              planId: v.learning.plan!.id,
                              lessonId: l.id,
                              paths: selected,
                              text,
                            })
                          }
                        >
                          提交上方填写的复述
                        </button>
                        <button
                          onClick={() =>
                            void act("learning-progress", {
                              planId: v.learning.plan!.id,
                              lessonId: l.id,
                              status: "self-checked",
                            })
                          }
                        >
                          自评理解
                        </button>
                      </article>
                    ))}
                  </section>
                )}
                {v.learning.previousPlans?.length ? (
                  <details>
                    <summary>历史学习计划</summary>
                    {v.learning.previousPlans.map((p) => (
                      <p key={p.id}>
                        {p.title}
                        <button
                          onClick={() =>
                            void act("learning-plan-restore", { planId: p.id })
                          }
                        >
                          切换到这个计划
                        </button>
                      </p>
                    ))}
                  </details>
                ) : null}
                {v.learning.coach && (
                  <div>
                    <p>
                      当前陪学步骤：
                      {(
                        {
                          diagnostic: "聊聊已有理解",
                          explain: "一起理解原理",
                          practice: "试着解释一下",
                          feedback: "核对与澄清",
                          transfer: "换个场景想一想",
                          review: "回顾与复习",
                        } as Record<string, string>
                      )[v.learning.coach.step] || "陪学中"}
                    </p>
                    {[
                      ["learning-coach-answer", "提交我的理解"],
                      ["learning-coach-help", "再解释一下"],
                      ["learning-coach-next", "继续下一步"],
                      ["learning-coach-skip", "暂时跳过"],
                    ].map(([action, label]) => (
                      <button
                        key={action}
                        onClick={() =>
                          void act(action, {
                            paths: selected,
                            text,
                            coachId: v.learning.coach!.id,
                            step: v.learning.coach!.step,
                            variant: "simplify",
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                <LearningDetails
                  learning={v.learning}
                  paths={selected}
                  text={text}
                  act={act}
                  notice={notice}
                />
                {v.learning.messages.slice(-8).map((m) => (
                  <article key={m.id}>
                    <strong>{m.role === "user" ? "你" : "陪学管家"}</strong>
                    <Markdown text={m.text} />
                  </article>
                ))}
                <button
                  onClick={() => void act("learning-export", { format: "zip" })}
                >
                  保存学习资料包
                </button>
                {v.learning.export && (
                  <a
                    className="button"
                    href={base + "/workflow/download?kind=learning"}
                  >
                    下载学习资料
                  </a>
                )}
              </>
            )}
            {task.kind !== "learning" && (
              <DeliveryTemplates
                base={base}
                projectId={projectId}
                onRefresh={onRefresh}
              />
            )}
            {document && (
              <section className="workflow-document">
                <h4>{document.name}</h4>
                <Markdown text={document.text} />
                <button onClick={() => setDocument(null)}>收起正文</button>
              </section>
            )}
            {active && (
              <button
                onClick={() =>
                  void act(
                    v.jobs.some((j) => j.status === "uncertain")
                      ? "recheck"
                      : "cancel",
                  )
                }
              >
                {v.jobs.some((j) => j.status === "uncertain")
                  ? "核对执行回执"
                  : "停止当前安排"}
              </button>
            )}
            {v.jobs
              .filter((j) => j.error)
              .slice(-2)
              .map((j) => (
                <p key={j.id} role="status">
                  {j.error}
                </p>
              ))}
          </>
        ))}
    </section>
  );
}
