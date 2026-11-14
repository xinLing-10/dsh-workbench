# 独立管家产品：实施计划

基线：`personal_manager` / 工作台 1.24.1 / 203 项插件测试通过。设计依据：`docs/standalone-manager-design.md`（下称“设计”）。

本计划只做设计里允许的第一批前置与骨架，不声称已完成“独立产品”。目前已有 services、apps、packages 骨架，尚未完成真实任务闭环。

## 0. 本轮已开始的切片

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| S1 契约包 | `packages/manager-contracts`：错误码、事件类型、动作白名单、信封与 ID 规则 | ✅ 6 项测试通过 |
| S2 产品 API 骨架 | `services/product-api`：SQLite 控制库、邀请/登录/会话、项目、消息与动作（202 + outbox）、SSE 事件、归属校验、幂等 | ✅ 8 项测试通过；已在 8099 端口实跑 `/healthz` 与邀请 CLI |
| S3 内部桥接桩 | `services/product-api/src/bridge.mjs`：能力协商 + 明确“未接通”的阻断语义 | ✅ 能力全部 `false`，需要执行的动作返回 `capability_unavailable` |
| S4 使用手册基线 | 插件 `docs/manager-user-guide.md` 维护记录补一行“用户操作不变”，并重新生成离线 HTML | ✅ `npm run docs:guide` 输出 19 张图 / 14 节 |
| S5 桥接适配 | `services/worker-bridge`：审批/提问 waterfall → 产品 `interaction_requests`；HMAC 短期令牌 + jti 重放表 + 请求体摘要；产品侧新增 `/internal/v1/interactions` 与长轮询应答 | ✅ 桥接 9 项 + 产品 API 11 项 + 契约 10 项测试；**未在真实 Worker 联调** |
| S6 前端第一片 | `apps/manager-web`：登录/邀请、项目列表、对话、互动回答；原生 ES module，由产品 API 同源托管并带严格 CSP | ✅ 产品 API 13 项测试（含静态托管与消息历史）；已用 curl 跑通全流程；**未做浏览器交互验证** |
| S7 成果链路 | 产品 API：`/internal/v1/projects/:id/artifacts` 注册、列表/阅读/确认（hash 绑定）/下载；工作区路径解析拒绝绝对路径、`..` 与符号链接逃逸；前端「我的成果」可阅读、确认、下载 | ✅ 产品 API 15 项测试；真实进程实跑注册→列表→阅读→确认→下载 |
| S9 真实 Worker 接入 | `@manager/worker-bridge` 打包为 DSH bundle 并装入 profile（`include:manager-bridge` fiber active，配置为 `enabled:false` 的惰性状态）；真实 Cordis `Context` 组合测试通过；提供集成检查器与接入手册 | ⚠️ 组合已验证；**真实模型链路仍需用户按手册跑一次**（需要模型额度与运行中的 Worker） |
| S8 实时刷新与多版本 | 前端接 SSE（进入项目即连、断线重连、事件去抖刷新）；成果版本列表 `/versions`，历史版本只读、确认只对最新版；产品侧拦截"确认旧版本" | ✅ 产品 API 16 项测试；SSE 实跑收到 `task_status` 与 `message_created` 帧 |

## 1. P0 前置验证（设计第 11 节）

下表区分接口证据和运行能力，局部测试不等于所有 P0 门槛通过。

| # | 验证项 | 结论 | 证据与待补 |
| --- | --- | --- | --- |
| P0-1 | 内部业务桥接 | **部分实现，派发未接通** | `services/worker-bridge` 用 HMAC 短期令牌 + jti 重放表 + 体摘要接入；产品 API 侧有 11 项测试覆盖越权/重放/过期 |
| P0-2 | 权限审批与用户追问 | **通过** | 真实日志 242 次审批（asked/decided 成对）+ 42 次 `ask_user_question`；`approval/request`、`user-questions/request` 监听器可用 |
| P0-3 | 模型网关 | 部分可行 | `baseURL` 可指向网关；usage 在 DSH 侧可见但属可忽略外部事件，网关必须自行计量 |
| P0-4 | 操作归属 | 只到 Worker 级 | 事件无 operationId，只有匿名 `user_id`；按设计降级为单 Worker 单操作 |
| P0-5 | 硬边界 | 部分可行 | `deploy/instance.py` 已有只读根/降权/PID/内存/CPU/独立卷；缺出网策略与租户级卷 |
| P0-6 | 主状态恢复 | **通过** | 插件已有回执/不确定态/自愈；DSH 会话日志可回放；产品侧 outbox + 同 request_id 幂等 |

