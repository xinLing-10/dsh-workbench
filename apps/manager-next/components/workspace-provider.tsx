"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Modal } from "./modal";
import {
  ApiError,
  createApiClient,
  errorText,
  type Api,
} from "../lib/api-client";
import { SendLedger } from "../lib/send-ledger";
import type { Project, Session } from "../lib/contracts";
type QuestionAnswers = Record<string, { selected: string[]; custom: string }>;
type Workspace = {
  questionDrafts: Record<string, QuestionAnswers>;
  setQuestionDraft: (
    id: string,
    update: (old: QuestionAnswers) => QuestionAnswers,
  ) => void;
  clearQuestionDraft: (id: string) => void;
  session: Session;
  projects: Project[];
  api: Api;
  notice: (message: string) => void;
  reloadProjects: () => Promise<void>;
  drafts: Record<string, string>;
  setDraft: (id: string, text: string | ((old: string) => string)) => void;
  ledger: SendLedger;
  openCreate: () => void;
};
const Context = createContext<Workspace | null>(null);
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw Error("Workspace provider required");
  return value;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter(),
    csrf = useRef(""),
    ledger = useRef(new SendLedger());
  const api = useMemo(() => createApiClient({ csrf: () => csrf.current }), []);
  const [session, setSession] = useState<Session | null>(null),
    [projects, setProjects] = useState<Project[]>([]),
    [message, notice] = useState(""),
    [bootError, setBootError] = useState(""),
    [drafts, setDrafts] = useState<Record<string, string>>({});
  const [questionDrafts, setQuestionDrafts] = useState<
    Record<string, QuestionAnswers>
  >({});
  const setQuestionDraft = useCallback(
    (id: string, update: (old: QuestionAnswers) => QuestionAnswers) =>
      setQuestionDrafts((old) => ({ ...old, [id]: update(old[id] || {}) })),
    [],
  );
  const clearQuestionDraft = useCallback(
    (id: string) =>
      setQuestionDrafts((old) => {
        const next = { ...old };
        delete next[id];
        return next;
      }),
    [],
  );
  const [create, setCreate] = useState(false),
    [saving, setSaving] = useState(false),
    [name, setName] = useState(""),
    [notes, setNotes] = useState(""),
    [formError, setFormError] = useState("");
  const reloadProjects = useCallback(async () => {
    const data = await api<{ projects: Project[] }>("GET", "/api/v1/projects");
    setProjects(data.projects);
  }, [api]);
  const bootstrap = useCallback(async () => {
    setBootError("");
    try {
      const me = await api<Session>("GET", "/api/v1/me");
      csrf.current = me.csrfToken;
      await reloadProjects();
      setSession(me);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace("/login");
      else setBootError(errorText(e));
    }
  }, [api, reloadProjects, router]);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  const setDraft = useCallback(
    (id: string, text: string | ((old: string) => string)) =>
      setDrafts((old) => ({
        ...old,
        [id]: typeof text === "function" ? text(old[id] || "") : text,
      })),
    [],
  );
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError("");
    let created = false;
    try {
      const result = await api<{ project: Project }>(
        "POST",
        "/api/v1/projects",
        { name: name.trim(), notes: notes.trim() },
      );
      created = true;
      setCreate(false);
      setName("");
      setNotes("");
      await reloadProjects();
      router.push("/projects/" + result.project.id);
    } catch (e) {
      if (created) notice("项目已创建，请从项目列表重新打开，无需重复创建。");
      else setFormError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  if (!session)
    return (
      <main className="connection-screen">
        <p>{bootError || "正在连接你的工作空间…"}</p>
        {bootError && (
          <button onClick={() => void bootstrap()}>重新连接</button>
        )}
      </main>
    );
  return (
    <Context.Provider
      value={{
        questionDrafts,
        setQuestionDraft,
        clearQuestionDraft,
        session,
        projects,
        api,
        notice,
        reloadProjects,
        drafts,
        setDraft,
        ledger: ledger.current,
        openCreate: () => {
          setFormError("");
          setCreate(true);
        },
      }}
    >
      <div className="workspace-shell">
        <aside className="sidebar">
          <Link className="brand" href="/">
            ✳{" "}
            <span>
              项目管家<small>把想法，变成作品</small>
            </span>
          </Link>
          <button
            className="new-project-button"
            onClick={() => {
              setFormError("");
              setCreate(true);
            }}
          >
            ＋ 新建项目
          </button>
          <p className="sidebar-label">我的项目</p>
          <nav>
            {projects.map((p) => (
              <button
                key={p.id}
                className="project-nav-item"
                aria-current={
                  pathname === "/projects/" + p.id ? "page" : undefined
                }
                onClick={() => router.push("/projects/" + p.id)}
              >
                {p.name}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            每一步，都有管家陪你<small>说清想法 · 一起完成 · 学懂原理</small>
          </div>
        </aside>
        <div className="workspace-main">
          <header className="topbar">
            <button
              className="mobile-projects"
              onClick={() => router.push("/")}
            >
              所有项目
            </button>
            <span className="workspace-label">● 你的专属工作空间</span>
            <div className="row">
              <a href="/help" target="_blank" rel="noopener">
                帮助文档
              </a>
              {session.user.platformAdmin && (
                <button onClick={() => router.push("/admin")}>服务管理</button>
              )}
              <span className="account-name">{session.user.email}</span>
            </div>
          </header>
          {children}
        </div>
      </div>
      {message && (
        <div className="toast" role="status">
          <span>{message}</span>
          <button aria-label="关闭提示" onClick={() => notice("")}>
            ×
          </button>
        </div>
      )}
      {create && (
        <Modal
          title="给新项目起个名字"
          onClose={() => setCreate(false)}
          busy={saving}
        >
          <form onSubmit={submit}>
            <p className="muted">不需要懂技术，先记下你想做什么。</p>
            <label>
              项目名称
              <input
                autoFocus
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：我的预约小助手"
              />
            </label>
            <label>
              备注（可选）
              <textarea
                maxLength={1000}
                rows={4}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="给谁用？希望解决什么问题？"
              />
            </label>
            {formError && (
              <p role="alert" className="error">
                {formError}
              </p>
            )}
            <div className="row end">
              <button type="button" onClick={() => setCreate(false)}>
                取消
              </button>
              <button className="primary" disabled={saving || !name.trim()}>
                {saving ? "正在创建…" : "创建并开始"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Context.Provider>
  );
}
