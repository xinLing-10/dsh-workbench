"use client";
import Link from "next/link";
import { useWorkspace } from "../../components/workspace-provider";
export default function Projects() {
  const { projects, openCreate } = useWorkspace();
  return (
    <main className="projects-page">
      <p className="eyebrow">你的想法，从这里开始</p>
      <h1>今天，想一起完成什么？</h1>
      <p className="muted">继续已有项目，或让管家陪你迈出第一步。</p>
      <button className="primary" onClick={openCreate}>
        ＋ 新建项目
      </button>
      <div className="project-grid">
        {projects.map((p) => (
          <Link className="project-card" href={"/projects/" + p.id} key={p.id}>
            <span className="project-symbol">◇</span>
            <h2>{p.name}</h2>
            <p>{p.notes || "打开项目，继续和管家聊聊。"}</p>
            <span>继续对话 →</span>
          </Link>
        ))}
      </div>
      {!projects.length && (
        <p className="empty">还没有项目。写下你的想法就可以开始。</p>
      )}
    </main>
  );
}
