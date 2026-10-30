# HCode 远程操控：服务器部署与验收指南

本指南供服务器管理员与 Mac 使用者共同完成首次部署、验收和维护。对应[远程操控 v1 方案](HCode-远程操控-v1-方案.md)，2026-10-29 按仓库版本 `0.19.32` 核对。文中的命令是待部署模板，本仓库未在接收方服务器执行这些命令；交付状态由第 10 节记录。

## 1. 安装结果与适用范围

```text
手机浏览器 → HTTPS → Linux 服务器 nginx → SSH 反向隧道 → Mac 上的 HCode
```

- Linux 服务器只提供 nginx、证书与 SSH 中转，不需要安装 HCode、Node、pnpm 或 AI CLI。
- HCode、CLI 登录、代码、附件与任务仍属于 Mac 用户；Mac 必须开机、登录、运行 HCode 并保持唤醒。锁屏与休眠不同，合盖后不能假定仍可用。
- 默认是一个可信使用者远程控制自己的 Mac。没有按账号、设备或项目隔离；多个浏览器共用同一权限。服务器管理员可接触 HTTPS 解密后的口令、对话和附件，须在启用前接受此信任边界。
- 当前能力包括远程添加/创建项目目录、受限文件预览、Git 分支及提交切换、处理审批和选择完全放行。项目列表可由远程扩展；Agent 可能按权限访问其他数据或执行命令。禁止终端接口不等于禁止远程命令执行。
- 需要 Linux 服务器直接执行 AI 任务、多租户隔离或浏览器到 Mac 的端到端加密时，应另立方案。

主路径以 **Ubuntu Server 24.04 LTS、systemd、发行版 OpenSSH、宿主机 nginx** 为操作基准。另提供已有 Docker nginx 的接入路径。其他发行版、面板托管代理、rootless Docker、host 网络或其他代理须由管理员调整服务名、网络与配置路径，不直接套用 Docker 网桥配置。

## 2. 部署前填参数与确认责任

所有 `<…>` 必须替换后才能执行；不要把带尖括号的模板直接粘贴到终端。真实参数、指纹和验收记录保存在接收方私有部署记录，不提交公开仓库。`127.0.0.1`、80/443 等标准协议值不是部署实例信息。

| 参数 | 含义及约束 | 保存位置 |
|---|---|---|
| `<域名>` | 建议独立子域名；手机须能解析，证书须覆盖它 | DNS、nginx |
| `<服务器地址>` / `<SSH端口>` | Mac 可达的 SSH 入口，不要求一定是默认端口 | Mac SSH 配置 |
| `<隧道用户>` | 此次专用、未被占用的 Linux 用户名，无 sudo 权限 | 服务器、Mac SSH 配置 |
| `<SSH别名>` | 字母或数字开头，仅含字母、数字、点、下划线、短横线 | Mac SSH 配置、HCode |
| `<私钥绝对路径>` | Mac 上专用密钥路径，不覆盖现有文件，不上传服务器 | 仅 Mac |
| `<监听地址>` | 宿主机 nginx 用 `127.0.0.1`；Docker 用所选网桥的宿主机 IPv4 网关 | sshd、公钥限制、nginx、HCode |
| `<隧道端口>` | 未被占用的非特权端口，1024–65535，不对公网开放 | 同上四处 |
| `<本地端口>` | HCode 设置显示的实际端口，默认随机；不要与隧道端口混淆 | 仅 Mac，手工排错时用 |
| `<nginx容器>` / `<Docker网络>` | 仅 Docker 路径；管理员选择实际代理及其网络 | 服务器 |
| `<证书邮箱>` | 证书账户联系人邮箱；续期以自动化检查为准 | 证书管理器 |
| `<证书名称>` | `certbot certificates` 显示的实际名称，可能不同于域名 | nginx、续期检查 |

