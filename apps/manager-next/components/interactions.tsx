"use client";
import { useEffect, useState } from "react";
import type { Interaction } from "../lib/contracts";
import { useWorkspace } from "./workspace-provider";
import { errorText } from "../lib/api-client";
export function InteractionCard({
  interaction,
  projectId,
  onRefresh,
}: {
  interaction: Interaction;
  projectId: string;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice, questionDrafts, setQuestionDraft, clearQuestionDraft } =
      useWorkspace(),
    [busy, setBusy] = useState(false),
    [expired, setExpired] = useState(false);
  const answers = questionDrafts[interaction.id] || {};
  const setAnswers = (
    update: (
      old: Record<string, { selected: string[]; custom: string }>,
    ) => Record<string, { selected: string[]; custom: string }>,
  ) => setQuestionDraft(interaction.id, update);
  useEffect(() => {
    if (!interaction.expiresAt) return;
    const ms = Date.parse(interaction.expiresAt) - Date.now();
    if (ms <= 0) {
      setExpired(true);
      clearQuestionDraft(interaction.id);
      return;
    }
    const t = setTimeout(
      () => {
        setExpired(true);
        clearQuestionDraft(interaction.id);
      },
      Math.min(ms, 2147483647),
    );
    return () => clearTimeout(t);
  }, [interaction.expiresAt, interaction.id, clearQuestionDraft]);
  if (expired) return null;
  const questions = interaction.questions?.length
    ? interaction.questions
    : [{ id: "legacy", question: interaction.prompt, options: [] }];
  async function respond(answer: unknown) {
    if (busy) return;
    setBusy(true);
    try {
      await api(
        "POST",
        `/api/v1/projects/${projectId}/interactions/${interaction.id}/respond`,
        { answer },
      );
      clearQuestionDraft(interaction.id);
      try {
        await onRefresh();
      } catch {
        notice("回答已送达，最新状态暂未刷新，请勿重复提交。");
      }
    } catch (e) {
      notice(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="interaction">
      <span className="eyebrow">
        {interaction.kind === "permission" ? "需要你的许可" : "需要你回答"}
      </span>
      <h3>{interaction.prompt}</h3>
      {interaction.kind === "permission" ? (
        <div className="row">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void respond("allow")}
          >
            允许一次
          </button>
          <button disabled={busy} onClick={() => void respond("deny")}>
            拒绝
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const values = questions.map((q) => ({
              id: q.id,
              selected: answers[q.id]?.selected || [],
              custom: answers[q.id]?.custom || "",
            }));
            if (values.some((v) => !v.selected.length && !v.custom.trim())) {
              notice("请先回答每一道问题。");
              return;
            }
            void respond(
              interaction.questions?.length
                ? { answers: values }
                : values[0].custom.trim(),
            );
          }}
        >
          {questions.map((q) => {
            const saved = answers[q.id] || { selected: [], custom: "" };
            return (
              <fieldset key={q.id}>
                <legend>{q.question}</legend>
                {q.detail && <p>{q.detail}</p>}
                {q.options?.map((option) => (
                  <label className="question-option" key={option.label}>
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={interaction.id + "-" + q.id}
                      checked={saved.selected.includes(option.label)}
                      onChange={(e) =>
                        setAnswers((old) => ({
                          ...old,
                          [q.id]: {
                            ...saved,
                            selected: q.multiSelect
                              ? e.target.checked
                                ? [...saved.selected, option.label]
                                : saved.selected.filter(
                                    (x) => x !== option.label,
                                  )
                              : [option.label],
                          },
                        }))
                      }
                    />
                    <span>
                      {option.label}
                      {option.description && "：" + option.description}
                    </span>
                  </label>
                ))}
                <label>
                  {q.options?.length ? "补充说明或其他回答" : "你的回答"}
                  <textarea
                    rows={2}
                    maxLength={2000}
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
            提交全部回答
          </button>
        </form>
      )}
    </article>
  );
}
