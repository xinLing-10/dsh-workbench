# 管家架构快照：Next.js 迁移与流式发布后

分析日期：2026-11-15。依据当前源码、next-rollout-status.md 和 next-stream-verification.json 中已保存的发布与测试证据。此次只分析和更新说明文档，不修改运行服务；验收临时SSH已撤销，不将保存的部署记录冒充此刻的在线探测。

> 本文主体为已发布版本快照。后续本地业务闭环已加入任务关系、等待挂起、有界上下文、基础陪学和DOCX导出，详见[本地业务闭环进度](business-loop-progress.md)。这些变更尚未部署，不能混入下面的线上状态图。

## 1. 结论

当前是 **Next.js 表现层 + Node.js 业务控制面 + Worker执行面 + SQLite与文件持久层**，部署在单台ECS，以Nginx提供HTTPS入口。

本轮迁移改变了页面组织和增量消息链路。业务API没有搬进Next Route Handlers；线上SSE由Nginx直接代理原API。共享业务函数已复用，但普通聊天执行与原插件五阶段工作流仍有不同的入口、状态和执行适配器，不应画成已经完全统一的一条流水线。

## 2. 总体架构图

实线是当前主要调用；虚线是库复用、可选业务入口或旧版回退。框内“模型网关、调度器、共享内核适配器”是API进程内模块，不是额外微服务。

~~~mermaid
flowchart TB
    U["客户与管理员浏览器"]
    N["Nginx · HTTPS 443<br/>同源路由 / 禁用SSE缓冲"]
    U --> N

    subgraph ECS["单台阿里云 ECS · 独立 manager-trial 实例"]
      UI["Next.js 16 / React 19 / TypeScript<br/>App Router · 127.0.0.1:8120"]
      OLD["旧版原生网页<br/>由原API提供 · 可选择回退"]
      API["Product API · Node.js 24<br/>认证 / 租户 / 项目 / 幂等 / 审批 / 成果"]
      POOL["API内 Worker Pool / Coordinator<br/>SQL Outbox / 租约 / 观察 / 停止"]
      G["API内预算与模型网关<br/>三层额度 / 预占 / 结算 / 单次HTTP调用"]
      E["持久项目事件 + 进程内发布<br/>message_stream / message_completed"]
      DB[("SQLite · schema 11<br/>账号 / 操作 / 资料 / 账本 / 审计")]
      W["5个租户绑定 Worker进程<br/>127.0.0.1:8111—8115<br/>当前全池最多1个未终结执行"]
      SB["Docker临时工具容器<br/>逐次许可 / 非root / 无网络 / 只挂当前项目"]
      FS[("项目文件与Worker日志<br/>成果 / 版本快照 / 引擎事件")]
      AD["API内共享内核适配器<br/>任务 / 审阅 / 知识 / 陪学API"]
    end

    N -->|"页面与Next资源"| UI
    N -->|"/api/v1 / SSE / help / healthz"| API
    N -.->|"旧版选择"| OLD
    API --> DB
    API --> POOL
    POOL -->|"签名RPC"| W
    W -->|"签名内部模型请求"| G
    G --> DB
    G --> E
    E --> DB
    E -->|"SSE经Nginx返回浏览器"| U
    W -->|"问题 / 许可 / 成果 / 结束回执"| API
    W --> SB
    W --> FS
    SB --> FS
    API -.-> AD
    AD -.-> K["共享管家内核<br/>规范实现位于 dsh-workbench/core"]
    PL["原DSH插件<br/>Host适配器 / 五阶段Agent"] -.-> K
    K -.-> BS[("项目内 .dsh/workbench<br/>业务阶段JSON / 文档与知识文件")]
    G -->|"服务端授权HTTPS"| DS["DeepSeek模型服务"]
~~~

