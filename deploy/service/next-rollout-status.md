# Next.js 试用入口灰度切换记录

日期：2026-11-15，Asia/Shanghai。**默认入口已切换**：https://8.153.164.227/ 。切换时间 UTC08:50:25（北京时间16:50:25）。仅操作独立 /srv/manager-trial；未推送 Git，未操作其他原应用或 /srv/manager-acceptance。

## 实际部署

- API源码 /srv/manager-trial/releases/next-stream-20261115，经 current 原子链接启用；复制既有版本再应用5文件流式补丁，没有数据库迁移。
- Next /srv/manager-trial/next-releases/20261115-ready，经 next-current 链接启用；单位 manager-trial-next.service，回环8120，256MiB/50% CPU；Linux实际启动、页面路由与公网Chrome验证通过。
- 页面和Next静态资源交给新进程；/api/v1（包括SSE）、/help、/healthz直接代理原API8110，保留Cookie/CSRF、权限与Worker协议。内部路径公网返回404。
- Nginx先按浏览器Cookie灰度验证，再切换默认。/_manager/legacy 可选旧页面；/_manager/next 返回新版，选择Cookie不具有认证权限。
- API切换前临时暂停POST，确认活动执行0、排队0、未结模型0，停止API后备份至 private/before-next-stream-20261115.sqlite。Worker不重启，历史uncertain记录不删除。
- 切换前后16条模型记录摘要相同：da8ec450fc9c35d17856f8bdf0f10cd8d9f50ca9554d63ac675fd60ef8233f85。五位用户原账号、额度、凭据、邀请与证书续期配置保持；新增验收账号额度为0，已禁用并撤销其会话。

## 产物与预算证据

- 首个灰度Next包SHA256：3f5e3aaea43493eebf00b80788981586e5b6e9c85df80ba6c605d289a47d476b。
- 最终Next包SHA256：193bc6acefeea2477456afa8943b6e28eed8d99e93cf29133c1e9de831150462；1274文件清单核验。
- 流式API补丁SHA256：38bbc4af7a40504b5d3fc6ff288308ebbcfdf5f7f24e967df5d98a9b266d0f14；5文件清单核验。不是把旧源码提交号冒充新版本。
- 用户额外授权最多2次/10,000 token，计入原200,000总测试上限；独立私有账本 private/next-stream-real-20261115/control.sqlite，不占五位用户账号或50m试用账本。现有服务器模型授权仅在网关解析，未复制、导出或修改。
- 实际真实调用1次、157 token，held=0、unknown=0，无工具定义/执行。旧承诺44,892（含17,432未知预占）保留，累计承诺 **45,049 / 200,000**。脚本根目录已存在时拒绝重跑，不自动补做第二次。
- 真实文本链路：API→签名Worker→模型网关→5条持久预览→SSE→最终Worker回执→成果SHA校验；验收开始后1121ms见首段、2001ms见最终回执，属于单次观测，不是时延承诺。
- 此真实探针使用明确的无工具文本执行器，Docker配置仅核对就绪；不冒充本次验证了模型自主工具循环、容器命令、审批、多人负载或活动崩溃恢复。已有工具/问答离线回归另外保留。
- 脱敏证据见 dsh-workbench/docs/next-stream-verification.json；原始账本、Worker日志、模型文本只在服务器私有目录，不入Git。

## 完成的验证

- Next类型、生产构建、客户端4项；API/Worker/共享契约168项中166通过、2项Docker条件测试跳过。
- 最终本地Chrome28项完整流程、流式4项（含登录）、公网灰度6项、默认入口6项；0未捕获浏览器异常。模拟与真实证据分开。
- 公网测试只访问0额度虚构账号，验证登录、建项目、SSE、管理员403、同源新版帮助；未发送客户模型任务。测试账号随后禁用，会话全部撤销。
- 客户/管理员Markdown、离线HTML及受影响截图同步。服务器 /help 使用新手册。
- 未将原私有24小时空闲观察算作本次负载验收；该观察尚由独立自动化按真实时间和样本判断，不因本次发布提前宣布通过。

## 回退与后续维护

1. 单个浏览器先打开 https://8.153.164.227/_manager/legacy ，页面回到旧版；不会回滚或重发任务。
2. 默认页面回退：恢复 private/nginx.before-next-default-20261115.conf 到独立站点文件，nginx -t 后 reload；已选择新版的浏览器仍需选旧版。若需所有网页完全回到原路由，恢复 private/nginx.before-next-20261115.conf，再验证原站点。不要改证书/安全组或其他站点。
3. API回退须先核对活动任务和在途用量，暂停新写入、保留证据，停止本试用API，将current指回 releases/budget-50m-20261114 再启动；数据库保持当前内容，不用旧备份覆盖新增数据，不清预占、不伪造终态。
4. 核对 systemctl status manager-trial-next manager-trial-api、journalctl -u manager-trial-next、HTTPS /healthz。逐层检查8120页面、8110 API、Nginx和公网。不要把Next重启当作Worker恢复。
5. 当前无next/image需求，images.unoptimized=true；本机JS运行包排除了Darwin原生图片库，并已在Linux启动。后续新增图片优化/原生依赖，应在Linux CI构建，不可盲用跨平台裁剪。
6. 临时SSH公钥归属仍在进行的24小时私有验收，由该自动化按原流程撤销；不是长期运维凭据。试用模型授权保留，不随验收实例的清理删除。