完整证据见 [P0 兼容性记录](p0-compatibility.md)，复现命令：

```bash
node services/product-api/probes/probe-dsh-surface.mjs   # 8/8
node services/product-api/probes/probe-session-log.mjs   # 60 会话样本
```

结论：**P0-2 接口证据通过；P0-6 产品恢复未完成验收；P0-1 审批回传已有但派发未接通；P0-3 计量待实现；P0-4 按设计降级；P0-5 未通过。** 因此可以进入第一批的桥接适配与自用闭环（本人账号、单 Worker、模拟模型），但在 P0-3 计量与 P0-5 边界补齐前**不接真实模型、不产生真实费用、不邀请外部用户**。

## 2. 三批路线

### 第一批：自用独立产品闭环（当前目标）

1. **S1 契约**（本轮）
2. **S2 骨架**（本轮）：账号、项目、事件、操作投递；不含执行。
3. **S5 桥接适配**（已完成映射与客户端）：把审批/提问 waterfall 接到 product-api；下一步在真实 Worker 上联调。
4. **S6 独立前端第一片**（已完成）：`apps/manager-web` 只调用产品 API，同源托管；成果阅读/确认/下载与 SSE 已有；下一步做浏览器验收和执行联调。
5. **S6 自用验收**：本人账号、单 Worker、模拟模型跑通“新建项目 → 对话 → 确认 → 下载 → 陪学”；再做一次有预算上限的真实模型小任务。

验收口径沿用设计：断线/重启可恢复；拒绝权限确实阻止操作；客户端与网络响应里没有运营者 Key、原生令牌、宿主路径。

### 第二批：可信邀请与受控消费

邀请/停用、租户专属卷与实例身份、统一队列、额度预留与结算、匿名供应商 `user_id`、受限导入与隔离下载。门槛：至少两个虚构账号互换 ID 不可越权；并发不突破额度；Worker 不持真 Key。资源门槛未通过就停留本地验证。

### 第三批：运营与发布准备

管理端（邀请/额度/任务/Key 轮换）、成本告警与熔断、审计、备份恢复与回滚演练、数据生命周期。

## 3. 工程布局（本轮创建的部分）

```text
packages/manager-contracts/     # 错误码、事件、动作、信封（纯 JS，无依赖）
services/product-api/           # BFF 骨架：SQLite + HTTP + SSE
  src/db.mjs     控制库与迁移
  src/auth.mjs   邀请、口令、会话、CSRF
  src/app.mjs    路由与归属校验、幂等、事件
  src/bridge.mjs 内部桥接客户端（本轮为桩）
  src/http.mjs   极简 HTTP 基础设施
  server.mjs     进程入口
  tests/
```

`apps/manager-web` 已创建；`services/model-gateway`、`services/worker-supervisor` 待创建；本轮不动插件本体，也不改 `deploy/`。

## 4. 本轮已确定的技术决策（与设计的偏差要记录）

