# DSH Workbench · 产品开发工作台

面向 DeepSeek Harness（DSH）的产品开发插件，将需求分析、详细设计、编码实现、测试验收和交付组织在同一个工作台中。

当前开发分支：**personal_manager / v1.24.1**。默认通过项目管家沟通，保留完整文档、版本确认和交付记录；需要时可进入五阶段详细工作区。

文档按读者区分：

| 读者 | 文档 | 内容 |
| --- | --- | --- |
| 客户、首次使用者 | [客户使用手册](dsh-workbench/docs/manager-user-guide.md) · [离线图文版](dsh-workbench/docs/manager-user-guide.html) | 说需求、回答、授权、查看确认下载成果、陪学和常见问题 |
| 平台管理员、服务负责人 | [管理员使用手册](dsh-workbench/docs/manager-admin-guide.md) · [离线图文版](dsh-workbench/docs/manager-admin-guide.html) | 控制台、邀请码、额度、用量和执行核对、审计及异常处理 |
| 开发者、测试及部署维护人员 | [开发者与运维手册](dsh-workbench/docs/manager-developer-guide.md) | 架构入口、开发检查、模型与预算、管理操作、部署及恢复 |
| 部署验收人员 | [服务器验收记录](deploy/service/acceptance-status.md) | 实际测试结果、观察状态、预算和未覆盖范围 |

后续修改必须同步维护相应文档；客户主手册与离线版的更新原则见 [AGENTS.md](AGENTS.md)。

![工作台知识视图](dsh-workbench/docs/screenshot-knowledge.png)

新增 **项目陪学（三个批次）**：打开业务项目后点击“项目陪学”，选择资料，进行原理导读与零基础问答。实现及后续批次见 [项目陪学方案](dsh-workbench/docs/project-learning.md)。已支持个性化学习计划、逐课讲解与复述反馈、学习副本编辑，以及 Markdown / 离线 HTML / ZIP 学习资料。练习不自动执行代码，模型反馈不等于测试通过。

教学优化三个批次增加步骤式陪学、可纠正学员观察、项目功能知识关系、可关闭的学习记忆检索与可控复习安排，进度见 [教学架构与分批记录](dsh-workbench/docs/teaching-architecture.md)。

维护者可使用 [教学评测工具](dsh-workbench/docs/teaching-evaluation.md) 检查已有模型回复；12 个案例不自动调用模型，真实教学效果仍需试学。

## 独立管家产品（设计中，骨架已开始）

面向“自有前端、普通账号登录、运营者统一提供模型”的详细设计见 **[独立管家产品详细设计方案](dsh-workbench/docs/standalone-manager-design.md)**；排期、偏差与证据见 **[实施计划](dsh-workbench/docs/standalone-manager-plan.md)**。

已开始的部分（本轮）：

- `packages/manager-contracts/`：错误码、事件类型、动作白名单、信封与幂等规则（含契约与签名测试）。
- `services/product-api/`：SQLite 控制库、邀请/登录/会话、项目、消息与动作（202 + outbox）、SSE 事件、租户归属校验（含 API 回归测试）。

P0 前置验证已形成部分证据，尚未全部通过：[P0 兼容性记录](dsh-workbench/docs/p0-compatibility.md)（审批 242 次、提问 42 次、usage 791 条的真实日志样本；两条可复现探针位于 `services/product-api/probes/`）。

- `services/worker-bridge/`：Worker 侧把审批与提问 waterfall 接到产品 API（短期令牌 + 重放防护 + 长轮询应答），含跨服务集成测试与真实 Cordis 组合测试；已打包为 DSH bundle 并装入 profile（`enabled:false` 惰性）。接入步骤与验收见 [Worker 桥接手册](dsh-workbench/docs/worker-integration.md)。
- `apps/manager-web/`：最小可用独立前端（原生 ES module，无构建），登录、项目列表、对话、互动回答、成果阅读/确认/下载、多版本切换与 SSE 实时刷新；由产品 API 同源托管并带严格 CSP。