服务器管理员负责 SSH 用户、公钥安装、主机密钥指纹、网络限制、DNS/TLS、nginx、重启恢复及撤销。Mac 使用者负责专用私钥、CLI 登录、HCode 设置、保持唤醒、口令保管及真实手机操作验收。通知订阅是可选项，首次部署保持关闭。

开始前检查：

```bash
# 服务器；确认 SSH 服务及入口，不关闭现有管理连接。
cat /etc/os-release
sudo /usr/sbin/sshd -t
sudo systemctl status ssh --no-pager
sudo ss -lntp
```

确认云安全组和宿主机防火墙允许现有 SSH 管理入口及 HTTP/HTTPS。不要直接执行全局防火墙重置或启用一套覆盖现有服务的规则；不要开放 `<隧道端口>`。检查域名 A 记录；若发布 AAAA，还必须同时验证 IPv6 的路由、nginx 监听和防火墙，否则先不发布 AAAA。

变更前备份 `/etc/ssh/sshd_config`、相关 drop-in、目标 nginx 站点、Docker Compose/挂载设置及当前防火墙规则到管理员指定的私有目录，并记录恢复位置。只新增本功能所需配置，不替换其他站点。保持原管理连接，在新终端确认仍能管理员登录后再结束旧连接。

## 3. 选择 nginx 所在位置

### A. 宿主机 nginx（空服务器优先选此路径）

先确认 80/443 没有被其他代理占用。空服务器可安装：

```bash
sudo apt-get update
sudo apt-get install nginx openssh-server certbot curl ca-certificates
sudo systemctl enable --now nginx
sudo install -d -m 755 /var/www/hcode-acme/.well-known/acme-challenge
```

`<监听地址>` 固定为 `127.0.0.1`。站点可放 `/etc/nginx/conf.d/hcode-remote.conf`，先确认该路径不存在，且主配置在 `http` 块内包含 `conf.d/*.conf`。已有同域名站点时，在原站点合并配置，不能再建一个冲突的 `server_name`。

校验/重载均在宿主机执行：

```bash
sudo nginx -t
# 仅上一步通过后执行。
sudo systemctl reload nginx
```

### B. 已有 Docker nginx

本路径复用已有 Docker Engine、Compose 和 nginx 容器，不另启一个抢占 80/443 的 nginx。先查实际网络与挂载：

```bash
sudo docker inspect '<nginx容器>' --format '{{json .NetworkSettings.Networks}}'
sudo docker network inspect '<Docker网络>' --format '{{json .IPAM.Config}}'
sudo docker inspect '<nginx容器>' --format '{{json .Mounts}}'
sudo docker inspect '<nginx容器>' --format '{{json .HostConfig.RestartPolicy}}'
```

选择 nginx 实际连接的用户自定义 bridge，取其 IPv4 `Gateway` 作为 `<监听地址>`，记录 nginx 容器在该网络内的 IPv4 地址。不能把容器内 `127.0.0.1` 当作宿主机；不能套用网上的固定网关。隧道端口由宿主机 sshd 监听，无需 Docker `ports` 映射。网桥必须在隧道连接时存在。

站点配置写入实际挂载的 `conf.d` 目录。新增证书方案可在原 Compose 中合并以下只读目录挂载，保留原有挂载及服务：

```yaml
volumes:
  - /var/www/hcode-acme:/var/www/hcode-acme:ro
  - /etc/letsencrypt:/etc/letsencrypt:ro
```

必须挂载整个证书目录，`live` 内的文件会链接到 `archive`。宿主机安装 Certbot 并创建 ACME 目录；此路径不要安装/启动宿主机 nginx。挂载或重启策略变更需按原 Compose 项目重建目标服务，单纯 reload 不会更新挂载。nginx 容器应有适当的重启策略，并确保 Docker 随系统启动。

配置文件如被单文件 bind mount，修改及回滚须原地写入，保留 inode，或按原部署流程重建容器。采用“临时文件改名替换”的编辑方式后，必须确认容器读到了新文件。

校验/重载命令改为：