| 决策 | 原因 | 偿还方式 |
| --- | --- | --- |
| 先写 **纯 ESM JavaScript**，不引入 TypeScript 构建 | 仓库离线、无网络安装；先让骨架可运行可测 | 前端 `apps/manager-web` 引入 Vite+TS 时，`packages/manager-contracts` 同步补 `.d.ts` |
| 控制库用 **`node:sqlite`**（Node 24 内置） | 零依赖、支持事务/外键/约束，符合设计“首版 SQLite WAL” | 多控制节点前迁 PostgreSQL |
| 口令先用 **scrypt**（`node:crypto`） | 设计指定 Argon2id；当前无网络安装原生模块 | 已把散列封装在 `passwords.mjs`，装好 Argon2id 后替换实现并保留旧散列升级路径 |
| 桥接能力**全部声明 `false`**，相关动作返回 `capability_unavailable` | 宁可阻止，也不假装接通（设计要求） | P0-1/P0-2 验证后逐个打开 |
| 会话 Cookie `SameSite=Lax` + CSRF 头 + Origin 校验 | 首版无 HTTPS 入口，先保证本地可验证 | HTTPS 上线时改 `Secure` 并加 HSTS |

### 4.4 本轮被测试抓到的两个真实缺陷（留作证据）

1. 幂等比较用错了列名：SQLite 返回 `payload_hash`，代码读 `payloadHash`，导致同一请求被误判为“内容冲突”（测试 `messages are idempotent` 暴露）。已修正为显式映射。
2. 建表语句缺少 `IF NOT EXISTS`：第二次启动同一控制库直接报“table already exists”（邀请 CLI 实跑暴露）。已为全部 16 张表补上幂等守卫。

## 5. 测试与验收（本轮）

- `packages/manager-contracts`：信封与错误码形状、动作白名单。
- `services/product-api`：邀请兑换 → 登录 → 建项目 → 发消息（202 + operation）→ 重复 request_id 幂等 → 改 payload 冲突 409 → 另一账号访问该项目 404 → 事件游标可续传 → 未登录 401 → 缺 CSRF 403。
- 命令：`node --test services/product-api/tests/*.test.mjs`；插件自身 `npm test` 保持 203 通过。

## 6. 手册与文档义务

- 插件侧用户操作未变：`docs/manager-user-guide.md` 维护记录追加一行“已核对，用户操作不变”。
- 本计划与设计文档并存：设计是“要做什么”，本文件是“怎么排期、偏差点与证据”。
- 每批完成时必须同步：`manager-user-guide.md`（若涉及用户操作）、离线 HTML（`npm run docs:guide`）、受影响截图、兼容性记录。

## 7. 需要你确认的参数（不阻塞骨架）

品牌名、首批邀请人数、每人初始额度、导入大小/类型上限、备份保留时长、超时与取消策略。未确认前，骨架一律用保守默认值并且在响应里显式标注“未配置”。

## 8. 2026-11-14 审查与继续开发

消息与事件事务、审批一次性回答与严格校验、嵌套请求摘要和独立 Worker 包加载已修复，独立产品测试 43/43 通过。判断及后续门槛见 [开发审查记录](standalone-manager-review.md)。

## 9. 结构化问答与取消切片（2026-11-14）

已完成 questions/options/detail/multiSelect 持久化、逐题校验和 UI；schema v1→v2 自动迁移保留旧问题。Worker 将 signal 传入 HTTP/长轮询，取消与超时后尝试撤销待决卡；取消接口幂等，只能操作令牌对应项目和 operation。服务器过滤过期卡，网页到期移除，同一问题 SSE 刷新保留草稿。权限入口仅允许一次/拒绝。修复 CSS 布局覆盖 hidden 的空成果区误显示。

50 项离线测试通过；真实本地服务 + 隔离无头 Chrome 验证多题结构化提交、多选、SSE 草稿保留、取消移除及 390px 无横向溢出。截图来自虚构数据，已同步主手册和离线 HTML。未进行模型调用、安装 profile 或部署。

下一未完成切片：Worker 身份、方法与目标绑定、租约，然后以模拟引擎实现 outbox 派发与恢复。真实费用和多人开放仍需网关及隔离门槛。

## 10. Worker 身份与租约切片（2026-11-14）

schema v3 新增 Worker 注册、单 Worker 单活动租约及递增 generation；采用逐 Worker 密钥，取消全局密钥授权。HTTP 方法、完整目标、嵌套体摘要、nonce 与租约范围均校验；长轮询每次重检，异步成果校验后事务内重检。增加离线 register/lease/revoke/disable 与不含密钥的审计，密钥文件和控制库 600。

