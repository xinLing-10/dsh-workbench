"use client";
import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { errorText } from "../lib/api-client";
type Block = {
  type: string;
  id: string;
  stage: string;
  text: string;
  options?: string[];
  answer?: string;
};
type State = {
  revision: number;
  nextStage: string | null;
  messages: { blocks?: Block[] }[];
};
/** Same shared manager record, one revision-fenced grouped answer. No tool approval here. */
export function CoreClarification({
  projectId,
  taskId,
  refreshVersion,
  onRefresh,
}: {
  projectId: string;
  taskId: string;
  refreshVersion: unknown;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice, questionDrafts, setQuestionDraft, clearQuestionDraft } =
      useWorkspace(),
    base = `/api/v1/projects/${projectId}/tasks/${taskId}/workflow`;
  const [state, setState] = useState<State | null>(null),
    [loadError, setLoadError] = useState(""),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  const answerKey = `core:${projectId}:${taskId}`;
  const answers = Object.fromEntries(
    Object.entries(questionDrafts[answerKey] || {}).map(([id, value]) => [
      id,
      { option: value.selected[0] || "", custom: value.custom },
    ]),
  );
  const setAnswers = (
    update: (
      old: Record<string, { option: string; custom: string }>,
    ) => Record<string, { option: string; custom: string }>,
  ) =>
    setQuestionDraft(answerKey, (old) =>
      Object.fromEntries(
        Object.entries(
          update(
            Object.fromEntries(
              Object.entries(old).map(([id, value]) => [
                id,
                { option: value.selected[0] || "", custom: value.custom },
              ]),
            ),
          ),
        ).map(([id, value]) => [
          id,
          {
            selected: value.option ? [value.option] : [],
            custom: value.custom,
          },
        ]),
      ),
    );
  const pending = useRef<Record<string, unknown> | null>(null),
    epoch = useRef(0);
  useEffect(() => {
    let live = true;
    const generation = ++epoch.current;
    api<{ manager: State }>("GET", base)
      .then((r) => {
        if (live && epoch.current === generation) {
          setState(r.manager);
          setLoadError("");
        }
      })
      .catch((error) => {
        if (live && epoch.current === generation)
          setLoadError(errorText(error));
      });
    return () => {
      live = false;
      epoch.current++;
    };
  }, [api, base, refreshVersion, reload]);
  const questions = [
    ...new Map(
      (
        (state?.messages || []).findLast((m) =>
          (m.blocks || []).some(
            (q) =>
              q.type === "question" && q.stage === (state?.nextStage || "ship"),
          ),
        )?.blocks || []
      )
        .filter(
          (q) =>
            q.type === "question" &&
            !q.answer &&
            q.stage === (state?.nextStage || "ship"),
        )
        .map((q) => [q.id, q]),
    ).values(),
  ].slice(-3);
  if (loadError)
    return (
      <p role="alert">
        关键选择暂未加载：{loadError}
        <button type="button" onClick={() => setReload((n) => n + 1)}>
          重新加载问题
        </button>
      </p>
    );
  if (!questions.length) return null;
  return (
    <form
      className="interaction core-clarification"
      aria-label="集中确认关键选择"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !state) return;
        const values = questions.map((q) => ({
          questionId: q.id,
          text: [answers[q.id]?.option, answers[q.id]?.custom?.trim()]
            .filter(Boolean)
            .join("；补充："),
        }));
        if (values.some((v) => !v.text)) {
          notice("请为每题选择选项或填写补充。");
          return;
        }
        const body = pending.current || {
          action: "answer-batch",
          answers: values,
          revision: state.revision,
          requestId: crypto.randomUUID(),
        };
        pending.current = body;
        setBusy(true);
        try {
          const result = await api<{ manager: State }>("POST", base, body);
          setState(result.manager);
          pending.current = null;
          clearQuestionDraft(answerKey);
          try {
            await onRefresh();
          } catch {
            notice("回答已保存，请勿重复提交。");
          }
        } catch (error) {
          notice(errorText(error) + " 请先核对最新问题，勿另发重复回答。");
          try {
            const result = await api<{ manager: State }>("GET", base);
            setState(result.manager);
            if (result.manager.revision !== body.revision)
              pending.current = null;
          } catch {}
        } finally {
          setBusy(false);
        }
      }}
    >
      <strong>本轮关键选择 · 一次提交</strong>
      {questions.map((q) => {
        const saved = answers[q.id] || { option: "", custom: "" };
        return (
          <fieldset key={q.id} disabled={busy || !!pending.current}>
            <legend>{q.text}</legend>
            {(q.options || []).map((option) => (
              <label className="question-option" key={option}>
                <input
                  type="radio"
                  name={taskId + q.id}
                  checked={saved.option === option}
                  onChange={() =>
                    setAnswers((old) => ({
                      ...old,
                      [q.id]: { ...saved, option },
                    }))
                  }
                />
                {option}
              </label>
            ))}
            <label>
              补充说明或其他回答
              <textarea
                rows={2}
                maxLength={1800}
                value={saved.custom}
                onChange={(e) =>
                  setAnswers((old) => ({
                    ...old,
                    [q.id]: { ...saved, custom: e.target.value },
                  }))
                }
              />
            </label>
          </fieldset>
        );
      })}
      <button className="primary" disabled={busy}>
        {busy
          ? "正在提交…"
          : pending.current
            ? "核对并重试原回答"
            : "提交全部回答"}
      </button>
    </form>
  );
}
