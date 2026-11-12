# 简洁模式实施续接记录

用户授权：按 manager-simple-mode-plan.md 的三个批次实施，每批同步更新使用手册。2026-11-13。

状态：进行中。当前执行者为本聊天；自动续接附着本聊天，每 30 分钟检查（自动化 ID：automation），全部完成后停用。不要并发启动第二个执行者。

仓库：`/Users/xinlin/Documents/xinlin/work/DSH_DEVELOPMENT`，分支 `personal_manager`，开始提交 `e69e514`。

安全工作副本：`/private/tmp/dsh-simple-implementation/dsh-workbench`；实际文件基线：`/private/tmp/dsh-simple-implementation/baseline.json`。原目录位于当前可写根目录以外，写入、git 提交需要工具的沙箱升级。同步前校验基线哈希，不覆盖并发改动。

- [x] 第一批：服务端 presentation 派生、简洁首页、当前动作卡、模式切换、当前问题与运行/恢复提示；测试、截图、手册、独立提交。
- [ ] 第二批：完整成果阅读与明确确认、修改、直接下载、折叠高级导出、手册入口；测试、截图、手册、独立提交。
- [ ] 第三批：两步首次引导、明确交付范围、窄屏/无障碍/任务旅程验证，完成后再决定默认入口；测试、截图、手册、独立提交。

当前下一步：第一批已实现并经 157 项测试及隔离浏览器验证，完成手册与截图更新，提交后进入第二批：独立成果阅读、明确确认、常用下载、高级导出折叠和安全手册入口。

每批完成后更新本文件、主手册 manager-user-guide.md、离线 HTML、受影响截图与方案状态。三批独立提交，未经新的用户要求不推送、不部署；保留原有未提交的 .dockerignore 与 deploy/。

无真实待授权稳定信号时不伪造 waiting_permission；继续提供原生授权详情入口。所有状态派生不得放宽 dispatch、approve、哈希确认或插件保护校验。第三批中的真实普通用户试用不能伪造，未招募时如实记录为待用户试用。