注意：浏览器加载Next页面后，业务请求仍是同源 /api/v1；生产环境不必经过Next进程二次转发。Next不持有SQLite连接、模型秘密或Worker租约。原生网页与Next共享同一套API，回退页面不回滚数据。

## 3. 组件分别负责什么

| 层次 | 当前实现 | 职责与实际边界 |
| --- | --- | --- |
| 展示 | apps/manager-next | 登录、项目表单、对话、资料导入、成果、管理员五分区；浏览器保留当前会话内草稿及发送幂等编号 |
| 入口 | Nginx | TLS、同源分流；默认页面8120，业务API8110；/_manager/legacy和/_manager/next仅选择页面，不授予权限 |
| 业务控制 | services/product-api | Cookie会话、Origin/CSRF、租户归属、项目、操作、资料、交互、版本确认、审计 |
| 执行协调 | worker-pool.mjs / worker-executions.mjs | 选取Outbox任务、获取租约、派发、观察原引擎、接收有序事件、停止；不因超时重派付费任务 |
| 模型网关 | model-gateway.mjs / budgeted-model.mjs | 预占后调用DeepSeek；逐帧解析文字和用量；不把模型授权交给Worker或浏览器 |
| 执行器 | services/worker-bridge | Worker独立HTTP进程与持久日志；正式模式用有界模型/工具循环，不是完整DSH Host的复制 |
| 共享业务库 | packages/manager-core → dsh-workbench/core | 原插件与产品API复用任务、文档审阅、知识和陪学函数；代码物理位置仍在插件core目录 |
| 持久化 | SQLite + 项目目录 | 控制事实与业务文件分层保存；没有新增Redis、PostgreSQL、向量数据库或外部消息队列 |

当前7个主要试用应用单位是Next、API和5个Worker；Nginx、Docker及独立私有验收实例另算。API内各模块不能据图误算成多台独立服务。

仓库Nginx配置文件是“默认旧版、Cookie选择新版”的灰度模板；已发布站点在验证后将默认改为8120。已发布状态以发布记录及校验摘要为准，不能只看模板推断线上仍为旧版。

## 4. 一次消息怎样变成回复

~~~mermaid
sequenceDiagram
    participant B as 浏览器
    participant A as Product API
    participant D as SQLite
    participant W as Worker
    participant G as API内模型网关
    participant M as DeepSeek
    B->>A: text + requestId + 会话/CSRF
    A->>A: 校验租户、项目、幂等及额度
    A->>D: 同事务保存operation、outbox、message_created
    A-->>B: 202 已排队 + operationId
    A->>D: 调度器取任务，登记租约与执行身份
    A->>W: 签名派发，固定engineId
    W->>G: 签名model-messages请求
    G->>D: 预占用户、项目与全局预算
    G->>M: 服务端授权，单次HTTPS请求
    loop 模型产生文字
      M-->>G: text_delta
      G->>D: 首块立即、约200ms合并保存全文快照
      G-->>B: message_stream，经原API的SSE通道
    end
    M-->>G: 最终usage、stop_reason与message_stop
    G->>D: 结算实际用量；缺回执保留未知预占
    G-->>W: 完整wire与模型记录
    W->>W: 写入实际成果文件
    W->>A: 登记成果路径与SHA-256
    A->>D: 核验并保存成果索引/版本快照
    W->>A: 有序结束回执
    A->>D: message_completed与任务终态
    A-->>B: 正式回复替换生成中快照
~~~

202仅表示已接收并排队；出现文字也不代表成功。模型用量结算、成果登记和执行终态是三个不同事实，不能互相替代。

模型要求提问时，Worker在API创建问题卡；用户回答后，Worker读取同一交互记录继续原任务。命令工具先生成许可卡，仅明确允许后进入当前项目的Docker容器。完整工具JSON不会作为逐字正文推送，也不执行截断的工具参数。

## 5. 增量流为什么可以恢复

