"use client";
import { WorkflowPanel } from "./workflow-panel";
import { useState } from "react";
import type { BusinessTask } from "../lib/contracts";
import { operationLabels } from "../lib/send-ledger";
import { useWorkspace } from "./workspace-provider";
import { errorText } from "../lib/api-client";
type Learn = { action: string; planId?: string; lessonId?: string };
export function BusinessPanel({
  tasks,
  projectId,
  onContinue,
  onRefresh,
}: {
  tasks: BusinessTask[];
  projectId: string;
  onContinue: (t: BusinessTask, l?: Learn) => void;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice } = useWorkspace(),
    [busy, setBusy] = useState(false);
  async function mark(t: BusinessTask, lessonId: string, status: string) {
    if (busy) {
      notice("正在保存学习进度，请稍候。");
      return;
    }
    if (!t.learning?.plan) return;
    setBusy(true);
    try {
      await api(
        "POST",
        `/api/v1/projects/${projectId}/tasks/${t.id}/progress`,
        {
          revision: t.learning.revision,
          planId: t.learning.plan.id,
          lessonId,
          status,
        },
      );
      await onRefresh();
    } catch (e) {
      notice(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="business-panel" aria-label="任务与学习">
      <h2>任务与学习</h2>
      <p className="muted">
        对话可以延续同一个目标。执行结束后，请到“我的成果”阅读并确认交付。
      </p>
      {!tasks.length && <p>发送第一条消息后，这里会保存任务记录。</p>}
      {tasks.map((t) => (
        <article key={t.id}>
          <div className="row">
            <h3>{t.title}</h3>
            <span>
              {t.kind === "learning" ? "陪学" : "制作 / 答疑"} ·{" "}
              {operationLabels[t.state] || t.state}
            </span>
            <button onClick={() => onContinue(t)}>继续这个目标</button>
          </div>
          <p>
            {t.operations.length} 轮处理 · {t.artifacts.length} 份成果版本 ·{" "}
            {t.delivery === "confirmed"
              ? "成果已确认"
              : t.delivery === "needs_review"
                ? "成果待阅读确认"
                : "尚无正式成果"}
          </p>
          <WorkflowPanel projectId={projectId} task={t} onRefresh={onRefresh} />
          <details>
            <summary>处理与成果记录</summary>
            <ul>
              {t.operations.map((o, i) => (
                <li key={o.id}>
                  第 {i + 1} 轮：{operationLabels[o.state] || o.state}
                </li>
              ))}
              {t.artifacts.map((a) => (
                <li key={a.id}>
                  {a.path.split("/").at(-1)} · 第 {a.version} 版 ·{" "}
                  {a.confirmed ? "已确认" : "待确认"}
                </li>
              ))}
            </ul>
          </details>
          {t.learning?.plan && !t.workflow && (
            <div className="learning-lessons">
              <h4>{t.learning.plan.title}</h4>
              {t.learning.plan.lessons.map((l) => (
                <section key={l.id}>
                  <h4>
                    {l.title} · {l.minutes} 分钟
                  </h4>
                  <p>{l.objective}</p>
                  <p className="muted">
                    {l.status === "self-checked"
                      ? "已自评理解"
                      : l.status === "read"
                        ? "已阅读"
                        : "未阅读"}
                  </p>
                  <div className="row">
                    <button
                      onClick={() =>
                        onContinue(t, {
                          action: "lesson",
                          planId: t.learning!.plan!.id,
                          lessonId: l.id,
                        })
                      }
                    >
                      学习这节课
                    </button>
                    <button
                      aria-disabled={busy}
                      onClick={() => void mark(t, l.id, "read")}
                    >
                      标记已阅读
                    </button>
                    <button
                      onClick={() =>
                        onContinue(t, {
                          action: "reflect",
                          planId: t.learning!.plan!.id,
                          lessonId: l.id,
                        })
                      }
                    >
                      用自己的话复述
                    </button>
                    <button
                      aria-disabled={busy}
                      onClick={() => void mark(t, l.id, "self-checked")}
                    >
                      自评理解
                    </button>
                  </div>
                </section>
              ))}
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
