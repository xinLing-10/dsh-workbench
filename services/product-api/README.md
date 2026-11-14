# product-api（独立管家产品控制面）

最新增量：管理员接口 `/api/v1/admin/service` 已提供 `dashboard` 快照（用量、UTC趋势、近期任务、Worker身份及 API 进程信息），与可视化服务控制台对接，仍要求平台管理员权限。配置、真实能力与运维入口见 [开发者手册](../../dsh-workbench/docs/manager-developer-guide.md)。以下早期“尚未接通”描述为历史阶段记录，不覆盖后续统一 Worker、正式预算隔离和服务器验收专题。

状态：**可本地验证的产品骨架，已同源托管最小前端；常规任务执行尚未接通；新增独立的原生DSH只读验证入口，未作为独立产品部署。** 设计见 `dsh-workbench/docs/standalone-manager-design.md`，排期见 `dsh-workbench/docs/standalone-manager-plan.md`。

## 运行

```bash
# 控制库默认落在 ./control-data/product.sqlite
node server.mjs

# 生成一个邀请令牌（单次使用）
node server.mjs --invite "我的租户"
```

环境变量：`PRODUCT_API_PORT`（默认 8089）、`PRODUCT_API_DB`、`PRODUCT_API_ORIGIN`（HTTPS 入口，设置后校验 Origin）、`PRODUCT_API_COOKIE_SECURE=1`、`PRODUCT_API_ALLOW_REDEEM=1`（默认关闭，第一版只允许本人兑换）、`PRODUCT_API_SESSION_TTL_MS`、`PRODUCT_API_INVITE_TTL_MS`、`PRODUCT_API_MAX_BODY`、`PRODUCT_API_WORKER_URL` / `PRODUCT_API_WORKER_TOKEN`（桥接，留空表示未接通）。

## 已实现

| 能力 | 说明 |
| --- | --- |
| 控制库 | `node:sqlite`，WAL + 外键；账号、租户、会话、邀请、项目、操作、outbox、互动、成果索引、额度、模型调用、事件、审计 |
| 邀请与账号 | 单次邀请（只存令牌摘要）、scrypt 口令、服务端会话、撤销 |
| 归属 | 所有项目路由先按 `tenant_id` 取项目；跨租户一律 404 |
| CSRF / 来源 | 非安全方法要求 `x-csrf-token`，设置 `PRODUCT_API_ORIGIN` 时校验 Origin |
| 幂等 | `(tenant_id, project_id, request_id)` 唯一；同请求同内容回放，同请求不同内容 409 |
| 操作与 outbox | 写操作先入库并同事务写 outbox，`202` 只表示已接收 |
| 事件 | 每项目事件序列 + SSE（`Last-Event-ID` 游标），断线可续传 |
| 桥接 | 能力全部 `false`；需要执行的动作返回 `capability_unavailable`，绝不静默放行 |

## 未实现（不要当成已完成）

- 产品到 Worker 的执行派发、用量上报、模型网关、Worker 调度和真实任务执行。
- 已有 Worker 发起的审批/提问回传与成果注册/阅读/确认/下载；不代表真实任务全链路已接通。
- 完整陪学前端、管理端、额度结算、导入、备份恢复。
- 口令散列：设计指定 Argon2id，当前用 scrypt 占位（`src/passwords.mjs` 已隔离）。
- 限流为单进程内存实现，多实例前必须外置。

## 测试

```bash
node --test tests/*.test.mjs
```

## 2026-11-14 可靠性修复

消息、操作和 outbox 同事务保存；审批回答一次性消费，收完请求后重检过期状态，与事件同事务保存。无法识别的权限回答返回 400。执行适配器未实现，配置能力标志也不会显示执行可用。测试需要 Node 24；两条 injected failure 日志是故障注入测试的预期输出。

## 结构化问答与取消

SQLite schema v2 增加 questions_json，自动迁移 v1 并保留旧的自由文本问题。逐题校验 ID、选项、单选/多选和补充文字；新问题默认五分钟到期，Worker 可传明确期限。内部 POST /internal/v1/interactions/:id/cancel 按租户、项目、operation 校验，幂等改变 pending 状态并产生 interaction_cancelled 事件；回答后不会被撤销覆盖。