明确未完成：通用编码 Worker、生产用量结算与生产模型网关、多 Worker 分布式调度、完整陪学前端与管理端。受限真实工具链已通过，见下文。常规服务的桥接能力当前仍声明为不可用；另有独立的原生 DSH 只读验证入口，需要执行的动作会返回 `capability_unavailable`，不会静默放行。因此**还不能把当前 owner 实例当作共享多用户产品**，也不能邀请外部用户。

共享管家业务内核已提取：原插件与独立产品 API 使用 `dsh-workbench/core/` 的同一套任务、文档、知识和陪学实现，仓库公共入口为 `packages/manager-core/`。兼容入口、原项目数据路径和原生权限边界保留；独立 API 新增租户隔离的共享服务接口。详细结构、状态归属、接口、执行适配器与验证见 [共享管家内核设计与实施记录](dsh-workbench/docs/shared-manager-core.md)。完整陪学前端、真实通用 Worker 和跨进程共同写入不在本轮实现范围；原模拟/只读验证通道不会自动变成五阶段执行。

## 仓库结构

- `dsh-workbench/`：工作台前端、Host 接口、知识与文档管理、测试。
- `spec-analyst-preset/`：需求分析师角色配置。
- `stage-presets/`：设计、开发、测试和交付角色配置。

## 安装

需要可正常运行的 DSH 环境和模型配置。当前本地使用的 DSH 版本为 `0.2.1-rc.2`；DSH 仍在迭代，升级前请验证插件兼容性。