仅内部协议变化，原插件操作与现有截图不变。旧无租约 Worker 会被拒绝，必须按 worker-integration.md 同步配置。还未实现租约自动续期、调度、外部进程 fencing、模型费用或卷/容器绑定；不得把记录租约等同于任务已停止。

本切片验证：56 项离线测试通过，含 Worker 管理命令实跑；控制库与密钥权限 600、命令不输出密钥、旧库迁移与注册/问答/成果回归。主手册与离线 HTML 同步，截图无界面变化沿用。

## 11. 模拟派发与恢复切片（2026-11-14）

schema v4 增加运行记录与模拟回执，显式 PRODUCT_API_SIMULATE=1 才消费 outbox。单活动模拟记录、Worker 租约、幂等回执、完成事务、重复事件保护与保守恢复已实现。没有回执且失去租约则 uncertain 并隔离 Worker，不自动重跑；已有回执只恢复完成状态。

63 项离线回归通过，含命令实跑及数据库重开故障注入；真实浏览器发送消息→模拟回复→SSE 状态刷新通过。两张新截图入主手册，离线 HTML 同步。详细限制见 simulation-dispatch.md。

下一切片：模拟任务的权限/问答/成果完整串联及结果查询、取消协议；之后仍需真实引擎适配与网关/隔离门槛。当前不可把模拟能力当成真实派发，未部署或修改任何模型配置。

## 12. 完整交互模拟切片（2026-11-14）

schema v5 串联许可→结构化问题→示例正文/成果索引→阅读/明确确认/下载。交互模式按消息和运行记录持久化，不会因关闭启动标志跳过原审批。排队/等待时可安全取消；过期与结果不明撤销卡片，保留待核对状态。

74 项离线测试，实际 HTTP 和隔离浏览器验收通过；三张当前界面截图同步主手册和离线 HTML。模拟文档只写控制库，真实项目与模型配置不变。完整说明见 simulation-flow.md。

下一阶段是受控的真实引擎接入：先补执行适配契约、状态查询和停止/恢复协议，再实现模型网关预算与隔离门槛；不能仅将 simulation 能力改名为真实 bridge。

## 13. 真实模型正式验收准备（2026-11-14）

新增 real-model-test-plan.md、24 项结构化案例、人工编写的既有博客 fixture，以及离线准备/预检脚本。覆盖真实来源、文档/源码/教学、许可与停止、恢复/费用、租户与插件保护。脚本只生成独立工作区和证据模板，不调用模型、不修改预览或凭据。

结构检查通过；当前真实 bridge 与预算等门槛仍未通过，正式案例全部 not_run。测试准备不能替代执行适配和网关开发。运行前必须确认模型、预算与数据范围，不能将历史模型授权自动扩展为本测试的无限额度或自动审批。

## 14. 一次性真实账号通道烟测（2026-11-14）

用户另行授权当前 DeepSeek 通道1次请求、最多1000输出token、无工具。已实现一次性锁、禁重试、固定官方端点与脱敏记录；真实返回通过，模型 deepseek-flash，输入24/输出7 token。仅 engine-only，未伪装成产品操作/DSH 会话或完整真实任务。网页仍保持模拟；原配置、凭据与服务器未修改。详见 real-model-smoke-result.md。


### 2026-11-14：受限真实答疑验证

已完成持久预算、原生headless无工具适配、独立只读派发及网页刷新恢复，真实候选博客通过9项浏览器检查。详见 [执行记录](real-model-run-20261114.md)。这不完成生产Worker、工具审批/停止/交付和全部24项正式验收。

### 2026-11-14 续测

真实文档版本/确认/下载已验证；原生提问、拒绝和等待时停止通过引擎＋协议夹具，付费工具请求400无usage后冻结。见 [续测记录](pending-chains-run-20261114.md)，不得标记整套正式验收完成。
