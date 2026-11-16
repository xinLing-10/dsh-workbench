"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, Detail, Message, Operation } from "../lib/contracts";
import { useWorkspace } from "./workspace-provider";
import { useProjectEvents } from "../hooks/use-project-events";
import { errorText } from "../lib/api-client";
import { BusinessPanel } from "./business-panel";
import { operationNote } from "../lib/send-ledger";
import { Markdown } from "./markdown";
import { InteractionCard } from "./interactions";
import { ArtifactPanel } from "./artifact-panel";
import { SourcesDialog } from "./sources-dialog";
const prompts = [
  "我有一个想法，帮我一起理清楚。",
  "我想修改已有项目，先帮我分析需要哪些资料。",
];
export function ProjectView({ projectId }: { projectId: string }) {
  const { api, notice, drafts, setDraft, ledger } = useWorkspace();
  const [detail, setDetail] = useState<Detail | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [showTasks, setShowTasks] = useState(false),
    [taskId, setTaskId] = useState<string | null>(
      () => ledger.pending(projectId)?.taskId || null,
    ),
    [mode, setMode] = useState<"work" | "learning">(
      () => ledger.pending(projectId)?.mode || "work",
    ),
    [learningAction, setLearningAction] = useState<{
      action: string;
      planId?: string;
      lessonId?: string;
    }>(() => ledger.pending(projectId)?.learning || { action: "question" }),
    [showArtifacts, setShowArtifacts] = useState(false),
    [sources, setSources] = useState(false),
    [sending, setSending] = useState(false),
    [stopping, setStopping] = useState(false),
    [loadError, setLoadError] = useState(""),
    [jump, setJump] = useState(false);
  const previews = useRef(new Map<string, Message>()),
    completed = useRef(new Set<string>());
  const mounted = useRef(true),
    version = useRef(0),
    sendEpoch = useRef(0),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
      sendEpoch.current++;
    };
  }, []);
  const refresh = useCallback(async () => {
    const revision = ++version.current;
    const [d, m, a] = await Promise.all([
      api<Detail>("GET", `/api/v1/projects/${projectId}`),
      api<{ messages: Message[] }>(
        "GET",
        `/api/v1/projects/${projectId}/messages?includePreview=1`,
      ),
      api<{ artifacts: Artifact[] }>(
        "GET",
        `/api/v1/projects/${projectId}/artifacts`,
      ),
    ]);
    if (!mounted.current || revision !== version.current) return;
    setDetail(d);
    for (const message of m.messages) {
      if (
        message.preview &&
        message.operationId &&
        !completed.current.has(message.operationId)
      ) {
        const old = previews.current.get(message.operationId);
        if (!old || Number(old.id) <= Number(message.id))
          previews.current.set(message.operationId, message);
      }
    }
    setMessages(
      [
        ...m.messages.filter((x) => !x.preview),
        ...[...previews.current.values()].filter(
          (x) => !completed.current.has(x.operationId!),
        ),
      ].sort((a, b) => Number(a.id) - Number(b.id)),
    );
    setArtifacts(a.artifacts);
    setLoadError("");
  }, [api, projectId]);
  useEffect(() => {
    void refresh().catch((e) => {
      if (mounted.current) setLoadError(errorText(e));
    });
  }, [refresh]);
  const live = useProjectEvents(projectId, refresh, notice, (event) => {
    if (event.type === "message_completed") {
      completed.current.add(event.operationId);
      previews.current.delete(event.operationId);
      setMessages((old) =>
        old.filter((x) => !(x.preview && x.operationId === event.operationId)),
      );
      return;
    }
    if (completed.current.has(event.operationId)) return;
    const old = previews.current.get(event.operationId);
    if (old && Number(old.id) >= event.id) return;
    const message: Message = {
      id: event.id,
      operationId: event.operationId,
      role: "system",
      text: event.payload.text!,
      preview: true,
      streamState: "generating",
    };
    previews.current.set(event.operationId, message);
    setMessages((old) =>
      [
        ...old.filter(
          (x) => !(x.preview && x.operationId === event.operationId),
        ),
        message,
      ].sort((a, b) => Number(a.id) - Number(b.id)),
    );
  });
  const latest = () => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    follow.current = true;
    setJump(false);
  };
  useEffect(() => {
    if (follow.current) requestAnimationFrame(latest);
  }, [messages, detail?.interactions]);
  const active = detail?.operations.find((x) =>
    ["queued", "running", "waiting"].includes(x.state),
  );
  const current =
    detail?.operations.find((x) => ["running", "waiting"].includes(x.state)) ||
    active ||
    [...(detail?.operations || [])].sort((a, b) =>
      (b.createdAt || "").localeCompare(a.createdAt || ""),
    )[0];
  const text = drafts[projectId] || "";
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (sending || !text.trim()) return;
    const attempt = ledger.attempt(
        projectId,
        text.trim(),
        () => crypto.randomUUID(),
        {
          mode,
          taskId,
          ...(mode === "learning" ? { learning: learningAction } : {}),
        },
      ),
      epoch = ++sendEpoch.current;
    setSending(true);
    try {
      const data = await api<{ operation: Operation }>(
        "POST",
        `/api/v1/projects/${projectId}/messages`,
        attempt,
      );
      ledger.acknowledge(projectId, attempt);
      if (!mounted.current || sendEpoch.current !== epoch) return;
      setDraft(projectId, (old) => (old.trim() === attempt.text ? "" : old));
      if (data.operation?.task) setTaskId(data.operation.task.id);
      setLearningAction({ action: "question" });
      if (data.operation)
        setDetail((old) =>
          old
            ? {
                ...old,
                operations: [
                  data.operation,
                  ...old.operations.filter((x) => x.id !== data.operation.id),
                ],
              }
            : old,
        );
      setSending(false);
      follow.current = true;
      try {
        await refresh();
      } catch {
        notice(
          "消息已送达，但最新进展暂未刷新。请重新打开项目，无需再次发送。",
        );
      }
    } catch (e) {
      if (mounted.current) notice(errorText(e));
    } finally {
      if (mounted.current && sendEpoch.current === epoch) setSending(false);
    }
  }
  async function stop() {
    if (!active || stopping) return;
    setStopping(true);
    try {
      await api("POST", `/api/v1/projects/${projectId}/actions`, {
        action: "cancel_operation",
        operationId: active.id,
        requestId: crypto.randomUUID(),
      });
      notice("停止请求已返回，请以最新执行回执为准。");
    } catch (e) {
      notice(errorText(e));
    } finally {
      sendEpoch.current++;
      setSending(false);
      setStopping(false);
      try {
        await refresh();
      } catch {
        notice("停止后的最新状态未刷新，请重新打开项目核对。");
      }
    }
  }
  function learn(hasSources: boolean) {
    setMode("learning");
    setTaskId(null);
    setLearningAction({ action: "plan" });
    setSources(false);
    setDraft(
      projectId,
      (hasSources
        ? "请依据我上传的项目资料，"
        : "请先询问我需要提供哪些项目资料，") +
        "帮我制定零基础学习计划，再从最基础的原理开始解释。请标明文件依据，不要执行命令。",
    );
    input.current?.focus();
  }
  return (
    <main className="project-page">
      <header className="project-heading">
        <div>
          <p className="eyebrow">和管家一起完成</p>
          <h1>{detail?.project.name || "正在打开项目…"}</h1>
        </div>
        <div className="row">
          <button
            onClick={() => setShowTasks(!showTasks)}
            aria-expanded={showTasks}
          >
            任务与学习
          </button>
          <button onClick={() => setSources(true)}>项目资料 / 学习</button>
          <button
            onClick={() => setShowArtifacts(!showArtifacts)}
            aria-expanded={showArtifacts}
          >
            我的成果 <span className="count">{artifacts.length}</span>
          </button>
        </div>
      </header>
      {showTasks && (
        <BusinessPanel
          tasks={detail?.tasks || []}
          projectId={projectId}
          onRefresh={refresh}
          onContinue={(t, learning) => {
            setTaskId(t.id);
            setMode(t.kind);
            setLearningAction(learning || { action: "question" });
            setShowTasks(false);
            if (learning)
              setDraft(
                projectId,
                learning.action === "lesson"
                  ? "请带我学习这节课。"
                  : "我对这节课的理解是：",
              );
            input.current?.focus();
          }}
        />
      )}
      <div
        className={"project-layout" + (showArtifacts ? " with-artifacts" : "")}
      >
        <section className="chat-panel" aria-label="管家对话">
          <div
            className="conversation-scroll"
            ref={scroll}
            onScroll={() => {
              if (!scroll.current) return;
              follow.current =
                scroll.current.scrollHeight -
                  scroll.current.clientHeight -
                  scroll.current.scrollTop <
                100;
              setJump(!follow.current);
            }}
          >
            {loadError && (
              <div className="error" role="alert">
                {loadError}
                <button
                  onClick={() =>
                    void refresh().catch((e) => notice(errorText(e)))
                  }
                >
                  重新加载
                </button>
              </div>
            )}
            {detail && !messages.length && !detail.interactions.length && (
              <div className="chat-welcome">
                <span className="hero-mark">✳</span>
                <h2>你好，我们从一个想法开始。</h2>
                <p>你可以说说想做什么，也可以让我带你学懂一个已有项目。</p>
                <div className="welcome-prompts">
                  {prompts.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setDraft(projectId, p);
                        input.current?.focus();
                      }}
                    >
                      {p} ↗
                    </button>
                  ))}
                  <button onClick={() => setSources(true)}>
                    带我学懂这个项目 ↗
                  </button>
                </div>
              </div>
            )}
            <ol className="messages">
              {messages.map((m, i) => (
                <li
                  className={
                    "message " + (m.role === "user" ? "mine" : "assistant")
                  }
                  key={m.id || i}
                >
                  <span className="message-avatar" aria-hidden="true">
                    {m.role === "user" ? "你" : "✳"}
                  </span>
                  <div className="message-body">
                    <div className="message-role">
                      {m.role === "user" ? "你" : "项目管家"}
                      {m.preview && (
                        <span className="stream-label">
                          {m.streamState === "interrupted"
                            ? "已中断 · 内容未完成"
                            : m.streamState === "waiting"
                              ? "等待你的回答 · 过程内容"
                              : "正在生成 · 尚未交付"}
                        </span>
                      )}
                    </div>
                    {m.task && (
                      <small className="muted">
                        {m.task.kind === "learning" ? "学习" : "任务"} ·{" "}
                        {m.task.title}
                      </small>
                    )}
                    {m.context && m.context.refs.length > 0 && (
                      <details className="context-evidence">
                        <summary>
                          本轮参考依据
                          {m.context.truncated ? "（部分摘录）" : ""}
                        </summary>
                        <ul>
                          {m.context.refs.map((r) => (
                            <li key={r.id}>
                              [{r.id}]{" "}
                              {r.path
                                ? `${r.path}:${r.startLine}—${r.endLine}`
                                : `对话记录 ${r.eventId}`}
                              {r.sha256 && (
                                <small> · 摘要 {r.sha256.slice(0, 12)}</small>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {m.role === "user" ? (
                      <p className="user-message">{m.text}</p>
                    ) : (
                      <Markdown text={m.text} />
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <div className="interactions">
              {detail?.interactions.map((x) => (
                <InteractionCard
                  key={x.id}
                  interaction={x}
                  projectId={projectId}
                  onRefresh={refresh}
                />
              ))}
            </div>
          </div>
          {jump && (
            <button className="jump-latest" onClick={latest}>
              回到最新 ↓
            </button>
          )}
          <div className="composer-area">
            <div className="dispatch-line">
              <span>
                {detail?.capabilities.paused
                  ? "模型调用已暂停，历史和成果仍可查看。"
                  : detail?.capabilities.simulation
                    ? "模拟验证 · 未调用真实模型。" +
                      operationNote(current?.state)
                    : current?.state === "waiting" &&
                        !detail?.interactions.length
                      ? "回答已保存，正在等待可用的执行资源。"
                      : operationNote(current?.state)}
              </span>
              <span className="live-state">{live}</span>
            </div>
            <form className="composer" onSubmit={send}>
              <div className="task-context row">
                <label>
                  本轮目标{" "}
                  <select
                    aria-label="本轮目标"
                    value={taskId || ""}
                    onChange={(e) => {
                      const t = detail?.tasks?.find(
                        (t) => t.id === e.target.value,
                      );
                      setTaskId(t?.id || null);
                      if (t) setMode(t.kind);
                      setLearningAction({ action: "question" });
                    }}
                  >
                    <option value="">开启新任务</option>
                    {detail?.tasks?.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.kind === "learning" ? "学习" : "任务"} · {t.title}
                      </option>
                    ))}
                  </select>
                </label>
                {(!taskId || mode === "learning") && (
                  <div
                    className="task-mode-actions"
                    role="group"
                    aria-label="本轮处理方式"
                  >
                    {!taskId && (
                      <>
                        <button
                          type="button"
                          aria-pressed={mode === "work"}
                          onClick={() => setMode("work")}
                        >
                          制作 / 答疑
                        </button>
                        <button
                          type="button"
                          aria-pressed={mode === "learning"}
                          onClick={() => setMode("learning")}
                        >
                          陪我学习
                        </button>
                      </>
                    )}
                    {mode === "learning" && (
                      <button
                        type="button"
                        aria-pressed={learningAction.action === "plan"}
                        onClick={() => {
                          setLearningAction({ action: "plan" });
                          if (!text.trim())
                            setDraft(
                              projectId,
                              "请根据当前项目资料，为零基础的我安排每天20分钟的学习计划。",
                            );
                        }}
                      >
                        制定学习计划
                      </button>
                    )}
                  </div>
                )}
              </div>
              <label className="sr-only" htmlFor="message-text">
                给管家发消息
              </label>
              <textarea
                id="message-text"
                ref={input}
                rows={3}
                maxLength={30000}
                placeholder="说说你的想法，或者问一个问题…"
                value={text}
                onChange={(e) => setDraft(projectId, e.target.value)}
              />
              <div className="composer-actions">
                <span className="muted">先沟通，操作前会征求你的许可</span>
                <div className="row">
                  {active &&
                    (detail?.capabilities.nativeStop ||
                      detail?.capabilities.workerProtocol ||
                      detail?.capabilities.simulation) && (
                      <button
                        type="button"
                        disabled={stopping}
                        onClick={() => void stop()}
                      >
                        {stopping ? "正在核对停止…" : "停止当前任务"}
                      </button>
                    )}
                  <button
                    type="submit"
                    className="primary send-button"
                    disabled={sending || !text.trim()}
                  >
                    <span aria-hidden="true">↑</span>
                    <span>{sending ? "发送中…" : "发送"}</span>
                  </button>
                </div>
              </div>
            </form>
            <small className="composer-footnote">
              管家的回答可能有疏漏，请阅读并确认重要成果。
            </small>
          </div>
        </section>
        {showArtifacts && (
          <ArtifactPanel
            projectId={projectId}
            artifacts={artifacts}
            onClose={() => setShowArtifacts(false)}
            onRefresh={refresh}
          />
        )}
      </div>
      {sources && (
        <SourcesDialog
          projectId={projectId}
          onClose={() => setSources(false)}
          onLearn={learn}
        />
      )}
    </main>
  );
}