克隆仓库后，使用每个插件目录的绝对路径安装：

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-workbench/dsh-workbench
dsh plugin --profile web add link:/absolute/path/to/dsh-workbench/spec-analyst-preset
dsh plugin --profile web add link:/absolute/path/to/dsh-workbench/stage-presets
```

检查 Web profile 已启用三个 bundle；保留现有 DSH bundle 配置。重启 `dsh web` 并刷新浏览器。

完整功能与安装说明见 [工作台 README](dsh-workbench/README.md)，知识管理说明见 [使用文档](dsh-workbench/docs/knowledge.md)。

## 阿里云服务器部署

当前提供“一个个人实例 → 每位受邀可信用户一个独立实例”的 Docker 部署方式，完整步骤见 **[ECS 部署指南](deploy/README.md)**。推荐使用专用子域名和 HTTPS，Nginx 转发到服务器本机端口，保留原生 DSH 认证。它不是共享实例的多租户服务，也尚未提供自助注册或计费。

本次准备对应 2 核 2GB、Ubuntu 22.04 的上海 ECS，先部署一个实例。大陆服务器需核对 ICP 备案；域名实名认证、备案、DNS、证书和公网验收分别完成，不能仅因购买域名就认为已经上线。完整准备流程：

1. 只读检查服务器架构、内存、磁盘、端口和已有网站，确认 Docker / Compose。
2. 本机构建匹配架构的镜像和源码归档，上传后导入服务器。
3. 启动只监听本机端口的独立实例，验证认证、管家、模型小任务、审阅、下载和重启恢复。
4. 核对备案与证书，配置专属 DNS / Nginx；确认所需安全组规则后验收 HTTPS 和 WebSocket，再邀请用户。

本地仓库根目录准备示例：

```sh
python3 deploy/release.py --output /tmp/dsh-workbench-1.18.0-source.tar.gz
tar -tzf /tmp/dsh-workbench-1.18.0-source.tar.gz
docker build --platform linux/amd64 -f deploy/Dockerfile -t dsh-workbench:1.18.0-ad9c578 .
docker save dsh-workbench:1.18.0-ad9c578 | gzip > /tmp/dsh-workbench-1.18.0-image.tar.gz
```

上传与运行命令、证书路径、单用户开通、备份、升级回滚和故障处理见部署指南。服务器若为 ARM，应改用 `linux/arm64`。归档不包含模型密钥、个人会话或业务数据；不要复制本地整个 `.dsh` 上云。镜像自带中文字体，复杂 Word 转 PDF 仍需按需配置 LibreOffice。

部署文件检查：

```sh
python3 -B -m unittest discover -s deploy -p 'test_*.py'
sh -n deploy/entrypoint.sh
node --check deploy/healthcheck.mjs
```

已在真实 ECS 部署 `owner` 实例，当前版本 1.24.1；已完成来源受限的本人 IP HTTP 认证、管家/手册接口与 WebSocket 协议验收，保留 SSH 隧道访问方式。浏览器完整交互与真实模型任务仍待验收；当前不是公共多用户产品。历史文档生成与重启验证、实际状态和边界见 [部署验证记录](deploy/preparation-status.md)。

## 验证

修改使用手册后，在 `dsh-workbench` 中运行 `npm run docs:guide`，重新生成离线图文版。

```sh
cd dsh-workbench
npm run check
npm test
```

当前包含 203 项自动化测试。界面截图来自开发验证；测试不等于所有模型、部署方式及多人场景均已验证。

## 数据与使用范围

项目文档、确认记录和上下文清单存储在项目的 `.dsh/workbench/` 中；DSH 自身配置、会话和凭据由 DSH 管理。运行数据、密钥及本地备份不应提交到仓库。

当前面向个人或可信环境使用，尚未实现面向公共服务的多租户权限与强执行隔离。部署脚本提供每人独立容器及持久卷，不能替代陌生用户任意代码的强沙箱。Agent 可以读写工作文件并执行命令，请使用合适的权限和独立工作环境。

若开始任务时提示后端接口未就绪，需重启 DSH Host；仅刷新前端不能加载新增的 Host 路由。

阶段进度、下一步入口、任务队列与插件保护原则见 [阶段引导说明](dsh-workbench/docs/stage-guidance.md)。

本人 IP 验证与后续域名 HTTPS 切换见 [部署指南 4A](deploy/README.md#4a-备案等待期间的本人-ip-验证)。临时 IP 入口须限制本人来源、保留原生认证；HTTP 只用于非敏感验证，实际启用状态见部署记录。

本地独立产品的审查、可靠性修复与后续门槛见 [开发审查记录](dsh-workbench/docs/standalone-manager-review.md)。

独立原型新增逐题单选/多选与补充回答、旧库迁移、取消撤卡和刷新草稿保留；50 项离线测试及虚构项目浏览器验证通过。真实任务派发仍未接通，见使用手册的独立网页部分。

独立原型继续补齐 Worker 专属身份、单操作租约、代次与方法/目标校验，以及本地注册、撤销和停用命令。旧共享密钥接入已停用，升级说明见 [Worker 接入手册](dsh-workbench/docs/worker-integration.md)。真实派发、模型费用和容器绑定仍待完成。

本地原型已补默认关闭的模拟队列、唯一回执与保守恢复：63 项离线测试和虚构项目浏览器验证通过。启用、恢复与边界见 [模拟派发说明](dsh-workbench/docs/simulation-dispatch.md)。它只验证消息流程，不等同于真实任务执行或成果交付。

交互模拟进一步串联许可、两道结构化问题、示例文档阅读/确认/下载及安全取消；74 项离线回归和真实浏览器实际下载验证通过。示例文档仅存控制库，不是模型成果。[完整模拟说明](dsh-workbench/docs/simulation-flow.md)。

真实模型测试准备已提供：[24 项正式验收方案](dsh-workbench/docs/real-model-test-plan.md)，包含新建博客、已有项目改造、交付与教学，以及权限/恢复/费用验收。离线准备脚本不调用模型，当前真实接入仍阻断，不能把模拟测试视为正式通过。

已按单独授权完成 [一次真实 DeepSeek 账号基础烟测](dsh-workbench/docs/real-model-smoke-result.md)：1次、24输入/7输出token、无工具和重试。该历史烟测仅验证模型通道。最新进展：已新增本机真实只读答疑验证，见下文；完整工具执行仍未完成。

本轮获准 200,000 token 上限后，已验证 **真实 DeepSeek 文本分析 → 原生 DSH 无工具会话 → 独立网页只读答疑**，含等待时刷新恢复与安全回复排版；累计 14,671 token（含前次31），未计算金额。真实修改候选通过9项浏览器检查，但不是工作台完整编码/交付验收。运行入口 `services/product-api/readonly-preview.mjs --start`，需本轮已保存的授权；本机页面 `http://localhost:8091/`。范围、预算计数边界、证据和仍阻断的正式案例见 [真实自动验证记录](dsh-workbench/docs/real-model-run-20261114.md)。原8090模拟预览保留，不能把两者混作完整产品上线。

