"use client";
import { useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { ApiError, errorText } from "../lib/api-client";
type Stage = {
  stage: string;
  title: string;
  templates: { id: string; name: string }[];
  sources: string[];
};
type Result = {
  artifactId: string;
  name: string;
  status: string;
  gaps: { section: string; reason: string }[];
  sources: { name: string; revision: number }[];
};
export function DeliveryTemplates({
  base,
  projectId,
  onRefresh,
}: {
  base: string;
  projectId: string;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice } = useWorkspace(),
    [stages, setStages] = useState<Stage[]>([]),
    [stage, setStage] = useState(""),
    [template, setTemplate] = useState(""),
    [format, setFormat] = useState("docx"),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Result | null>(null),
    [pending, setPending] = useState<Record<string, string> | null>(null);
  async function load() {
    try {
      const r = await api<{ stages: Stage[] }>(
        "GET",
        base + "/delivery-templates",
      );
      setStages(r.stages);
      if (!stage) {
        setStage(r.stages[0].stage);
        setTemplate(r.stages[0].templates[0].id);
      }
    } catch (e) {
      notice(errorText(e));
    }
  }
  async function generate() {
    if (busy) {
      notice("正在整理文档，请稍候。");
      return;
    }
    const body = pending || {
      stage,
      templateId: template,
      format,
      requestId: crypto.randomUUID(),
    };
    setBusy(true);
    setPending(body);
    try {
      const r = await api<Result>("POST", base + "/delivery-templates", body);
      setResult(r);
      setPending(null);
      await onRefresh();
    } catch (e) {
      notice(errorText(e));
      if (
        e instanceof ApiError &&
        !["network_uncertain", "response_uncertain"].includes(e.code) &&
        e.status < 500
      )
        setPending(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !stages.length) void load();
      }}
    >
      <summary>按交付用途整理模板文档</summary>
      <p>
        只使用已确认的阶段版本。缺少材料会保留待补充提示，输出标记为草稿；整理模板不调用模型。
      </p>
      {!!stages.length && (
        <>
          <label>
            交付用途
            <select
              value={stage}
              onChange={(e) => {
                if (pending) {
                  notice("请先核对上次生成的回执。");
                  return;
                }
                setStage(e.target.value);
                setTemplate(
                  stages.find((s) => s.stage === e.target.value)!.templates[0]
                    .id,
                );
              }}
            >
              {stages.map((s) => (
                <option key={s.stage} value={s.stage}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
          <p>
            需要已确认：
            {stages.find((s) => s.stage === stage)?.sources.join("、")}
          </p>
          <label>
            模板
            <select
              value={template}
              onChange={(e) =>
                pending
                  ? notice("请先核对上次生成的回执。")
                  : setTemplate(e.target.value)
              }
            >
              {stages
                .find((s) => s.stage === stage)
                ?.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            格式
            <select
              value={format}
              onChange={(e) =>
                pending
                  ? notice("请先核对上次生成的回执。")
                  : setFormat(e.target.value)
              }
            >
              <option value="docx">Word</option>
              <option value="pdf">PDF</option>
              <option value="pptx">可编辑演示文稿</option>
              <option value="markdown">Markdown</option>
            </select>
          </label>
          <button aria-disabled={busy} onClick={() => void generate()}>
            {pending ? "核对并继续同一次生成" : "整理交付文档"}
          </button>
          {result && (
            <section>
              <h4>{result.name}</h4>
              <p>
                {result.status === "draft"
                  ? "仍有待补充材料，请核对以下缺口。"
                  : "已生成，仍需阅读核对。"}
              </p>
              {result.gaps.map((g, i) => (
                <p key={i}>
                  {g.section}：{g.reason}
                </p>
              ))}
              <a
                className="button"
                href={`/api/v1/projects/${projectId}/artifacts/${result.artifactId}/download`}
              >
                下载这份文档
              </a>
            </section>
          )}
        </>
      )}
    </details>
  );
}