```bash
sudo docker exec '<nginx容器>' nginx -t
# 仅上一步通过后执行。
sudo docker exec '<nginx容器>' nginx -s reload
```

宿主机网桥地址不是访问控制。管理员须在宿主机防火墙的 **INPUT 路径**限制该地址/端口，允许实际 nginx 来源和确有需要的本机通知订阅来源，拒绝其他来源；只设 Docker 转发链规则不足以保护宿主机 sshd 的监听。使用现有防火墙管理方式，记录规则、顺序、持久化及回滚办法。若按容器 IP 放行，需在原网络中固定该 IP，或在容器地址变化后同步规则并重新验收。网络迁移时还要同步四处监听地址。无法落实这些限制时，先使用 A 路径。

## 4. 创建专用密钥和受限隧道用户

### 4.1 Mac：生成密钥

```bash
install -d -m 700 ~/.ssh
ssh-keygen -t ed25519 -f '<私钥绝对路径>' -C 'hcode-remote-tunnel'
chmod 600 '<私钥绝对路径>'
```

选择全新路径，已有文件不要覆盖。只把生成的 `.pub` 公钥通过可信渠道交给服务器管理员。密钥若有口令，需先加入 HCode 实际能访问的 ssh-agent；可用 `ssh-add '<私钥绝对路径>'` 加载。HCode 使用 `BatchMode=yes`，不会弹出私钥解锁提示；终端可用不代表从 Finder 启动的 HCode 一定可访问同一个 agent，必须在第 7 节验证。不要复用 root 或其他业务密钥。

### 4.2 服务器：安装公钥

先用 `getent passwd '<隧道用户>'` 确认是新用户；若已存在，先核对归属，不修改其他用户：

```bash
sudo useradd --create-home --shell /usr/sbin/nologin '<隧道用户>'
sudo install -d -m 700 -o '<隧道用户>' -g '<隧道用户>' '/home/<隧道用户>/.ssh'
```

新建 `/home/<隧道用户>/.ssh/authorized_keys`，一行写入以下内容，替换公钥主体及参数，不换行拆分公钥：

```text
restrict,port-forwarding,permitlisten="<监听地址>:<隧道端口>" ssh-ed25519 <公钥主体> hcode-remote-tunnel
```

```bash
sudo chown '<隧道用户>:<隧道用户>' '/home/<隧道用户>/.ssh/authorized_keys'
sudo chmod 600 '/home/<隧道用户>/.ssh/authorized_keys'
```

### 4.3 服务器：限制 sshd

Ubuntu 基准配置确认 `/etc/ssh/sshd_config` 包含 `sshd_config.d/*.conf` 后，新建 `/etc/ssh/sshd_config.d/hcode-remote.conf`；无 Include 时由管理员在主配置中合并。检查现有 `Match`、`AllowUsers/Groups`、`DenyUsers/Groups` 和 `DisableForwarding` 是否冲突。

```text
Match User <隧道用户>
    PubkeyAuthentication yes
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding remote
    GatewayPorts clientspecified
    PermitListen <监听地址>:<隧道端口>
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    PermitTTY no
    X11Forwarding no
    PermitTunnel no
    PermitUserRC no
    MaxSessions 0
    ClientAliveInterval 5
    ClientAliveCountMax 2
Match all
```

