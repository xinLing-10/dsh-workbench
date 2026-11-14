# 独立管家服务部署验收工具

与旧 DSH 插件容器部署分开使用。当前状态以 [验收记录](acceptance-status.md) 为准；这些文件不是服务器已上线的证明。

## 源码包

仓库根目录：

```sh
python3 deploy/service/release.py --output /tmp/manager-service-source.tar.gz
tar -tzf /tmp/manager-service-source.tar.gz
```

归档根目录是 `manager-service/`，带文件 SHA-256 清单。不要用旧 `deploy/release.py` 发布独立前端：旧入口只包含插件。源码包不包含 node_modules，运行所需依赖和 Node24 必须在独立发布目录或固定镜像中准备；不要在现有线上应用目录安装或覆盖依赖。

## 一致性备份和恢复演练

仅停止本次独立验收的 API、Worker 及工具容器，确认没有后台写入。`--quiesced` 是操作者对停机的断言；工具同时核对指定回环端口已停止，无法凭端口证明所有未知进程已消失，必须核对执行进程。不要关闭服务器原有应用。

数据布局：`control/product.sqlite`、`workspaces/`、`worker-journal/`。控制数据库含 Worker 身份等敏感配置，备份按私有数据管理，目录 0700、文件 0600；不上传 Git、公共对象存储或用户页面。模型秘密文件应独立管理，不在本工具的复制范围。

```sh
node deploy/service/backup.mjs snapshot \
  --root /srv/manager-acceptance/data \
  --destination /srv/manager-backups/acceptance-unique \
  --ports 8096,8094 --quiesced

node deploy/service/backup.mjs restore \
  --source /srv/manager-backups/acceptance-unique \
  --destination /srv/manager-restore-check-unique \
  --ports 8096,8094
```

目标必须不存在且父目录已存在；恢复不会覆盖原目录。先对克隆做只读完整性、成果和预算核对，不启用克隆的 Worker、模型网关或自动派发，避免恢复演练重复收费。按服务 UID 修正恢复目录所有权后，再由操作者决定真正恢复。该工具不含加密离机备份、自动保留清理或跨机灾备。

## 持续观察

以专用服务账户保存 0600 配置文件，示例：

```json
{
  "healthUrl":"http://127.0.0.1:8096/healthz",
  "workerUrl":"http://127.0.0.1:8094",
  "workerId":"wrk_acceptance_0",
  "db":"/srv/manager-acceptance/data/control/product.sqlite",
  "units":["manager-acceptance-api.service","manager-acceptance-worker.service"],
  "samples":"/srv/manager-acceptance/observation/samples.jsonl",
  "report":"/srv/manager-acceptance/observation/report.json",
  "hours":24,
  "intervalSec":60,
  "maxGapSec":180,
  "minFreeMb":100,
  "expectNoModelCalls":true,
  "removedCredential":"/srv/manager-acceptance/private/model-grant"
}
```

`sample` 只读探测，不请求模型；`report` 汇总，不补造采样。首次安装 timer 前手动采样并核对目录权限、SQLite/WAL 和 systemd 可读性。

```sh
node deploy/service/observe.mjs sample /srv/manager-acceptance/private/observe.json
node deploy/service/observe.mjs report /srv/manager-acceptance/private/observe.json
```

`observing` 表示样本或真实时长不足；`failed` 表示样本失败、超阈值断档或服务重启；只有完整时长和足量健康样本才返回 `passed`。这不是压测或全量故障监控替代品；少于一分钟的短暂故障仍可能漏采，需要结合服务日志。systemd 示例只用于新验收实例，不要直接覆盖其他服务。

验证：

```sh
node --test deploy/service/*.test.mjs
python3 deploy/service/test_release.py
```

## 本轮部署与验收边界

本轮 ECS 已安装独立私有实例，真实模型测试已结束，临时模型令牌已删除，模型准入暂停。24 小时观察从北京时间 2026-11-14 17:27 开始，尚未通过；域名 HTTPS 未备好，邀请不开放。实际服务、端口、预算和恢复范围见 [验收记录](acceptance-status.md)。

`bootstrap.mjs` 仅用于全新验收数据库和虚构账户，不适用于覆盖现有服务。`verify.mjs` 的真实模型阶段会产生费用，必须先有独立授权与固定请求编号，不得因脚本失败重置账本重跑。控制代理只用于本验收实例故障演练，不能对公网暴露。Worker 控制器需要可信 Docker 访问权，工具容器不接收该权限。
