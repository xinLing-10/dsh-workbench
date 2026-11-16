"use client";
import { useEffect, useRef, useState } from "react";
import type {
  Artifact,
  ArtifactView,
  ArtifactVersions,
} from "../lib/contracts";
import { useWorkspace } from "./workspace-provider";
import { errorText } from "../lib/api-client";
import { Markdown } from "./markdown";
export function ArtifactPanel({
  projectId,
  artifacts,
  onClose,
  onRefresh,
}: {
  projectId: string;
  artifacts: Artifact[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { api, notice } = useWorkspace(),
    [view, setView] = useState<ArtifactView | null>(null),
    [versions, setVersions] = useState<ArtifactVersions | null>(null),
    [busy, setBusy] = useState(false),
    epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  async function open(id: string) {
    const revision = ++epoch.current;
    setBusy(true);
    try {
      const [v, vs] = await Promise.all([
        api<ArtifactView>(
          "GET",
          `/api/v1/projects/${projectId}/artifacts/${id}`,
        ),
        api<ArtifactVersions>(
          "GET",
          `/api/v1/projects/${projectId}/artifacts/${id}/versions`,
        ),
      ]);
      if (revision === epoch.current) {
        setView(v);
        setVersions(vs);
      }
    } catch (e) {
      notice(errorText(e));
    } finally {
      if (revision === epoch.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!view || busy) return;
    if (view.artifact.confirmed || view.artifact.id !== versions?.latestId) {
      notice("只有尚未确认的最新版本可以确认，请切换到最新一版。");
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ artifact: Artifact }>(
        "POST",
        `/api/v1/projects/${projectId}/artifacts/${view.artifact.id}/confirm`,
        { hash: view.artifact.sha256 },
      );
      setView({ ...view, artifact: result.artifact });
      notice("已保存这一版的确认。");
      await onRefresh();
    } catch (e) {
      notice(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="artifacts-panel" aria-label="我的成果">
      <div className="panel-heading">
        <h2>
          我的成果 <small>{artifacts.length}</small>
        </h2>
        <button onClick={onClose} aria-label="关闭成果">
          ×
        </button>
      </div>
      <p className="muted">阅读、下载，再决定是否确认这一版。</p>
      <ul className="artifact-list">
        {artifacts.map((a) => (
          <li key={a.id}>
            <span>
              {a.name}
              {a.task && <small>来自：{a.task.title}</small>}
              {a.confirmed && <small>已确认</small>}
            </span>
            <button onClick={() => void open(a.id)}>阅读</button>
          </li>
        ))}
      </ul>
      {!artifacts.length && <p className="empty">成果生成后会出现在这里。</p>}
      {view && (
        <section className="artifact-reader">
          <h3>{view.artifact.name}</h3>
          <label>
            版本
            <select
              value={view.artifact.id}
              onChange={(e) => void open(e.target.value)}
            >
              {versions?.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                  {v.confirmed ? " · 已确认" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">
            {view.artifact.id !== versions?.latestId
              ? "历史版本只能阅读和下载。"
              : view.artifact.confirmed
                ? "这一版已确认。"
                : "尚未确认。"}
            {view.truncated && " 内容较长，预览已截断，请下载原文件。"}
          </p>
          <div className="artifact-content">
            <Markdown text={view.text} />
          </div>
          <div className="row">
            <button
              className="primary"
              aria-disabled={
                busy ||
                view.artifact.confirmed ||
                view.artifact.id !== versions?.latestId
              }
              onClick={() => void confirm()}
            >
              确认这一版
            </button>
            <a
              className="button"
              download={view.artifact.name}
              href={`/api/v1/projects/${projectId}/artifacts/${view.artifact.id}/download`}
            >
              下载原文件
            </a>
            {/\.(md|markdown|txt)$/i.test(view.artifact.name) &&
              [
                ["docx", "Word"],
                ["pdf", "PDF"],
                ["pptx", "可编辑演示文稿"],
              ].map(([format, label]) => (
                <a
                  key={format}
                  className="button"
                  href={`/api/v1/projects/${projectId}/artifacts/${view.artifact.id}/download?format=${format}`}
                >
                  导出 {label}
                </a>
              ))}
          </div>
        </section>
      )}
    </aside>
  );
}
