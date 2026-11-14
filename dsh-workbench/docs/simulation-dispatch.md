# 模拟派发与恢复（2026-11-14）

仅用于本地验证。模拟引擎不会调用模型、启动 shell、执行项目代码或修改项目文件；简单模式只保存带“模拟执行”标记的回复回执；新交互模式还能生成数据库中的示例文档，见 simulation-flow.md。没有生成真实需求文档或真实交付物。

## 运行

需要 Node 24。先按 worker-integration.md 创建测试账号和项目，注册属于该租户的测试 Worker。为模拟队列注册 Worker 即可，不要手工为它长期占用诊断租约：派发器会自动授予该操作的租约。

所有命令在 services/product-api 目录执行，必须指向同一控制库：

```sh
# 默认关闭：普通启动只保存消息，不消费队列。
PRODUCT_API_DB=./control-data/product.sqlite node server.mjs

# 显式启用模拟：每秒尝试消费一条消息。
PRODUCT_API_DB=./control-data/product.sqlite PRODUCT_API_SIMULATE=1 node server.mjs

# 也可关闭自动运行的服务后单次处理，便于维护验证。
PRODUCT_API_DB=./control-data/product.sqlite PRODUCT_API_SIMULATE=1 node simulate.mjs

# 只核对已有运行记录与回执，不派发排队消息。
PRODUCT_API_DB=./control-data/product.sqlite PRODUCT_API_SIMULATE=1 node simulate.mjs --recover
```

启用后，同一库里以前保存的排队消息也可能被处理。没有可用 Worker 时保持排队；不要为了“解卡”反复发送同一需求。网页可看到模拟排队、处理中、已完成或结果待核对，回复开头明确标注模拟。

模拟能力独立于真实 bridge 能力；后者仍为 false，真实业务动作仍拒绝。不能将模拟回复当成模型分析或成果确认。

## 保存与恢复

schema v4 新增 dispatch_runs 和 simulation_receipts，保留已有项目/问题/Worker 数据。

1. 消息、操作、outbox 已同事务保存。
2. 派发器分配租约，再以数据库条件更新领取 queued 操作，持久化运行记录；一个 Worker 一个操作，模拟队列同时只运行一条记录。重复 outbox 不会重复领取。
3. 模拟引擎按 operation ID 和 payload hash 保存唯一回执；正常完成时同事务写完成状态、回复和状态事件，删除对应 outbox，释放租约。
4. 收到回复时重新核对租约，迟到或失效的回包不能直接写完成。
5. 恢复发现有效模拟回执时，只补齐状态和事件，重复核对不会重复回复。
6. 没有回执且租约已失效时标记 uncertain，隔离该 Worker，不自动重跑。不能将超时当作“肯定未执行”。活跃租约尚未到期时等待，避免将其他执行者误认为崩溃。

模拟回执是当前受控引擎自己的持久证据，不适用于未来真实模型/DSH 的恢复。真实接入还需要引擎幂等键、可信状态查询、进程停止及对账协议。当前没有为无证据的 uncertain 提供强制重试按钮。

## 验证

63 项独立产品离线测试，包含重复 outbox、竞争派发、失效租约拒绝效果、迟到确认、无回执隔离、回执落盘后丢失确认及数据库重开恢复，还有单次命令显式启用验证。

隔离 Chrome + 实际本地 API 验证：发送消息、模拟完成和 SSE 回复/状态刷新，桌面及 390px 截图入手册。使用虚构项目和模拟 Worker，无模型调用。数据库重开是故障注入验收，不宣称已完成真实 DSH 进程恢复或服务器崩溃演练。

## 尚未完成

真实任务派发、真实权限/问答与引擎状态机整合、租约续期、真实引擎恢复与取消、模型网关计量、容器/卷绑定、外部用户隔离。所有部署与模型配置保持不变。

后续更新：完整模拟许可/问答/示例文档链路已实现，当前 schema v5、总计 74 项离线测试；本文件中的 v4/63 项为上一切片记录。见 simulation-flow.md。
