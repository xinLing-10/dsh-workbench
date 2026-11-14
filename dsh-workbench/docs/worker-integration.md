# Worker 桥接：身份、租约与本地验证

当前状态（2026-11-14）：统一 Worker v1 已串联派发、观察、提问、审批、停止、成果和恢复，并通过当前 DeepSeek 的受限真实模型验证。默认未开启通用执行；生产计费、任意代码 Worker 和强隔离仍未完成。协议、启用开关、运行适配器、真实证据与范围见 **[统一 Worker 协议与验证](unified-worker-protocol.md)**。下文手工租约步骤用于原有桥接诊断，不是统一派发器的日常启动流程；未改服务器或原有 DSH profile。

## 管理员本地准备（Node 24）

以下命令在 `services/product-api` 目录运行，使用同一个 `PRODUCT_API_DB`。先通过已有邀请 CLI 创建测试账号，登录本地网页并创建项目，再从受控数据库取得租户和项目 ID。不要从浏览器上传宿主路径或原生 DSH 凭据。

1. 启动本地 API：

   ```sh
   PRODUCT_API_DB=./control-data/product.sqlite PRODUCT_API_ALLOW_REDEEM=1 node server.mjs
   ```

2. 在另一个终端用相同数据库离线注册 Worker。先准备仅自己可读的目录；命令将随机生成专属密钥，写入新文件，权限为 600，不向终端输出密钥，不覆盖已有文件：

   ```sh
   install -d -m 700 ./control-data/credentials
   PRODUCT_API_DB=./control-data/product.sqlite node worker-admin.mjs register wrk_local ten_xxx ./control-data/credentials/worker.secret
   ```

3. 为一个项目/操作授予租约：

   ```sh
   PRODUCT_API_DB=./control-data/product.sqlite node worker-admin.mjs lease wrk_local prj_xxx op_xxx 300000
   ```

   输出包含 `id`（配置中的 leaseId）、`generation`、projectId、operationId、expiresAt，不含密钥。Worker 同时只能有一个有效租约，最长一小时；旧租约需先撤销或等待到期。当前命令允许空 operationId 供诊断，不能当作业务任务派发。

4. 将密钥通过管理员受控方式填入 Worker 私有配置，不要粘贴到聊天、README 或截图：

   ```yaml
   - id: manager-bridge
     name: '@manager/worker-bridge'
     config:
       enabled: true
       productApiUrl: 'http://127.0.0.1:8089'
       workerSecret: '<本 Worker 专属密钥>'
       workerId: 'wrk_local'
       tenantId: 'ten_xxx'
       projectId: 'prj_xxx'
       operationId: 'op_xxx'
       leaseId: '<lease 命令返回的 id>'
       generation: 1
       approvalTimeoutMs: 300000
       questionTimeoutMs: 300000
   ```

   容器中 127.0.0.1 指该容器自身，不能照抄作为跨容器地址；跨容器需另行配置受控内网入口。仅此配置不会创建/调度业务任务。

5. 撤销或停用：

   ```sh
   PRODUCT_API_DB=./control-data/product.sqlite node worker-admin.mjs revoke lease_xxx
   PRODUCT_API_DB=./control-data/product.sqlite node worker-admin.mjs disable wrk_local
   ```

   后续请求会被拒绝，等待中的长轮询约每 200ms 重检租约。撤销不代表操作已安全停止，不能据此自动重试；网页待决卡可能等到请求过期或刷新后消失。

## 协议与升级要求

- 内部请求按已注册 Worker 查找其密钥，核对租户、项目、operation、leaseId 和 generation；全局 `PRODUCT_API_INTERNAL_SECRET` 已不再用于授权。
- 每条令牌绑定 HTTP 方法、完整路径（含查询参数）、请求体摘要、短有效期和单次 nonce。改变目标或内容、跨项目、旧代次、过期、撤销、停用都会拒绝。
- 文件系统校验可能等待，成果注册会在数据库事务内再次检查租约，防止过期 Worker 在校验后提交索引。
- schema v3 自动增加 Worker/租约表并保留旧问题与项目。控制库包含敏感的 Worker 密钥，文件权限为 600；备份同样应受控。本轮没有实现密钥轮换或加密存储。
- 产品 API 与 Worker 必须一起升级。旧 Worker 的无租约令牌将被拒绝；不能沿用旧的共享密钥接入步骤。
- 打包前运行 `npm run contracts:sync` / `npm run contracts:check`；运行时使用包内生成契约，不依赖仓库外目录。

## 验证与未完成边界

离线测试覆盖身份、租约、撤销中的长轮询、完整多题回答、成果访问、旧库迁移与本地管理命令；不调用模型。历史真实 Cordis Context 组合与 disabled profile 装入记录仅证明注册和历史安装，不证明真实模型闭环。

统一协调器现在维护操作状态、幂等派发和观察恢复；单 Worker 与单控制进程的受限原生工具链已通过真实模型验证。独立容器/卷、出网策略和生产费用结算尚未整合；租约本身仍不能保证外部进程已终止，因此不能据此向陌生用户开放。