- 网关边读边解析SSE，正确处理UTF-8跨数据包和CRLF；只发布文字，不发布思考块或工具参数。
- message_stream是有界的累计全文快照，不是要求客户端逐个拼接的token。浏览器按事件ID和操作身份替换，重放不会重复追加文字。
- 每个项目一个EventSource；断线通过Last-Event-ID回放持久事件，重新打开项目还可从 messages?includePreview=1 取最新快照。
- 实时事件必须先入SQLite，再发布给当前连接；发布监听器是API进程内对象。重连不会再次发送模型请求。
- message_completed是正式回复；失败、停止、待核对的过程文字标成未完成。它不是已经交付的文档。
- Next关闭响应压缩主要保护本地rewrite预览；生产SSE直接走Nginx→API，并关闭该路径的压缩和缓冲。
- 浏览器重连与API重连观察已有引擎可恢复，不等于Worker硬崩溃后能恢复其内存中的模型会话。

本轮真实无工具文本链路：1次模型请求、157 token，5条预览先于结束回执，成果摘要一致，held/unknown均0。1121ms首段和2001ms最终交付是一次验收观测，不是服务时延承诺。工具、问答及浏览器模拟证据与它分开记录。

## 6. 数据不是全部放在同一个地方

| 状态类别 | 权威记录 | 用途 |
| --- | --- | --- |
| 身份与隔离 | tenants/users/memberships/sessions/invites | 隔离依据tenantId；同租户邀请可以共享项目，不是只按邮箱隔离 |
| 操作与调度 | operations、operation_outbox、worker_leases、worker_executions | 请求幂等、排队、执行身份及状态 |
| 实时与历史消息 | project_events | 已接收消息、预览快照、交互变化和正式回复 |
| 人工交互 | interaction_requests、worker_interaction_keys | 问题、许可、明确回答与去重 |
| 上传参考资料 | project_sources | 经明确确认上传的文字、路径与摘要；不是完整可运行代码库 |
| 成果 | 工作区文件 + artifact_index/artifact_contents | 实际字节、版本、SHA和确认状态 |
| 用量与审计 | token_policies、service_model_calls、授权修订链、audit_events | 三层预算、预占、结算、异常与管理员核对 |
| 五阶段业务与陪学状态 | 项目内.dsh/workbench的JSON和文档 | 原共享内核的业务状态；当前不与聊天操作一一自动同步 |
| Worker自身记录 | 独立journal目录 | 接受任务、引擎身份、有序事件与回执恢复 |

SQLite不是只存聊天记录，也承担当前任务队列和控制面。Worker日志不是第二份额度账本。项目业务JSON与执行操作SQL可以分层存在，但需要明确映射；当前不能宣称所有状态已经完全统一。

## 7. 共享内核接通到了哪里

原插件通过Host适配器调用同一套core；产品API通过createProductManager调用它，并暴露manager、knowledge、document-review、learning系列路由。

但是正式server.mjs创建createApp时**没有提供managerRuntime**。因此共享内核的阶段执行adapter、Word生成和ZIP打包端口没有在这条正式启动链中注入；相应操作会被能力检查拦住。

同时，普通 /messages 路由直接进入SQL操作队列和Worker，没有自动调用共享内核推进spec/design/build/verify/ship。Next当前“带我学懂项目”是选择资料并生成可编辑的学习请求草稿，不等同于原插件完整六步陪学面板；Worker能力也仍标记learning:false。

所以合理的图是“两条路径共用部分库”，不能画成独立网页已经完整接管原插件全部五阶段、知识、陪学和正式Office交付。

## 8. 现在最值得优化的架构点

### 优先一：统一对话与业务任务的映射

建立明确的“对话请求→业务任务/学习会话→执行操作→成果版本”关系。先规定状态归属和事务边界，再让Worker适配共享任务服务；避免同一件事在SQL与业务JSON里各自演进。

