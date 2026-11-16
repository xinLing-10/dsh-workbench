"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createApiClient, errorText } from "../../lib/api-client";
export default function Login() {
  const router = useRouter(),
    [invite, setInvite] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setReady(true), []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !ready) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const api = createApiClient();
      await api(
        "POST",
        invite ? "/api/v1/invitations/redeem" : "/api/v1/auth/login",
        {
          email: String(f.get("email")).trim(),
          password: String(f.get("password")),
          ...(invite ? { token: String(f.get("invite")).trim() } : {}),
        },
      );
      router.replace("/");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <div className="login-intro">
        <span className="hero-mark">✳</span>
        <h1>每个想法，都值得被实现。</h1>
        <p>一个懂你的管家，陪你完成作品，也陪你学懂它。</p>
        <small>沟通想法 · 阅读成果 · 探索原理</small>
      </div>
      <section className="login-card">
        <p className="eyebrow">欢迎来到项目管家</p>
        <h2>{invite ? "用邀请开启你的空间" : "继续你的创作"}</h2>
        <form onSubmit={submit} method="post" action="/api/v1/auth/login">
          <label>
            邮箱
            <input
              disabled={!ready}
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </label>
          <label>
            密码
            <input
              disabled={!ready}
              name="password"
              type="password"
              autoComplete={invite ? "new-password" : "current-password"}
              minLength={invite ? 8 : undefined}
              required
            />
          </label>
          {invite && (
            <label>
              邀请码
              <input name="invite" required autoComplete="off" />
            </label>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy || !ready}>
            {!ready
              ? "页面准备中…"
              : busy
                ? "正在连接…"
                : invite
                  ? "创建账号"
                  : "登录"}
          </button>
        </form>
        <button
          className="text-button"
          disabled={!ready}
          onClick={() => {
            setInvite(!invite);
            setError("");
          }}
        >
          {invite ? "已有账号，返回登录" : "我有邀请码"}
        </button>
        <a href="/help" target="_blank" rel="noopener">
          第一次使用？查看帮助文档 ↗
        </a>
      </section>
    </main>
  );
}
