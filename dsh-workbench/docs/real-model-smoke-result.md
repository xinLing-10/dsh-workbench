# 真实 DeepSeek 账号通道烟测记录

日期：2026-11-14。范围：**engine-only，单次无工具模型请求**。用户已明确授权使用当前 DeepSeek 服务，最多一次请求、最多输出 1,000 token。

## 实际结果

| 项目 | 结果 |
| --- | --- |
| 状态 | 通道基础烟测通过 |
| 当前提供方 | deepseek-account，沿用本机 DSH 已登录的官方账号 |
| 官方端点 | https://api.deepseek.com/anthropic/v1/messages |
| 请求模型 / 返回模型 | deepseek-flash / deepseek-flash |
| 实际请求次数 / 自动重试 | 1 / 0 |
| 输入 / 输出 token | 24 / 7 |
| 工具执行 | 0，未向模型提供工具，未执行返回的工具块 |
| 请求输出上限 | 1,000 token，thinking disabled，仅对本次请求生效 |
| 供应商消息 ID | d7e624e9-880b-4419-9ed5-0ab1cb1b6191 |
| 上游请求头 ID | 未提供；不自造 |
| 本地烟测 ID | 0305ee7c-7a27-4ee8-bccf-795bfee2e9be |
| 金额 | 未计算，不能将其解释为零费用 |

固定输入：

> 请只回复：已收到个人博客真实模型测试。不要执行工具，不要生成文件。

真实返回：

> 已收到个人博客真实模型测试

## 真实性与范围

本次真实 HTTP 请求只发送上面的短文本；未发送代码、文档、工作区、环境变量或其他用户资料。账号凭据只在服务端进程内存用于当前官方端点，没有写入请求报告、项目或浏览器。

原始脱敏证据保存在被 gitignore 排除的 control-data/real-smoke-8DsDdj/result.json。attempt.lock 在首次尝试前以排他方式创建，同一运行目录不能再次调用。没有修改原 DSH 配置或模型凭据。

这不是完整 DSH Agent/独立产品端到端验收：未创建产品 operation、DSH 会话或工具任务，也尚无统一模型网关。正式 RM-01 中产品链路关联项仍待完成，其余正式案例未执行。现有 8090 页面保持模拟模式，未开放真实模型自由聊天。

## 可用的烟测代码

- services/product-api/src/real-model-smoke.mjs：固定端点、一次性锁、1000 token、无工具、无重试、脱敏证据。
- services/product-api/probes/run-real-model-smoke.mjs：读取当前官方账号与默认模型，不支持转发到自定义端点。
- tests/real-model-smoke.test.mjs：离线测试不会调用模型，输出标记为 injected-test，不能当成真实证据。

已有目录的执行授权已经用完。不要删除锁文件、换目录自动重试或在未获新的调用授权时再次执行。未来全面接入仍需真实执行适配、停止/恢复、费用门槛和隔离验收。
