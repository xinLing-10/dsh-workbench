# 阿里云 ECS 部署指南

适用：工作台 1.18.0 / `personal_manager`、DSH `0.2.1-rc.2`、Node `24.19.0`。核对日期：2026-11-13。本文示例地址不代表服务已上线，实际状态需按末尾验收。

## 1. 部署范围与资源

推荐先运行一个 `owner` 实例：浏览器 → HTTPS / Nginx → 服务器 `127.0.0.1:3081` → DSH 容器。验证后再手动邀请可信用户，每位用户独立 Compose 项目、网络、home / workspace 持久卷、原生认证、子域名和模型配置。

本次控制台确认的服务器为上海、Ubuntu 22.04 64 位、2 vCPU / 2 GiB、40 GiB 磁盘、3 Mbps 公网带宽。先只启一个实例，多实例容量需实测。容器不是陌生用户任意代码的强沙箱；当前没有自助注册、统一登录、计费、模型消费上限或强制磁盘配额。

上海属于中国内地，网站对外服务前需完成 ICP 备案，域名实名认证不等于备案。等待期间可私下验证本机服务。[阿里云建站说明](https://help.aliyun.com/zh/ecs/user-guide/build-a-website/)

## 2. 上线前预检

确认已有网站、容器、端口和剩余资源，不重装系统，不停无关服务。`dsh-ecs` 是管理员已配置的 SSH 别名，下面命令按组单独执行：

```sh
ssh dsh-ecs 'uname -m'
ssh dsh-ecs 'free -m'
ssh dsh-ecs 'df -h /'
ssh dsh-ecs 'ss -ltn'
ssh dsh-ecs 'docker version'
ssh dsh-ecs 'docker compose version'
```

缺运行时时按 [Docker 官方 Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/) 安装 Engine / Compose；不要为此卸载正在使用的运行时或清理数据。选择专用子域名，例如 `workbench.example.com`，核对既有 A / AAAA / CNAME，避免影响官网和邮箱。

域名、备案和有效证书要分别核对。需要新增安全组规则时明确来源与端口；不开放应用 3080 / 3081 或 Docker 管理端口。SSH 保持现有受限来源。

## 3. 在本机准备源码包和镜像

在仓库根目录执行。2GB 服务器优先导入本机镜像，避免在服务机上争用构建内存。

```sh
python3 deploy/release.py --output /tmp/dsh-workbench-1.18.0-source.tar.gz
tar -tzf /tmp/dsh-workbench-1.18.0-source.tar.gz
docker build --platform linux/amd64 -f deploy/Dockerfile -t dsh-workbench:1.18.0-ad9c578 .
docker image inspect dsh-workbench:1.18.0-ad9c578 --format '{{.Architecture}} {{.Id}}'
docker save dsh-workbench:1.18.0-ad9c578 | gzip > /tmp/dsh-workbench-1.18.0-image.tar.gz
scp /tmp/dsh-workbench-1.18.0-source.tar.gz dsh-ecs:/tmp/
scp /tmp/dsh-workbench-1.18.0-image.tar.gz dsh-ecs:/tmp/
```

`ad9c578` 标识工作台功能来源；部署文件与镜像一起保存。以后换为新发布标签并保留旧镜像。若服务器是 `aarch64`，改用 `linux/arm64` 重新构建。源码包带 SHA-256 清单，排除依赖、凭据与运行数据；不上传本地 `.dsh` 或整个业务目录。

镜像含中文字体，支持 PDF 内容版；复杂 Word 转 PDF 的版式保真仍依赖另装 LibreOffice，2GB 主机默认不安装。首次启动仍需访问 npm 安装 Web profile 依赖，可能耗时数分钟。源码包和镜像包不能互相替代。

在服务器执行，确认新版本目录未占用；已有目录不要直接覆盖：

```sh
sudo install -d -m 755 /srv/dsh-releases/1.18.0
sudo tar -xzf /tmp/dsh-workbench-1.18.0-source.tar.gz -C /srv/dsh-releases/1.18.0
sudo docker load -i /tmp/dsh-workbench-1.18.0-image.tar.gz
cd /srv/dsh-releases/1.18.0/dsh-workbench
```

## 4. 先启动私有实例

```sh
sudo python3 deploy/instance.py create owner --port 3081 --image dsh-workbench:1.18.0-ad9c578
sudo python3 deploy/instance.py up owner
sudo python3 deploy/instance.py status owner
curl -I http://127.0.0.1:3081/
```

仅映射服务器回环地址。未登录返回 `401` 是正常认证行为，但不能据此认定插件和模型已经可用。健康检查只检查 HTTP 监听，首次启动宽限 10 分钟；超时查日志，不会自动修复。默认每实例 1 CPU、1GB 内存、256 个进程、512MB 临时空间；重型构建可能超限。

镜像根目录只读，以 UID 1000 运行，不挂载宿主机目录或 Docker socket。工作台依赖在构建时安装，原生扩展缓存位于独立 home 卷，保留 `/tmp` 不可执行。模型凭据由管理员或用户在独立实例设置中输入，不复制电脑上的 home 卷和历史会话。

本机建立隧道：

```sh
ssh -N -L 127.0.0.1:3081:127.0.0.1:3081 dsh-ecs
```

管理员在受控终端查看实例日志的原生启动链接，使用安全连接登录；容器地址对应到隧道时，使用 `http://127.0.0.1:3081/`，保留原生认证要求。启动链接和日志包含认证信息，不贴到公开聊天或截图，不通过关闭认证解决登录问题。

隧道只供建立连接的电脑使用，`localhost` 不是公网入口。隧道断开或电脑重启后，用自己的 SSH 登录方式重新连接；撤销临时公钥不会终止已经建立的 SSH 连接。浏览器首次登录仍需原生认证，之后可在左下角更多菜单 → 设置 → 模型中自行填写 API 密钥，不在聊天或文档中传递密钥。

本次真实 ECS 的私有验证结果见 [部署验证记录](preparation-status.md)：实例、认证、插件接口、文档生成及重启持久化已验证，真实模型任务和公网 HTTPS 尚未验收。

工作目录使用 `/workspace` 或其子目录。服务器文件选择器不能读取浏览器所在电脑的文件；现有项目需由管理员安全上传或从 Git 导入，自助上传暂未实现。

## 5. 域名与 HTTPS

1. 域名、备案、私有实例验收完成后，准备专用子域名的 A 记录，指向 ECS 公网 IP；先核对既有记录，不覆盖其他服务。
2. 使用已签发的阿里云证书，或通过证书提供方的 DNS-01 / HTTP-01 流程申请。DNS-01 需要 TXT；HTTP-01 需要解析、80 端口和挑战路径。证书签发和自动续期分别验证，不把私钥或 DNS 凭据放进仓库。
3. 复制 `deploy/nginx.conf.example` 到独立站点配置，替换 `USER_HOSTNAME`、`INSTANCE_PORT` 和实际证书路径。模板采用 Let's Encrypt 路径格式，阿里云证书必须改成安装路径。不要覆盖已有站点。
4. 新建实例时可带 `--url https://workbench.example.com/`。已经启动私有实例时，先备份它的 `compose.json`，仅修改 `environment.WORKBENCH_PUBLIC_URL`，保留项目名、卷与限制，再 `up owner` 重建容器。不要删除卷或复制 home。
5. `sudo nginx -t` 通过后再 `sudo systemctl reload nginx`。服务器公网只需 TCP 443；HTTP 验证或跳转另外准备 80。新增云安全组和防火墙规则前确认具体来源、端口及是否影响已有站点。
6. 公网核对 DNS、证书链及域名、未登录拒绝访问、登录 Cookie、WebSocket、文档下载和手册。全部通过后才交付邀请用户。

Nginx 关闭访问日志以避免记录启动查询凭据，保留 Host 并转发 WebSocket。`public-url` / `trusted-host` 不替代认证，不能关闭认证后仅依靠隐藏域名保护服务。

```sh
dig +short workbench.example.com A
sudo nginx -t
curl -I http://127.0.0.1:3081/
curl -I https://workbench.example.com/
```

不使用 `curl -k` 绕过证书错误。脚本不会自动修改阿里云 DNS、安全组、账户权限或证书。

## 6. 邀请用户与撤销

资源和模型预算允许后，再为第二位用户准备独立子域名、代理和实例：

```sh
sudo python3 deploy/instance.py create alice --port 3082 --image dsh-workbench:1.18.0-ad9c578 --url https://alice.example.com/
sudo python3 deploy/instance.py up alice
sudo python3 deploy/instance.py status alice
```

每人独立认证链接和模型配置，不复制 owner 的 home。用虚构数据验证第二实例无法读取第一实例的会话、工作文件和确认记录。撤销邀请时停止实例并移除专属代理；仅删除配置或重启不保证旧 Cookie 失效。脚本不永久删卷。

## 7. 备份、升级和回滚

```sh
sudo python3 deploy/instance.py status owner
sudo python3 deploy/instance.py logs owner
sudo python3 deploy/instance.py stop owner
```

日志仅在受控终端查看。一致性备份先停止实例，同时备份 `dsh-owner_home`、`dsh-owner_workspace` 和 `/srv/dsh-instances/owner/compose.json`。home 包含凭据与会话，workspace 包含项目、确认快照与文档包。备份加密离机保存，下载 ZIP 不是全量备份。恢复保持 UID 1000 和 `/workspace` 路径。

升级前记录旧镜像 ID，保留旧镜像与配置。停止备份后修改 Compose 的 image，`up` 后重新验收。回滚镜像不会撤销业务文件和数据迁移，必要时成对恢复两个卷。不要用 `docker compose down -v` 或 `docker system prune --volumes` 排障。

## 8. 检查与常见故障

```sh
python3 -B -m unittest discover -s deploy -p 'test_*.py'
sh -n deploy/entrypoint.sh
node --check deploy/healthcheck.mjs
```

| 现象 | 先检查 |
| --- | --- |
| 端口占用 / EADDRINUSE | `ss -ltn` 查监听者，换端口，不盲目杀进程 |
| 初始化长时间无进展 | npm 网络、磁盘、首次 profile 安装及容器日志 |
| 未登录 401 | 正常认证；使用原生登录流程 |
| 公网超时 | DNS、安全组、防火墙、HTTP / HTTPS 是否一致 |
| 502 | 上游容器、端口和首次启动是否完成 |
| 管家不可用 | 三个 bundle、Host 路由、模型配置及模型网络 |
| WebSocket 断开 | Host / trusted-host、Upgrade、代理超时和认证 |
| PDF 缺字 | 字体与实际 PDF 生成路径 |
| OOM | 主机可用内存与容器上限，不直接移除全部限制 |

上线验收顺序：进程与端口 → 原生认证 → 三个插件及管家 → 真实模型小任务 → 文档审阅、确认、下载 → 停启恢复 → HTTPS / WebSocket → 用户实例分离。配置测试、镜像构建和健康检查不能替代完整验收。
