# P0 前置验证：兼容性记录

基线：DSH `0.2.1-rc.2`、工作台 `1.24.1`。核对日期：2026-11-13。设计依据：`standalone-manager-design.md` §11。

本文件是**证据记录**，不是能力承诺。所有结论都可以用下面两条命令复现：

```bash
node services/product-api/probes/probe-dsh-surface.mjs
node services/product-api/probes/probe-session-log.mjs --max-sessions 60
```

- `probe-dsh-surface.mjs`：只读导入本机安装的 DSH 包，检查审批/提问/用量/`baseURL` 是否存在（8/8 通过）。
- `probe-session-log.mjs`：只读解析 `~/.dsh/sessions` 的既有会话日志，统计真实运行中是否真的出现过审批、提问与用量事件。

本轮实测样本：**60 个会话目录、242 次审批（asked/decided 成对）、42 次 `ask_user_question`、791 条 usage 分片**。

> 更新说明（2026-11-14）：下文共享密钥与未实现桥接描述为最初探针记录。当前已加入逐 Worker 注册、租约代次、方法/目标绑定和离线管理，见 worker-integration.md；尚无调度、模型计量及容器绑定，P0 未全部通过。

## 结论总表

| # | 项 | 结论 | 依据（可核对） |
| --- | --- | --- | --- |
| P0-1 | 内部业务桥接 | **可行，待实现** | `dsh-user-approval` 的 `approval/request` 与 `dsh-user-questions` 的 `user-questions/request` 都是 Cordis **waterfall** 监听器，可在 Worker 内实现"转发到产品 API → 等用户决定 → 返回结果"；现有 `/workbench/*` 已经演示了"服务内注册路由 + 自带鉴权"的模式 |
| P0-2 | 权限审批与用户追问 | **通过（证据充分）** | 真实日志中 `approval/asked` / `approval/decided` 成对出现（含 `id`、`toolName`、`callId`、`reason`、`outcome`）；`tool/call` 中 `ask_user_question` 42 次，参数是结构化 JSON（`questions[].id/header/options`） |
| P0-3 | 模型网关 | **部分可行** | `dsh-llm-deepseek` 的配置声明了 `baseURL`（可指向网关）；DSH 侧能看到 `usage{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}`；但该分片来自 `assistant/chunk`，**不在** `KNOWN_SESSION_EVENT_TYPES`（属可忽略的外部事件），不能作为唯一计量来源，网关必须自己解析上游响应 |
| P0-4 | 操作归属 | **只到 Worker 级** | DSH 事件里没有"本次调用属于哪个 operationId"的字段；只有 `user_id`（DeepSeek 支持的稳定匿名标识）。按设计 §9.1 降级：**单 Worker 同时只允许一个业务操作**，产品侧用 `engine_request_id` 关联，不承诺逐调用归因 |
| P0-5 | 硬边界 | **部分可行** | `deploy/instance.py` 已有 `read_only`、`cap_drop: ALL`、`no-new-privileges`、`pids_limit`、`mem_limit`、`cpus`、每实例独立 `home`/`workspace` 卷；**缺**：出网策略、按租户独立卷（当前按实例）、控制库与 Worker 的显式隔离清单 |
| P0-6 | 主状态恢复 | **通过** | 插件侧已有确认回执、`uncertain` 状态与自愈（曾实测把误判的 failed 任务恢复为 completed）；DSH 会话日志是可回放的 zstd 分片；产品侧 `operations` + `operation_outbox` 已按"先入库后投递"建模 |

## 逐项细节

### P0-1 内部业务桥接

- 约束：**不得关闭原生 fence，也不得向浏览器转发 DSH 凭据**（设计 §4.2）。
- 可行路径：在 Worker 内新增一个内部桥接插件，注册独立路由（不复用 `/workbench/*`），用产品服务签发的短期令牌校验；令牌声明 `aud/tenantId/workerId/projectId/op/operationId/lease/jti/exp`，写请求绑定方法+目标+体摘要防重放。
- 待补：令牌签名实现（Ed25519 或 HMAC，固定算法）、时钟偏差与轮换、重放表、审计。

