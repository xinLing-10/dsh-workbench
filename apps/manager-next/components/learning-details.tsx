"use client";
import { useEffect, useState } from "react";
import { Markdown } from "./markdown";
type Learning = {
  materials?: {
    overview: string;
    glossary: { term: string; meaning: string; sourceIds: string[] }[];
  };
  knowledgeMap?: {
    id: string;
    concepts: {
      id: string;
      title: string;
      description: string;
      kind: string;
      requires: string[];
    }[];
    features: {
      id: string;
      title: string;
      description: string;
      steps: string[];
    }[];
  };
  sourceChanges?: string[];
  observations?: {
    id: string;
    title: string;
    corrected: boolean;
    correction?: string;
    next: string;
    understood: { claim: string; quote: string }[];
    misconceptions: { claim: string; quote: string }[];
  }[];
  reviewSchedule?: {
    enabled: boolean;
    items: {
      id: string;
      title: string;
      status: string;
      dueAt: string;
      reason: string;
    }[];
  };
  memoryEnabled?: boolean;
  practice?: { id: string; goal: string; files: { originalPath: string }[] };
  editor?: { path: string; content: string; hash: string };
};
export function LearningDetails({
  learning: l,
  paths,
  text,
  act,
  notice,
}: {
  learning: Learning;
  paths: string[];
  text: string;
  act: (action: string, body?: Record<string, unknown>) => Promise<void>;
  notice: (text: string) => void;
}) {
  const [confirmed, setConfirmed] = useState(false),
    [content, setContent] = useState("");
  useEffect(() => {
    setContent(l.editor?.content || "");
  }, [l.editor?.path, l.editor?.hash]);
  return (
    <>
      {!!l.sourceChanges?.length && (
        <p role="status">
          当前资料与原计划有变化，请重新核对：{l.sourceChanges.join("、")}
        </p>
      )}
      {l.knowledgeMap && (
        <details>
          <summary>产品功能与知识地图</summary>
          {l.knowledgeMap.features.map((f) => (
            <article key={f.id}>
              <h4>{f.title}</h4>
              <p>{f.description}</p>
              <ol>
                {f.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </article>
          ))}
          {l.knowledgeMap.concepts.map((c) => (
            <article key={c.id}>
              <h4>
                {c.title} ·{" "}
                {c.kind === "project"
                  ? "项目资料依据"
                  : c.kind === "general"
                    ? "通用知识"
                    : "推测"}
              </h4>
              <p>{c.description}</p>
              <p>
                前置知识：
                {c.requires
                  .map(
                    (id) =>
                      l.knowledgeMap!.concepts.find((n) => n.id === id)
                        ?.title || id,
                  )
                  .join("、") || "无"}
              </p>
            </article>
          ))}
        </details>
      )}
      {l.materials && (
        <details>
          <summary>原理导读与术语词典</summary>
          <Markdown text={l.materials.overview} />
          <dl>
            {l.materials.glossary.map((g) => (
              <div key={g.term}>
                <dt>{g.term}</dt>
                <dd>
                  {g.meaning}（{g.sourceIds.join("、") || "通用解释"}）
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      <details>
        <summary>学习副本练习（不执行代码）</summary>
        <p>在独立副本中编辑，原项目保持不变。反馈只是解释，不等于测试通过。</p>
        <label>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          我确认仅创建所选资料的练习副本
        </label>
        <button
          onClick={() => {
            if (!confirmed || !paths.length) {
              notice("请选择学习资料，并确认只在副本练习。");
              return;
            }
            void act("learning-practice-create", {
              confirmed: true,
              paths,
              goal: text,
            });
          }}
        >
          创建学习副本
        </button>
        {l.practice && (
          <>
            <p>目标：{l.practice.goal}</p>
            {l.practice.files.map((f) => (
              <button
                key={f.originalPath}
                onClick={() =>
                  void act("learning-practice-open", {
                    practiceId: l.practice!.id,
                    path: f.originalPath,
                  })
                }
              >
                打开副本：{f.originalPath.split("/").at(-1)}
              </button>
            ))}
          </>
        )}
        {l.editor && l.practice && (
          <>
            <label>
              副本内容
              <textarea
                aria-label="学习副本内容"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={16000}
              />
            </label>
            <button
              onClick={() =>
                void act("learning-practice-save", {
                  practiceId: l.practice!.id,
                  path: l.editor!.path,
                  baseHash: l.editor!.hash,
                  content,
                })
              }
            >
              保存副本
            </button>
            <button
              onClick={() =>
                void act("learning-practice-feedback", {
                  practiceId: l.practice!.id,
                  path: l.editor!.path,
                })
              }
            >
              解释已保存的修改
            </button>
          </>
        )}
      </details>
      <details>
        <summary>学习观察、记忆与复习</summary>
        <p>这些是暂时观察，随时可以纠正，不是能力评分。</p>
        <button
          onClick={() =>
            void act("learning-memory-setting", {
              enabled: l.memoryEnabled === false,
            })
          }
        >
          {l.memoryEnabled === false ? "启用" : "停用"}历史学习记忆
        </button>
        {l.observations?.map((o) => (
          <article key={o.id}>
            <h4>{o.title}</h4>
            <p>{o.corrected ? "已纠正：" + o.correction : o.next}</p>
            {[...o.understood, ...o.misconceptions].map((i, k) => (
              <p key={k}>
                {i.claim} · 引用你的话：{i.quote}
              </p>
            ))}
            <button
              onClick={() => {
                if (!text.trim()) {
                  notice("请先在上方写下要纠正的内容。");
                  return;
                }
                void act("learning-observation-correct", {
                  observationId: o.id,
                  text,
                });
              }}
            >
              用我上方填写的话纠正
            </button>
          </article>
        ))}
        {l.reviewSchedule && (
          <>
            <button
              onClick={() =>
                void act("learning-review-settings", {
                  enabled: !l.reviewSchedule!.enabled,
                })
              }
            >
              {l.reviewSchedule.enabled ? "关闭" : "开启"}复习提醒
            </button>
            {l.reviewSchedule.items.map((r) => (
              <article key={r.id}>
                <h4>{r.title}</h4>
                <p>
                  {r.reason} · {new Date(r.dueAt).toLocaleDateString()}
                </p>
                <button
                  onClick={() =>
                    void act("learning-review", { reviewId: r.id, paths })
                  }
                >
                  现在回顾
                </button>
                <button
                  onClick={() =>
                    void act("learning-review-defer", {
                      reviewId: r.id,
                      days: 1,
                    })
                  }
                >
                  推迟一天
                </button>
                <button
                  onClick={() =>
                    void act("learning-review-pause", { reviewId: r.id })
                  }
                >
                  暂停此项
                </button>
              </article>
            ))}
          </>
        )}
      </details>
    </>
  );
}
