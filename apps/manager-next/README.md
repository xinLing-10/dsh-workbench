# 独立管家 Next.js 前端

Next.js App Router + React + TypeScript。第一批迁移独立网页及管理员控制台，复用现有 Product API、Cookie/CSRF、SQLite、共享业务内核和 Worker。已完成流式输出与公网试用入口切换，保留本地虚构预览及旧网页回退。详见[发布记录](../../deploy/service/next-rollout-status.md)。

## 本地预览（虚构资料，无模型调用）

需要 Node.js 24。先安装锁文件依赖：

```sh
cd apps/manager-next
npm ci
```

仓库根目录另开终端启动独立 API：

```sh
node apps/manager-next/probes/fixture-api.mjs --fixture
```

启动 Next.js：

```sh
cd apps/manager-next
npm run dev
```

访问 http://localhost:3100 。虚构管理员 `next-admin@example.test`，普通客户 `next-customer@example.test`，两者密码均为 `Next-Fixture-2026!`。这些凭据仅存在每次新建的临时数据库，不用于实际服务。模拟许可按钮只推进本地文档流程，不执行命令或模型。

## 对接已有本地 API

`MANAGER_API_ORIGIN` 仅为服务端固定目标，默认 http://127.0.0.1:8106。Product API 的 `PRODUCT_API_ORIGIN` 必须是浏览器实际访问地址（例如 http://localhost:3100），保持 Cookie、Origin 和 CSRF 校验；不要通过关闭校验解决代理配置问题。该变量不使用 NEXT_PUBLIC 前缀，不接受浏览器指定目的地址。

已实测并关闭 Next 响应压缩（compress:false），避免压缩缓冲 SSE；静态资源可由生产 Nginx 单独压缩。开发预览通过 Next rewrites 转发 `/api/v1/*` 与 `/help`。生产建议 Nginx 将页面和 `/_next/*` 转发 Next 进程，将业务 `/api/v1/*` 与 SSE 直接转发原 Product API；内部 Worker 接口按现有签名和网络边界保护，不因迁移扩大入口。

## 工程结构

- `app/(workspace)`：共享导航及项目/管理员路由，切页不重建发送幂等记录。
- `app/login`：登录与邀请兑换，沿用原账号。
- `components`：对话、项目表单、原生 dialog、资料导入、问答许可、成果版本及五分区控制台。
- `lib/contracts.ts`：公共 DTO 类型；不包含模型令牌或 Worker 签名密钥。
- `lib/api-client.ts`：30秒请求/响应体超时、Cookie/CSRF、明确结果不确定提示、无自动写重试。
- `lib/send-ledger.ts`：同项目同草稿重用 requestId；已确认回执才清除；刷新页面后仍须核对历史。
- `hooks/use-project-events.ts`：每个项目一个 EventSource，切页清理、自动重连、合并刷新；重连不发送消息或停止任务。
- `probes`：独立 API 和真实 Chrome 的虚构验收，不读取线上数据。

第二批已打通模型网关增量解析和持久 message_stream 快照，EventSource按游标补发、按快照替换，最终由Worker结束回执替换为正式回复。页面框架仍不解决全局队列 uncertain 阻塞问题。

## 验证

```sh
npm run typecheck
npm test
npm run build
# API 与 Next 预览运行时，从仓库根目录：
node apps/manager-next/probes/verify-browser.mjs --fixture
```

Chrome 验证会修改虚构数据库并生成手册截图；重复跑完整流程前重启 fixture API，以恢复初始状态。严禁将探针指向生产站点。浏览器探针默认 macOS Google Chrome，其他环境须提供对应浏览器路径适配。

## 后续发布与回退

灰度发布配置见 deploy/service/manager-trial-next.{service,conf}，实际发布状态见 deploy/service/next-rollout-status.md。先在独立端口验证生产构建，校验登录、幂等、权限、SSE、停止、成果、下载、用量与邀请，再由已授权发布操作切换网页入口。保留 `apps/manager-web` 和原发布版本，回退网页不回滚控制库、不重置预算、不重放任务。

npm run build 会自动准备 standalone 静态文件，npm start 启动该产物。单独打包或搬运 standalone 产物时，须连同 `.next/static` 和存在的 `public` 目录按 Next standalone 部署布局复制；设置固定 API 目标并确认构建时 rewrites 与发布目标一致。不要在小内存生产 ECS 上直接运行构建或启动第二套调度器。模型请求、后台任务与数据库继续由原服务管理。

客户、管理员、开发者文档分别见 `dsh-workbench/docs/manager-{user,admin,developer}-guide.md`，每次相关修改都需同步离线 HTML 与受影响截图。