共享代码目前通过packages入口复用，但规范实现仍物理依赖dsh-workbench/core。可以继续抽成真正独立包，再由插件和产品依赖，不能只凭入口目录名宣称已经完全解耦。

### 优先二：把执行槽与等待用户分开

五个Worker不是五路并行，当前全池只容许一个未终结执行。waiting、stopping、uncertain也在阻塞范围内：一人等待回答，其他人也可能排队。

后续应区分“正在调用模型/运行工具”与“持久挂起等待人”，对用户/租户做公平排队、限制活动模型和工具数量。未知用量仍应保守冻结；不能为了提高并发直接丢弃未知任务或伪造结束回执。

### 优先三：补长期会话与项目检索

当前每个新操作的模型messages从当前job.text开始；同一操作内的问答/工具循环会续写messages，但新发送的一条消息不会自动获得整个历史对话。界面看到历史，不代表模型也看到了全部历史。

上传资料目前按文件路径顺序截取文字注入上下文，最多50个文件/512KB存储，单文件32KB；实际输入还受字符和字节预算截断。没有按问题检索的向量RAG、代码符号索引或自动读取完整项目。后续应增加受项目权限控制的历史摘要、上下文组装和可追溯检索，先解决“模型依据是什么”。

### 优先四：将业务输出能力真正接到独立网页

完成managerRuntime端口或等效受控Worker适配，贯通学习状态、知识条目与交付流程。当前聊天执行器的常规成果是文本/Markdown文件；不能因为共享库中有生成器，就把Word/PDF/PPTX等全部视为独立网页已可正式交付。

### 优先五：扩展部署之前处理单点与协调

当前单ECS、单控制API、SQLite加进程内锁/发布器。持久事件能恢复历史，不能让多API副本自然共享实时订阅与执行锁。业务量上升后，再按证据决定共享队列、分布式租约、数据库和对象存储；不能直接复制几个API进程就认为完成高可用。

## 9. 安全与验收的实际范围

模型授权只在API网关解析；Worker持有控制签名密钥，浏览器只有应用会话和CSRF。Docker工具容器无网络、非root、只挂当前项目、受资源限制。Worker控制器拥有Docker访问权，仍在可信运维边界，不能称为对任意恶意代码的完备隔离。

当前公网定向试用共享50,000,000 token累计总额，个人与项目各5,000,000，另有累计请求次数保护；三层额度取约束交集，不相加。旧未知预占与历史异常保留，不在改页面时清空。

独立私有验收已完成1464样本、24.65小时，失败、断档、重启、新模型请求均0。观察timer已停，模型暂停，临时授权已撤销。这是私有空闲运行观察，不是线上真实业务负载压测，也不等于活动Worker崩溃恢复验收；公网试用与其预算、凭据和进程相互独立。

## 10. 源码索引

- [Next项目对话](../../apps/manager-next/components/project-view.tsx)、[EventSource与去重入口](../../apps/manager-next/hooks/use-project-events.ts)
- [正式API启动](../../services/product-api/server.mjs)、[业务路由与SSE](../../services/product-api/src/app.mjs)
- [共享内核适配](../../services/product-api/src/manager-core.mjs)、[规范内核](../core/index.js)
- [池调度](../../services/product-api/src/worker-pool.mjs)、[租约与观察恢复](../../services/product-api/src/worker-executions.mjs)
- [预算与结算](../../services/product-api/src/service-budget.mjs)、[模型增量解析](../../services/product-api/src/budgeted-model.mjs)
- [预览快照](../../services/product-api/src/message-stream.mjs)、[资料上下文](../../services/product-api/src/project-sources.mjs)
- [Worker启动](../../services/worker-bridge/worker.mjs)、[正式执行器](../../services/worker-bridge/lib/isolated-runtime.mjs)
- [发布与回退记录](../../deploy/service/next-rollout-status.md)、[流式验收证据](next-stream-verification.json)
- [私有观察最终报告](../../deploy/service/acceptance-final-report.json)
