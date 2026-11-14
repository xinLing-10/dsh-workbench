# 共享管家内核公共入口

在仓库中从 `index.mjs` 导入 createProjectServices、createProjectState 和各业务服务。唯一源码在 `dsh-workbench/core/`，随插件一起打包；这里不维护副本。

设计、数据归属、注入端口、安全边界与测试见 [共享管家内核设计](../../dsh-workbench/docs/shared-manager-core.md)。运行前安装 dsh-workbench 的锁定生产依赖；不要单独复制本目录后当作可发布的独立 npm 包。
