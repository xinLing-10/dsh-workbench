# 服务器模型凭据配置与轮换

适用：独立管家正式网关；示例实例为 `/srv/manager-trial`，服务为 `manager-trial-api.service`。只供受信任的服务器运维人员操作。客户和工具容器不配置模型密钥。

## 当前使用哪类凭据

当前代码固定请求 `https://api.deepseek.com/anthropic/v1/messages`，使用 `x-dsh-auth-token` 认证头。凭据是 DSH 当前 DeepSeek 账户的授权令牌，**不是**随意粘贴的普通 API Key、整份 YAML/JSON、`Bearer ...` 字符串或 DSH 登录链接。文件内容为一行原始令牌；配置格式以 `services/product-api/src/budgeted-model.mjs` 和 `server.mjs` 为准。

服务器持有独立私有副本，本机凭据不被修改；当前实现没有账户授权自动刷新器。令牌失效时需要重新从受信任的账户授权流程取得新令牌并轮换。切换到其他厂商或普通 API Key 需要增加对应认证/协议适配并验收，不能只替换文件内容后声称兼容。

## 文件、权限与环境变量

- 模型文件：`/srv/manager-trial/private/model-grant`，仅 API 服务账号 `manager-trial` 可读，0600；父目录 0700。
- 配置文件：`/srv/manager-trial/private/api.env`，0600。
- Worker 只拿控制面签名身份，不读取此模型文件；工具 Docker 容器只挂当前项目工作区。
- 不把令牌写入 Git、页面、聊天、截图、命令行参数、日志或可下载的项目成果；也不要复制整个本机 `.dsh` 目录。

配置项（示例无真实秘密）：

```dotenv
PRODUCT_API_FORMAL_SERVICE=1
PRODUCT_API_WORKER_PROTOCOL=1
PRODUCT_API_MODEL=deepseek-flash
PRODUCT_API_MODEL_CREDENTIAL_FILE=/srv/manager-trial/private/model-grant
PRODUCT_API_MODEL_CALLS_PAUSED=1
```

`PRODUCT_API_MODEL_USER_AGENT` 保留与受支持账户客户端一致的归属信息，不包含模型令牌。改变模型名还需要同步受信任 Worker 配置和验收，不可只改 API 一端。

## 首次配置或轮换

1. 在控制台先检查活动任务、待回答操作、未结预占和未知用量。安排维护时段，先处理或保留原任务的明确状态；不能把重启当作取消/恢复的证明。
2. 由运维在私有 `api.env` 中将 `PRODUCT_API_MODEL_CALLS_PAUSED` 设为 `1`，重启**本试用 API**。暂停阻止新调用，不会清空账本；不要重启原验收实例。未知执行仍需核对。
3. 在加密 SSH 或 ECS 受控终端的 Bash 中，以 root 权限执行以下隐藏输入流程。输入的应是可信账户授权流程取得的新令牌，不是聊天里收到的任意文本。

```bash
umask 077
IFS= read -r -s -p '输入新的模型授权令牌（不回显）：' manager_trial_grant
printf '\n'
test -n "$manager_trial_grant" || exit 1
printf '%s\n' "$manager_trial_grant" > /srv/manager-trial/private/model-grant.next
unset manager_trial_grant
chown manager-trial:manager-trial /srv/manager-trial/private/model-grant.next
chmod 600 /srv/manager-trial/private/model-grant.next
mv /srv/manager-trial/private/model-grant.next /srv/manager-trial/private/model-grant
```

4. 只检查文件所有者、模式和是否非空，不输出文件内容：

```bash
stat -c '%U %G %a %n' /srv/manager-trial/private/model-grant
test -s /srv/manager-trial/private/model-grant
```

5. 确认用户/项目/全局额度、独立硬上限、Worker 隔离与网络就绪。将暂停设为 `0`，重启本 API，再以小范围、明确有额度的任务验证完整模型回执。不自动批准命令；不要用无限循环反复测试。
6. 如出现 401、断流或缺失用量，保留预占与凭证，先暂停并核对；更换令牌不代表原请求免费或已经结算，不能删除调用记录重来。

当前 API 会逐次重新读取模型文件；这里仍采用维护时段、原子替换及重启核对，避免把活动执行与轮换混在一起。新凭据是否实际可用，需要有界的真实调用验证，单纯“文件存在”和健康检查不等于模型授权已被服务商接受。

## 试用结束与撤销

先暂停模型准入、关闭邀请兑换并处理活动执行，记录最后的已用、未结和未知预占；确认不会再有合法调用后删除此实例的模型副本。删除本地副本不等于撤销服务商授权；如怀疑泄露，还需在账户侧撤销/轮换。不要删除本机原授权、其他应用的模型文件或历史预算账本。

当前试用已获追加授权供五位定向受邀者共享累计 50,000,000 token 总预算（含既有消费；个人/项目仍各5,000,000），另有 1,000 次请求保护上限；旧 200,000 token 实验与未知预占保留在原账本，不重置、不挪作余额。额度耗尽时服务拒绝新增调用，不会自动购买额度或切换账户。

## 最新预算和授权范围（2026-11-14追加）

用户已将本试用的模型使用范围扩展到五位指定受邀者，总额提升为**累计50,000,000 token，包含已消费部分**。个人与项目策略仍各5,000,000 token，累计1,000次请求保护不变。只追加预算授权与调整全局策略，不重新复制模型文件、不改本机凭据或旧账本；原200,000实验及17,432未知预占仍保留在独立原账本中。此前记录的500万为初始预算，不能把追加视作清零后重新赠送5000万。
