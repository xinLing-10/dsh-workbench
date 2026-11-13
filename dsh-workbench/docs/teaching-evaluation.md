# 教学质量评测：使用与边界

适用版本 1.24.0。本工具供维护者使用，不出现在普通用户学习流程中。12 个案例包括零基础解释、项目来源、缺设计记录、误区反馈、证据不足、分级提示、完整示例、真实维护代码理解、资料注入、简化解释、迁移和自评边界。

## 导出模型输入

```sh
cd dsh-workbench
npm run eval:teaching -- --export-prompts /tmp/dsh-teaching-inputs.json
```

输入包含虚构案例与公开维护代码片段，以及按当前教学协议构建的 modelPrompt。工具不会读取模型配置或调用服务。用你准备验证的模型逐个回答，保存为 JSON 对象，键为案例 ID，值为模型的原始回复字符串；同一组案例可用于比较修改前后版本。不要把实际用户隐私或凭据加入公开评测集。

## 检查已有回复

```sh
npm run eval:teaching -- --responses /tmp/dsh-teaching-responses.json --output /tmp/dsh-teaching-report.json
```

默认案例在 docs/teaching-eval-cases.json，可用 --fixtures 指定另一个案例文件。输出文件采用独占创建，不覆盖已有报告；重复运行时使用新文件名。

报告状态：missing-response 表示未提供回复；invalid-response 表示协议无效；needs-attention 表示发现需检查的引用、原话或风险信号；ready-for-human-review 表示可进入人工审阅，**不表示教学通过**。有缺失、协议问题或风险信号时退出码为 2。仅准备案例时退出码为 0，也不代表通过。

## 人工审阅和实际学习

报告保留案例、回复、自动检查结果和五项待填评分：事实依据、零基础适配、提示质量、误区反馈、迁移与复习。逐句对照来源，观察模型是否把引用范围正确误当成结论正确；确认用户索要完整示例时得到帮助，资料不足时承认缺口。不能以段落长度或关键词命中代替教学正确性。

真实效果还需零基础用户试学：比较学习前后能否解释同一功能，用另一个功能做迁移，过一段时间再回顾。软件测试、模拟模型旅程、LLM 自评均不能代替这些结果。报告始终包含 modelCalls: 0、learningOutcomeValidated: false；本次实现没有运行真实模型实验。