`MaxSessions 0` 禁止 shell、命令及子系统会话，仍允许端口转发。`restrict` 后仅重新开放受监听地址限制的 TCP 转发。不要用 `DisableForwarding yes`，否则需要的隧道也会被禁用。具体语义参见 [OpenSSH 配置手册](https://man.openbsd.org/sshd_config#MaxSessions)与[公钥限制说明](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)。

```bash
sudo /usr/sbin/sshd -t
sudo /usr/sbin/sshd -T -C 'user=<隧道用户>,addr=<Mac当前出口IPv4>,host=<Mac主机名>'
# 检查生效结果符合上方限制且未被其他 Match 覆盖，再重载。
sudo systemctl reload ssh
```

`sshd -t` 只证明语法有效，`-T -C` 检查此用户实际生效值。若发行版账户锁定/PAM 规则阻止公钥认证，先查 SSH 日志并按本机账户政策处理；不要为通隧道开启密码认证或授予 sudo。此限制不支持普通交互登录，后续测试使用 `ssh -N`。

## 5. 配置 DNS、证书和 nginx

### 5.1 先开 ACME 验证路径

已有有效证书及自动续期时可复用，记录管理方式，不重复申请。首次申请使用 webroot：域名解析到服务器，80 端口可达，站点先只加入以下 HTTP 配置，不提前引用尚不存在的证书：

```nginx
server {
    listen 80;
    server_name <域名>;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/hcode-acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 404; }
}
```

按第 3 节选定的方式校验并重载 nginx。先在 webroot 中放置一份不含秘密的临时探测文件，从服务器外通过 HTTP 访问核对内容后删除；确认代理/CDN没有拦截此路径。然后在宿主机运行：

```bash
sudo certbot certonly --webroot -w /var/www/hcode-acme \
  --cert-name '<域名>' -d '<域名>' -m '<证书邮箱>' --agree-tos
sudo certbot certificates
```

选择实际生成的 `<证书名称>` 和证书路径。此流程遵循 [Certbot webroot 说明](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot)。80 不可开放时应改用管理员已有的自动化 DNS 验证方式，并单独验证续期，不能声称本节 HTTP 验证已通过。

### 5.2 再启用 HTTPS 与远程路径

保留 HTTP 的 ACME location，把 HTTP `location /` 改为 `return 301 https://<域名>$request_uri;`。新增下方 HTTPS server；已有同域名 443 server 时仅合并证书及 location，保留其他业务设置。独立子域名更便于控制其他同源应用的影响。

```nginx
server {
    listen 443 ssl;
    server_name <域名>;
    ssl_certificate /etc/letsencrypt/live/<证书名称>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<证书名称>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location = /hcode { return 301 /hcode/; }
    # 公网永不提供通知订阅；精确路径及全部后代路径均拒绝。
    location = /hcode/api/notifications { return 404; }
    location ^~ /hcode/api/notifications/ { return 404; }

    location ^~ /hcode/ {
        proxy_pass http://<监听地址>:<隧道端口>/;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Prefix /hcode;
        proxy_buffering off;
        proxy_cache off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 1h;
        client_max_body_size 30m;
        proxy_intercept_errors on;
        error_page 500 502 503 504 =503 @hcode_unavailable;
    }
    location @hcode_unavailable {
        default_type text/plain;
        charset utf-8;
        add_header Cache-Control "no-store" always;
        return 503 "HCode 暂时无法连接，请稍后重试。\n";
    }
    location / { return 404; }
}
```

如保留 AAAA，HTTP/HTTPS server 还需按宿主机或容器实际发布方式增加对应 IPv6 监听。两个 server 放在同一站点文件即可。

`proxy_pass` 末尾的 `/` 用于把 `/hcode/api/…` 转为本机 `/api/…`；`X-Forwarded-Prefix` 决定 Cookie 路径，`X-Forwarded-Proto` 决定 Secure 属性，不能遗漏。关闭响应缓冲才能及时收到 SSE，具体语义参见 [nginx 官方代理文档](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。附件限制按 JSON/base64 请求体计算，30 MiB 不等于可上传 30 MiB 原始文件。不得为方便在另一公网 location 直接代理同一个上游，绕过通知屏蔽。

按第 3 节校验并重载。HCode 未连接时，`https://<域名>/hcode/` 应返回 503；通知路径即使未连隧道也应是 404。不要用 `curl -k` 跳过证书验证。

### 5.3 配置续期与 reload

使用发行版 Certbot 时检查并启用其定时器：

```bash
sudo systemctl enable --now certbot.timer
sudo systemctl list-timers certbot.timer --all
sudo certbot renew --cert-name '<证书名称>' --dry-run
```

在 `/etc/letsencrypt/renewal-hooks/deploy/` 新建本入口的可执行脚本，权限 755，以下二选一。宿主机版本：

```sh
#!/bin/sh
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
```

Docker 版本（先用 `command -v docker` 核对并替换绝对路径和容器名称）：

```sh
#!/bin/sh
set -eu
/usr/bin/docker exec '<nginx容器>' nginx -t
/usr/bin/docker exec '<nginx容器>' nginx -s reload
```

先手工运行该 hook，确认成功，再记录路径。成功续期后才执行 deploy hook；普通 `--dry-run` 默认不会执行它，支持时可用 `--dry-run --run-deploy-hooks` 额外验证。依据 [Certbot 续期说明](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)，不能用“renew 返回 0”推断证书已变更或 nginx 已加载新证书。已有证书管理器时沿用其定时与 reload 机制，不新增重复定时器。

## 6. Mac SSH 配置与主机身份核验

在 Mac `~/.ssh/config` 中添加，避免与现有 Host 重名：

```sshconfig
Host <SSH别名>
    HostName <服务器地址>
    Port <SSH端口>
    User <隧道用户>
    IdentityFile <私钥绝对路径>
    IdentitiesOnly yes
    StrictHostKeyChecking yes
    BatchMode yes
    RequestTTY no
    ControlMaster no
    ControlPath none
```

路径含空格时按 OpenSSH 语法加引号。限制 `~/.ssh/config` 权限为 600。此处不写 `RemoteForward`，转发由 HCode 管理；检查其他匹配的 `Host *` 块没有附加转发、后台连接或代理配置造成冲突：

```bash
ssh -G '<SSH别名>'
```

管理员在服务器查看主机公钥指纹，并通过可信渠道交给 Mac 使用者：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

首次连接仅本次允许确认提示：

```bash
ssh -N -o BatchMode=no -o StrictHostKeyChecking=ask '<SSH别名>'
```

核对出现的密钥算法及指纹一致后接受；保持连接无输出通常是正常的，用 Ctrl+C 结束。再执行 `ssh -N -o BatchMode=yes '<SSH别名>'` 确认无需输入，随后 Ctrl+C。主机密钥变更必须由管理员确认更换原因和新指纹，不直接删除 known_hosts 记录或关闭检查。

## 7. 在 HCode 中连接

1. Mac 安装并登录可用的 HCode 与至少一个 AI CLI；安装说明见 [README](../README.md#使用)。Linux 服务器不执行 Mac 安装命令。
2. 打开「设置 → 远程操控」。本地端口留空或 0；SSH 主机别名填 `<SSH别名>`，服务器监听地址填 `<监听地址>:<隧道端口>`。只填一项会报错，两项都空只启动本机监听。
3. 启用远程操控，确认本地状态为监听、隧道状态为已连接。保持通知订阅关闭。四处地址必须完全一致：公钥 `permitlisten`、sshd `PermitListen`、nginx 上游、HCode 设置。
4. 在 Mac 本机浏览器打开设置显示的 `http://127.0.0.1:<本地端口>/`，使用设置中复制的访问口令登录，确认基础会话可读。
5. 在服务器检查监听及上游：

   ```bash
   sudo ss -lntp
   curl --max-time 10 -I 'http://<监听地址>:<隧道端口>/'
   ```

   Docker 路径还需从 nginx 容器内确认上游可达：若已有 curl/wget 就使用它；没有时通过公网请求、nginx error log 的连接结果及宿主机抓包核对，不临时改造正式 nginx 镜像。监听必须是选定的回环/网桥地址，不能是 `0.0.0.0`、`*` 或 `::`。
6. 手机关闭 Wi-Fi，用流量访问 `https://<域名>/hcode/`，输入 Mac 复制的口令。不要把口令放 URL、截图、聊天记录、shell 参数或公开部署记录。

HCode 的“隧道已连接”只确认 SSH 转发建立，不证明 DNS、证书、nginx 或公网入口已经通过。Mac 重启后还需要用户登录并启动 HCode；本指南不承诺无人登录自动运行。

## 8. 可选：通知订阅

不开启本节也能完成手机远程对话。需要通知时，先确认订阅程序属于可信服务器服务，再在 Mac 开启「允许订阅通知事件」，复制独立的订阅令牌到服务的秘密管理或权限 600 的配置文件。不得用登录口令代替，也不要把令牌写进命令行或访问日志。

订阅程序在服务器上直连 `http://<监听地址>:<隧道端口>/api/notifications/stream`，发送 `Authorization: Bearer <订阅令牌>`，不带任何 `X-Forwarded-*` 头；不能通过公网 `/hcode/` 订阅。Docker 中的订阅服务需单独核对网络与防火墙允许来源。

协议、重连游标和摘要字段见[方案第 11 节](HCode-远程操控-v1-方案.md#11-通知事件流通用对接能力)。通知含项目路径、标题，完成事件可能含回复摘要，应按正文数据保护。内存只保留最近 50 条，重启清空，不保证可靠投递；对接程序自行去重、重连及处理丢失窗口。关闭订阅或重新生成订阅令牌会断开现有订阅；轮换登录口令不能替代轮换独立订阅令牌。

## 9. 故障排查、恢复和撤销

### 9.1 按链路逐段定位

| 表现 | 检查点与处理 |
|---|---|
| DNS 或证书错误 | 核对 A/AAAA、443 可达、证书域名/有效期及代理实际加载的证书；不绕过校验 |
| `/hcode/` 返回 503 | 先看 Mac 本地服务和隧道状态，再查服务器 `ss -lntp`、上游 curl、nginx error log；不先修改登录口令 |
| `Permission denied` | 查公钥、文件权限、用户名、PAM/账户状态、`sshd -T -C` 及服务器 SSH 日志；确认 HCode 能访问已解锁私钥 |
| 主机密钥错误 | 管理员核验主机身份和指纹，不自动信任新密钥 |
| 转发失败/端口占用 | 确认四处地址一致、网桥存在、端口无其他占用；查看是否有旧连接，不结束整个 sshd 或其他用户进程 |
| 登录成功后仍反复要求登录 | 检查 HTTPS、`X-Forwarded-Proto`、前缀、浏览器 Cookie 属性与 API 路径；确认代理未缓存 API |
| 流式输出积攒后一次出现 | 检查实际生效配置和中间 CDN/代理的 SSE 缓冲、缓存及超时，不只检查模板 |
| 上传返回 413 | 核对所有代理的请求体上限、JSON/base64 后体积和应用限制，不盲目扩大为无限制 |
| Docker 上游连接失败 | 网关是否属于实际网络、容器源地址及 INPUT 防火墙是否匹配、挂载文件是否更新 |
| 401 / 429 | 401 为登录失效或口令不符；429 为共用失败限流，停止重试至少一个窗口（60 秒）后再试；不要循环撞口令 |

Ubuntu SSH 日志可查 `sudo journalctl -u ssh --since '-10 min' --no-pager`；nginx 日志按宿主机实际配置或 `docker logs '<nginx容器>' --since 10m` 查看。`nginx -T`、`docker inspect` 和 SSH 调试输出可能含私有信息，只在私有环境查看，分享前脱敏。

### 9.2 重连与日常维护

- Mac 网络切换后，SSH 心跳与退避会重连；服务器 `ClientAlive*` 仅在新连接生效。旧监听清理时间受网络和 sshd 影响，不能保证固定 15 秒。确认旧转发确实结束后再手工重试。
- Linux 重启后检查 ssh、nginx/Docker、网络和防火墙恢复；Mac 在线且 HCode 正在运行时应自动重连。若网桥/IP改变，先同步地址和规则。
- Mac 唤醒后会尝试恢复；应用退出时没有隧道。用户资料与钥匙串需可用，CLI 登录也需保持有效。
- 定期查看证书定时器和 reload hook 结果，并从公网检查证书；证书续期成功但代理未 reload 仍会继续使用旧证书。
- HCode 更新前记录版本；更新后检查会话可读、SSE 与口令持久化。浏览器持有旧资源时可刷新页面，不因此清理会话或项目数据。

### 9.3 回滚与关闭入口

配置失败时不 reload 无效配置。按备份恢复此次修改的站点/drop-in，再执行 `nginx -t`、`sshd -t`，通过后才重载对应服务；Docker 单文件挂载回滚也要保留 inode 或重建目标容器。只回滚本入口，不覆盖同时发生的其他业务修改。

临时停用：在 Mac 关闭远程操控，既有事件流断开、登录会话清除、SSH 隧道退出；公网新请求应返回 503，已显示内容不会被远程擦除。需要同时停止 AI 任务时，应另在 HCode 明确停止并核对结果，关闭远控本身不代表任务停止。

泄露处理：先关闭入口，重新生成登录口令；使用过通知订阅时也关闭订阅并轮换其令牌；专用 SSH 私钥泄露则撤销对应公钥、终止该专用用户的已有隧道连接并换新密钥，仅删除公钥不结束已建立连接。核对 Mac 上实际操作记录及正在运行任务。

永久撤销按以下顺序执行并逐步核对：

1. 关闭 Mac 远控与通知，确认本地服务及服务器监听都已结束；若 Mac 不可达，由管理员定位并终止该专用用户的隧道连接。
2. 撤销本次公钥。只有确认用户专用于本入口且连接已结束后，才移除该用户和它的 SSH drop-in；先删限制会使尚有效的密钥失去限制。
3. 删除/禁用仅属于本入口的 nginx 站点或 location，校验并重载；移除专属防火墙规则、续期 hook、容器挂载/专属网络及 DNS 记录。
4. 证书、ACME 定时器、nginx、Docker 如被其他站点共用则保留；只有确认独占才清理对应证书与资源。不删除 Mac 项目、CLI 会话或用户资料。

## 10. 上线验收与交接记录

以下为待执行检查表，未勾选不代表通过。使用专门的无敏感数据测试项目，Git 写操作只在该项目验收；需要服务器重启的步骤由管理员安排维护窗口，不影响共机业务。

| 检查 | 操作与通过信号 | 结果 |
|---|---|---|
| 版本与参数 | 记录安装的 HCode 版本、系统/代理版本、拓扑、私有参数表、负责人、备份位置 | ☐ |
| TLS | 手机流量打开域名，无证书告警；80 重定向 HTTPS，ACME 路径仍可用 | ☐ |
| 未登录保护 | 新无痕窗口看到登录入口；不带 Cookie 的 invoke 返回 401，事件接口也返回 401 | ☐ |
| 登录 Cookie | 浏览器网络面板确认 `HttpOnly; Secure; SameSite=Strict; Path=/hcode`，有效期最长 7 天 | ☐ |
| 白名单与权限 | 登录后无效通道明确拒绝；测试项目外的 Git 请求被拒绝；确认接受远程可添加项目和选择完全放行的能力 | ☐ |
| 监听与隔离 | `ss` 只显示所选地址；从外部网络探测服务器公网 IPv4/IPv6 的隧道端口均不可连接；Docker 路径还验证未授权来源被拒绝及规则持久化 | ☐ |
| SSH 限制 | 专用密钥无法执行命令/开启 shell；其他监听端口的 `-R` 与本地 `-L` 实际连接被拒绝；允许的 `-N -R` 可用 | ☐ |
| 手机完整流程 | 新建/续聊、实时输出、停止、工具审批/提问、小图片上传均成功；Mac 同时可见结果 | ☐ |
| 当前扩展能力 | 测试项目添加、受限文件预览、Git 分支预览/切换及提交切换结果与当前版本一致，不动真实业务项目 | ☐ |
| 多端审批 | 两端显示同一审批，一端完成后另一端关闭卡片，不重复执行 | ☐ |
| 口令轮换 | 两个浏览器登录后在 Mac 重新生成口令；旧 Cookie 新请求返回 401、事件流断开，旧口令不能重新登录 | ☐ |
| 应用重启 | 不关闭远控开关，仅退出再开 HCode，隧道恢复，未过期登录保持；与下一项区别检查 | ☐ |
| 关闭开关 | 在线事件流断开、登录失效；旧 Mac 本地端口/服务器转发结束，公网新请求返回 503；重新开启后需重新登录 | ☐ |
| 断网/唤醒恢复 | Mac 断网再联网及休眠再唤醒，隧道和当前会话快照恢复；中断期间操作结果在 Mac 核实，不自动重复写操作 | ☐ |
| 服务器重启 | 维护窗口重启后 SSH、代理、网桥、防火墙恢复，Mac 在线时远控自动恢复 | ☐ |
| 通知屏蔽 | 公网 `/hcode/api/notifications/stream` 返回 404；不开启订阅也应成立；其他代理入口没有绕过 | ☐ |
| 可选通知 | 若启用，直连正确令牌有 SSE、错误令牌 401、带转发头 404；轮换/关闭立即断开。未启用记“不适用” | ☐ |
| 证书续期 | renew dry-run 通过，定时器生效，reload hook 单独执行成功；使用其他管理器则记录等价证据 | ☐ |
| 运维交接 | 负责人可找到日志、备份、回滚和撤销步骤，明确 Mac 可用性与服务器信任边界 | ☐ |

无 Cookie 的接口探测可在外部终端运行，不需要真实口令：

```bash
curl --max-time 10 -i -X POST 'https://<域名>/hcode/api/invoke' \
  -H 'Content-Type: application/json' -H 'X-HCode-Remote: 1' \
  --data '{"channel":"settings:get","args":[]}'
curl --max-time 10 -i 'https://<域名>/hcode/api/events'
curl --max-time 10 -i 'https://<域名>/hcode/api/notifications/stream'
```

隧道在线时前三个响应依次应为 401、401、404；隧道不在线时前两项可能是 503，不能算认证验证通过。禁用通道可在已登录页面的网络工具中重放 invoke，把 `channel` 改为不存在的 `deployment:probe`，应返回 403；不要复制 Cookie 或口令进公开记录。

公钥限制的反向测试由 Mac 使用者在无真实任务时完成：用同一专用密钥请求另一个未授权的远端监听端口，配合 `ExitOnForwardFailure=yes` 应失败；`-L` 测试不能只看 ssh 进程是否启动，必须发起一次实际转发连接并确认服务器拒绝。测试完成结束手工 SSH 进程，不与 HCode 争用已授权端口。

私有交接记录至少填写：部署日期、HCode/服务器/OpenSSH/nginx 版本（Docker 另记镜像摘要）、参数表及主机指纹存放位置、各项结果与证据、未通过项、通知是否启用、维护负责人、备份与回滚位置。只有相关验收全部通过，才标记“已部署并验收”；仓库文档检查或本机单元测试不能代替接收方现场验收。

## 11. 配置依据

- [OpenSSH sshd_config](https://man.openbsd.org/sshd_config)：转发、监听限制、Match 与 MaxSessions；目标发行版同时以本机手册和有效配置为准。
- [OpenSSH authorized_keys](https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT)：密钥级限制。
- [nginx 代理模块](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)：路径替换、转发头、缓冲和错误拦截。
- [Docker bridge 网络](https://docs.docker.com/engine/network/drivers/bridge/)：网桥拓扑；不能据此假定宿主机监听仅 nginx 可访问。
- [Certbot 使用及续期](https://eff-certbot.readthedocs.io/en/stable/using.html)：webroot、自动续期及 deploy hook。
