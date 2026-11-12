# DSH Workbench · 产品开发工作台

面向 DeepSeek Harness（DSH）的产品开发插件，将需求分析、详细设计、编码实现、测试验收和交付组织在同一个工作台中。

当前开发分支：**personal_manager / v1.7.0**。默认通过项目管家统一沟通，支持需求文档、实施方案及完整软件三类交付目标。包含后台任务调度、文档版本确认、知识与上下文追溯、确认快照 ZIP 交付。原五阶段界面保留为详细工作区。主分支 v1.6.0 基线保持不变。

[项目管家使用与实现说明](dsh-workbench/docs/personal-manager.md)；升级后需重启 DSH Host 并刷新页面。

![工作台知识视图](dsh-workbench/docs/screenshot-knowledge.png)

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

## 验证

```sh
cd dsh-workbench
npm run check
npm test
```

当前包含 79 项自动化测试。界面截图来自开发验证；测试不等于所有模型、部署方式及多人场景均已验证。

## 数据与使用范围

项目文档、确认记录和上下文清单存储在项目的 `.dsh/workbench/` 中；DSH 自身配置、会话和凭据由 DSH 管理。运行数据、密钥及本地备份不应提交到仓库。

当前面向个人或可信环境使用，尚未实现面向公共服务的多租户权限与执行隔离。Agent 可以读写工作文件并执行命令，请使用合适的权限和独立工作环境。

若开始任务时提示后端接口未就绪，需重启 DSH Host；仅刷新前端不能加载新增的 Host 路由。