最新续测：[待验证链路记录](dsh-workbench/docs/pending-chains-run-20261114.md)。真实文档旧版读取、确认与浏览器下载通过；原生提问/拒绝/等待时停止由真实DSH引擎＋协议夹具验证，不能等同真实模型全链路。续测1次400无usage，当前保留17,432 token预占并冻结新调用，历史和成果仍可使用。

统一 Worker v1 已完成派发、观察、提问、审批、停止、成果登记与恢复的同操作链路，提供签名私有 RPC、Worker 持久日志和默认关闭的服务开关。真实 DeepSeek / 原生 DSH 验证通过完整操作链及停止两例，共4次请求、9,153 token；旧17,432预占保留。详见 [统一 Worker 协议、启用与真实验证](dsh-workbench/docs/unified-worker-protocol.md)。当前仅受限工具验证，不等同通用代码 Worker、生产计费或多用户上线；现有只读实例不自动切换。

正式服务能力新增 **用户／项目／全局 token 预算、服务端模型网关、Docker 工具隔离和平台管理员核对入口**。三层原子预占，回执异常保留额度并冻结；旧实验账本可显式只读结转。正式 Worker 只使用内置隔离运行时，模型凭据不传浏览器或工具容器，命令仍需用户逐次批准。启用开关默认关闭，现有真实验证实例不自动切换，本轮无新增真实模型调用。配置、权限、迁移、管理员操作与边界见 [正式预算与隔离服务](dsh-workbench/docs/service-budget-isolation.md) 和 [使用手册](dsh-workbench/docs/manager-user-guide.md)。

服务器即时验收已完成：真实 DeepSeek 6 次请求、3636 token，问答交付、等待时 API 重启与控制通道断网恢复、三用户串行排队、隔离及备份还原通过。**24 小时观察中**，北京时间 2026-11-15 17:27:40 后且足量健康样本才可能通过；临时模型令牌已删除，模型准入暂停。域名 HTTPS 尚未准备好，保持私有、邀请关闭。部署与备份说明见 [服务器部署验收](deploy/service/README.md)，真实范围、证据与未覆盖场景见 [逐项验收记录](deploy/service/acceptance-status.md)。

独立产品新增与客户界面同风格的 **可视化服务控制台**：平台管理员可查看概览、七天用量、三层额度、任务队列与 Worker 状态，执行原有额度调整及用量/执行核对，并查看管理审计。普通用户无访问权限；不提供服务器命令或密钥编辑。当前实现及新版图文说明见 [开发者与运维手册](dsh-workbench/docs/manager-developer-guide.md)。本批仅本地虚构验证，没有切换服务器验收版本。

平台管理员现可在“服务管理 → 邀请码”可视化生成一次性邀请，选择独立/已有租户和有效期、复制本次明文并查看使用状态。沿用兑换开关，默认不自动开放注册；不自动分配模型额度或授予平台管理员。操作和限制见开发者手册的邀请码章节。本批仅本机虚构验证，服务器邀请保持关闭。