## Worker 身份与租约（schema v3）

已改为注册的 Worker 专属密钥 + 单操作租约 + generation。全局 PRODUCT_API_INTERNAL_SECRET 不再授权。内部请求绑定方法、完整路径、请求体和 nonce，长轮询和异步成果落盘会重检租约。控制库含密钥，文件权限 600，不提供浏览器管理接口。

管理员可用 worker-admin.mjs 的 register / lease / revoke / disable，具体配置和升级步骤见 ../../dsh-workbench/docs/worker-integration.md。旧无租约 Worker 需同步升级，不能直接复用共享密钥配置。调度、真实费用、容器/卷绑定及密钥轮换尚未实现。

## 模拟队列（默认关闭）

PRODUCT_API_SIMULATE=1 node server.mjs 显式开启模拟消费；node simulate.mjs 单次处理、--recover 只核对，均需同一环境标志。先注册测试 Worker，不手工占用诊断租约。模拟回复有醒目标记，不调用模型或执行项目代码。旧排队消息也会消费；无回执不自动重试。见 ../../dsh-workbench/docs/simulation-dispatch.md。schema 已升级为 v4，控制库含敏感凭据，备份应受控。

## 完整交互模拟（schema v5）

在 SIMULATE=1 之外设置 PRODUCT_API_SIMULATION_FLOW=1，启用许可→问答→数据库示例文档。消息接收与执行模式均持久化，关闭 FLOW 不跳过已指定的交互。阅读/下载校验正文，确认仍需用户显式操作；排队或等待时可取消。所有数据只写控制库，不调用模型或修改项目文件。完整说明：../../dsh-workbench/docs/simulation-flow.md。74 项离线回归与实际浏览器下载验收通过。

## 真实模型验收准备

仓库根目录运行 node services/product-api/probes/prepare-real-model-test.mjs --prepare，可生成24项案例的独立工作区、基线 hash 与证据记录。--validate-only 仅检查结构，--check 就绪不通过返回2。脚本不联网、不读取 Key、不启动付费测试。详见 ../../dsh-workbench/docs/real-model-test-plan.md。

## 一次性真实模型烟测

新增 src/real-model-smoke.mjs 和 probes/run-real-model-smoke.mjs，固定官方账号通道、最多1000输出token、不提供工具、不自动重试。每个授权目录首次执行就锁定，状态不明也不得重发。用户本次一次性授权已用完，代码存在不代表可再次付费执行。真实结果和范围见 ../../dsh-workbench/docs/real-model-smoke-result.md；独立网页并未开启真实自由聊天。

## 本轮授权的真实模型只读验证

`node readonly-preview.mjs --start` 仅复用本轮已有明确授权和持久账本，监听 `http://localhost:8091`，不自动创建新额度。当前为owner本机、虚构项目的只读答疑实验，不是生产通用Worker。网页可收到原生DSH真实回复；工具声明在预算网关移除，真实停止/审批/成果仍关闭。历史取有限摘录，当前问题完整保留；单消息最多6000 UTF-8字节。

全部实验调用共享 `control-data/authorized-20261114-200k/budget.sqlite`，输入/输出及缓存token总上限200000、最多24次。不要删除账本或attempt锁来“恢复”；未知结果需人工核对，不能清零。纯文本预占上界与复现记录见 `dsh-workbench/docs/real-model-run-20261114.md`。常规 `server.mjs` 依旧不会默认启用该通道。

离线检查：`npm test && npm run check`。真实探针均可能计费，不能当作普通回归自动运行；`verify-readonly-browser.mjs --capture-only` 仅使用已存回复重拍截图，不发送问题。

续测实现不可变文档快照（新文档最多1MB、注册校验hash）、相同hash登记回放、原生引擎回执停止与预算暂停提示。真实模型工具续测400且usage未知，当前不再发送真实请求；`--fixture-mode`只验证真实DSH服务和BFF，不计作模型实测。详情见 `dsh-workbench/docs/pending-chains-run-20261114.md`。