### P0-2 权限审批与用户追问（通过）

- 审批：`ctx.approval.request({agent, toolName, callId, reason, signal})` → 由 `approval/request` 监听器返回 `allowed-once | rejected | cancelled | unavailable`；超时/无应答必须 `unavailable`（fail closed）。
- 追问：`ctx.userQuestions.ask()` / `askTimed()`；`user-questions/request` 监听器返回 `AskUserQuestionAnswer`。
- 证据解读：242 次审批说明该路径在本机是常态（沙箱升级、危险命令），42 次提问说明结构化问答也是常态；两者都**已落盘为审计事件**，因此产品可以"重启后从会话日志恢复待决请求"。
- 产品侧需要：Worker 把待决请求 POST 到 `interaction_requests`；前端权限卡/问题卡；回答经 bridge 回传；过期按拒绝处理并记录。

### P0-3 模型网关（部分可行）

- 可行：把 `dsh-llm-deepseek` 的 `baseURL` 指向网关，网关固定上游域名、自己设置 `Authorization`，Worker 不持有真实 Key。
- 待补：网关需解析上游 SSE 的 `usage`（DSH 侧的分片不能作为唯一账本）；`user_id` 由网关按租户生成并覆盖；预算预留/结算在网关侧完成。
- 风险：若上游不返回 usage（断流/超时），必须记"待核对"，不能按 0 计费。

### P0-4 操作归属（只到 Worker 级）

- 现状：会话事件里没有 operationId；`user_id` 是匿名稳定值，只能到租户/安装级。
- 设计允许的降级：单 Worker 同时仅一个业务操作；产品侧记录 `engine_request_id` 与租约代次；网关按"租户 + 时间窗 + 单并发"归属。
- 因此：**不要声称可以按次精确分摊**；UI 上额度以"预留/结算/待核对"三态展示。

### P0-5 硬边界（部分可行）

- 已有：只读根文件系统、丢弃全部 capability、禁止提权、PID/内存/CPU 限额、独立卷。
- 缺：出网白名单（模型网关 + 依赖镜像，禁云元数据与控制服务）、按租户独立卷（当前按实例）、Worker 与控制库/密钥的显式隔离清单与验收脚本。
- 结论：**可以自用**，**不可以面向陌生用户**，与设计一致。

### P0-6 主状态恢复（通过）

- 插件侧：确认回执 + 哈希快照 + `uncertain` 状态 + 自愈逻辑；已实测"误判失败的任务按已完成的 turn 恢复"。
- DSH 侧：会话日志分片可回放，`turn/end.reason` 是对象（`{kind:'completed'}`），适配层已按对象归一化。
- 产品侧：`202` 只代表接收；`operation_outbox` 支持重试；同 `request_id` 不建第二份操作（已有测试覆盖）。

## 决定

1. **P0-2、P0-6 通过**：可以进入第一批的"桥接适配 + 自用闭环"，先接**本人账号、单 Worker、模拟模型**。
2. **P0-1、P0-3 是"要补实现"而不是"能力不存在"**：令牌桥接与网关计量可以按 P1 任务实现，但在完成前**不接真实模型、不产生真实费用**。
3. **P0-4 按设计降级**：产品只承诺 Worker 级归属，单 Worker 单操作；UI 不展示"逐次精确分摊"。
4. **P0-5 未通过**：保持自用与本地验证，**不邀请外部用户、不开放匿名注册**；上线前补齐出网策略与租户卷。

## 复现与更新

- 两条探针命令见文首；任一探针失败即视为 P0 回退，必须在同一提交内更新本文件与实施计划。
- 换 DSH 版本后必须重跑，并把结果追加到本文件的"变更记录"。

### 变更记录

| 日期 | DSH 版本 | 结果 |
| --- | --- | --- |
| 2026-11-13 | 0.2.1-rc.2 | surface 8/8；日志样本 60 会话 / 242 审批 / 42 提问 / 791 usage |
