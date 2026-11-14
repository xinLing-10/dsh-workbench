# worker-bridge（Worker 侧桥接，S5）

状态：**已实现映射与客户端，未在真实 Worker 上联调**。设计见 `dsh-workbench/docs/standalone-manager-design.md`，排期见 `dsh-workbench/docs/standalone-manager-plan.md`。

它把 DSH 的两个 waterfall 接到产品 API：

| waterfall | 行为 |
| --- | --- |
| `approval/request` | 生成待决请求 → 产品 API `POST /internal/v1/interactions` → 长轮询取回答 → 返回 `allowed-once / rejected / cancelled / unavailable` |
| `user-questions/request` | 同上，把结构化 `questions` 原样转发，回答映射回 `{ answers: [...] }` |

失败语义：审批超时或产品不可用 → `unavailable`（fail closed，绝不默认允许）；提问失败 → `next()` 交给下一个 answerer，不编造答案。

## 配置

```yaml
- id: manager-bridge
  name: '@manager/worker-bridge'
  config:
    enabled: true
    productApiUrl: 'http://product-api.internal:8089'
    workerSecret: '<离线注册的专属密钥>'
    leaseId: '<管理员授予的租约 id>'
    generation: 1
    operationId: 'op_x'
    workerId: 'wrk_x'
    tenantId: 'ten_x'
    projectId: 'prj_x'
    approvalTimeoutMs: 300000
    questionTimeoutMs: 300000
```

默认 `enabled: false`：缺 productApiUrl / workerSecret 时插件完全惰性。

## 测试

```bash
node --test tests/*.test.mjs
```

- `decide`：映射与失败语义（8 项）
- `integration`：起真实产品 API → worker 创建提问 → 用户回答 → `waitAnswer` 拿到答案（1 项，跨服务）

## 已验证的接入

- 打包为 DSH bundle，已用 `plugin_manager install_bundle` 装入真实 profile；`include:manager-bridge` 的 `fiberPhase` 为 `active`，配置 `enabled: false` 时完全惰性。
- `tests/real-composition.test.mjs` 在 DSH 自带的 Cordis `Context` 上验证注册了 `approval/request` 与 `user-questions/request`。
- 用 `probes/check-integration.mjs` 只读检查产品库，判断真实 Worker 是否已经调用过并完成回答闭环。
- 完整步骤与安全边界见 `dsh-workbench/docs/worker-integration.md`。

## 未做

- 真实模型链路（需要额度、运行中的 Worker 与一次人工回答）。
- 事件推送（消息/任务状态）与用量上报。
- Ed25519 令牌与密钥轮换（当前为逐 Worker 的 HMAC-SHA256 密钥）。

## 独立打包与契约同步

`npm run contracts:sync` 从共享契约生成包内 lib/token-contract.mjs，`npm run contracts:check` 检查一致性；prepack 自动同步。运行时不再引用包外 packages。隔离目录测试验证无仓库兄弟目录时仍可加载。不要手改生成文件。

2026-11-14 摘要修复覆盖嵌套字段，产品 API 和 Worker 必须同步升级，不能与旧摘要实现混用。本轮未重装现有 profile。

结构化问答与取消已接入：共享问题契约同步生成 question-contract.mjs；审批/提问信号传入 HTTP 与轮询；取消/超时后独立发送撤卡请求（失败不隐式批准，以到期兜底）。问题校验拒绝缺失、重复编号及不存在的选项。

身份协议升级：每次请求签名包括 method、target、leaseId 和 generation；产品 API 不再接受全局共享密钥授权。无租约的旧配置会被拒绝，升级步骤见 Worker 桥接手册。未自动修改任何现有 profile。


统一 Worker v1 新增 `worker.mjs --config <私有配置>`、`lib/runner.mjs` 和 `lib/server.mjs`。运行模块由管理员显式提供，默认不启动或调用模型；签名控制请求、持久日志、去重、观察和真实停止回执与原生问题/审批共用同一个操作与租约。完整接口与启用步骤见 [统一 Worker 协议](../../dsh-workbench/docs/unified-worker-protocol.md)。打包前同步三份契约，不能手改生成文件。

正式服务模式使用 `formalService: true`，不加载自定义引擎模块；内置 `isolated-runtime` 经签名产品网关调用模型，命令仅在固定镜像、无网络 Docker 中经逐次审批执行。配置和限制见 [正式预算与隔离](../../dsh-workbench/docs/service-budget-isolation.md)。
