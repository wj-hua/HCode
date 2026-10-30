# HCode 远程操控 v1 方案

参照 ZCode Web 远控（`ZCode/docs/web-remote-control/`），让手机浏览器经云服务器访问本机正在运行的 HCode，查看会话、发送消息和处理审批。Agent 仍在本机执行，手机只是另一个界面。v1 以走通流程为主，不追求 ZCode 的分片 ACK、多版本部署、账号配对等能力。

> 部署入口：[服务器部署与验收指南](HCode-远程操控-服务器部署与验收指南.md)。本方案描述架构；首次安装、参数准备、证书、排错和撤销按部署指南执行。服务器只部署中转入口，不运行 HCode、AI CLI 或项目任务。2026-10-29 按仓库版本 `0.19.32` 核对并更新能力范围；实际交付时仍需记录安装版本。

> 本仓库开源。文档、代码、默认设置中不出现真实域名、服务器 IP、端口、SSH 用户名与私钥路径、访问口令。下文 `<域名>`、`<网关地址>`、`<端口>`、`<SSH 别名>` 均为占位，真实值只存在于本机设置与服务器配置中。

## 1. 目标与范围

v1 做：

- 设置中的「远程操控」开关，**默认关闭**；关闭时不监听端口、不建立隧道、不接受任何远程请求。
- 手机浏览器打开 `https://<域名>/hcode/`，输入访问口令后进入。
- 浏览已添加项目与会话、打开历史会话、查看正在运行会话的实时输出。
- 在已有会话续聊或新建会话、停止当前回合、处理工具审批与提问、上传附件。
- 本机界面显示远程操控状态（关闭 / 连接中 / 已连接 / 出错）和在线客户端数。
- 当前实现已增加远程浏览/添加/创建项目目录、Git 分支与提交切换，以及已添加项目和系统临时目录内的受限文件预览。这些能力不具备按登录用户隔离，不能把“已添加项目”视为不可扩大的授权范围。

v1 不做：

- 内置终端、直接 Git 推送接口、协作与专家评审入口、扩展管理、修改本机设置。
- 独立的任意路径读取接口、依赖 Electron 自定义协议的 HTML 页面预览及背景媒体。受限文件预览见 §3.3；Agent 仍可能按权限执行命令或读取其他文件，不能据此推断存在完整沙箱。
- 专门的手机布局（v1 复用桌面界面，仅做最小适配，见 §6）。
- 多设备配对、账号体系、断线逐条重放。

## 2. 总体结构

```text
手机浏览器
   │ HTTPS（已有证书）
   ▼
云服务器 nginx 容器  location /hcode/ ──proxy──> <网关地址>:<端口>
                                                  │ 绑定宿主机网桥地址，另行限制访问；不对公网开放
                                                  ▼
                                   sshd 反向转发（受限隧道用户）
                                                  ▲ 本机主动发起 ssh -N -R
                                                  │
本机 HCode 主进程  RemoteControlService  127.0.0.1:<本地端口>
   ├─ 静态页面：out/renderer（与桌面同一份构建）
   ├─ POST /api/login     口令登录，下发会话 Cookie
   ├─ POST /api/invoke    转发到现有 IPC handler（白名单）
   └─ GET  /api/events    SSE 推送现有 IPC 事件（白名单）
```

选择理由：

- **服务器不写程序**。nginx 与 sshd 负责中转；nginx 在宿主机运行时使用回环监听，在 Docker 网桥中运行时使用宿主机网桥地址。网桥地址本身不提供“仅 nginx 可访问”的保证。
- **本机无需公网入口**。隧道由本机主动连出；本地服务只监听 `127.0.0.1`。
- **只用标准库/系统能力**。Node `http` 模块 + 浏览器原生 `fetch` / `EventSource`；隧道使用系统 OpenSSH；口令加密使用 Electron `safeStorage`（macOS 钥匙串）。不新增依赖。
- **复用现有 IPC**。主进程所有请求经 `handle()` 注册、所有事件经 `send()` 发出（`src/main/index.ts`），渲染进程所有调用经 `src/renderer/app/bridge.ts` 的 `hcode`。远程只是这两个出入口的第二个传输层。

## 3. 本机主进程

### 3.1 开关与设置

`Settings` 新增（`src/shared/types.ts`、`DEFAULT_SETTINGS`、`AppStore` 归一化）：

```ts
remoteControl: {
  enabled: boolean;      // 默认 false
  sshHost: string;       // ~/.ssh/config 中的 Host 别名，默认 ""
  remoteBind: string;    // 服务器侧监听地址:端口，默认 ""
  localPort: number;     // 本地服务端口，默认 0 = 启动时随机分配
  notificationFeed: boolean; // 默认 false，独立的通知订阅开关
}
```

- 不在设置里保存 IP、私钥路径：私钥、用户名、服务器地址都写在用户自己的 `~/.ssh/config` 中，HCode 只记别名。
- `enabled` 为 true 时启动本地服务；`sshHost` 和 `remoteBind` 均为空时不启动隧道，配置不完整或无效时显示隧道错误。
- **访问口令不放进 `Settings`**（`settings:get` 的结果会发给渲染进程，也可能被远程读取）。首次开启时用 `crypto.randomBytes` 生成，经 `safeStorage` 加密后存到 userData 下单独文件（权限 600）。设置页提供「复制口令」「重新生成」；重新生成后所有已登录的远程会话立即失效。
- 应用启动时仅当 `enabled` 为 true 才启动服务；关闭开关立即：断开所有 SSE、清空登录会话、结束 ssh 进程、关闭 HTTP 监听。

### 3.2 RemoteControlService（`src/main/remoteControl/`）

- `remoteControlService.ts`：`http.createServer`，监听 `127.0.0.1:<本地端口>`。
  - 静态文件：从 `out/renderer` 读取，限制在该目录内；正式部署使用构建产物。
  - `POST /api/login`：常量时间比较口令（`crypto.timingSafeEqual`）；成功下发 `HttpOnly; SameSite=Strict` 的随机会话 Cookie，代理声明 HTTPS 时附加 `Secure`，路径由代理前缀决定。会话 7 天过期，应用重启或更新后保留：userData 下 `remote-control-sessions.json`（权限 600）只存会话标识的 SHA-256 摘要与过期时间，最多 50 条；重新生成口令、关闭远程操控、登出时清除，文件损坏时视为无已登录会话。登录失败共用限流：每分钟最多 5 次。
  - `POST /api/invoke`：校验 Cookie 和自定义头 `X-HCode-Remote: 1`（防 CSRF），请求体 `{ channel, args }`，返回 `{ ok, result }` 或 `{ ok: false, error }`。请求体上限为 30 MiB。
  - `GET /api/events`：SSE，`event: <channel>` + `data: <json>`；每 15 秒发注释心跳。
- `tunnel.ts`：使用系统 `/usr/bin/ssh`，开启 `ExitOnForwardFailure=yes`、`BatchMode=yes`，以 `ServerAliveInterval=5` / `ServerAliveCountMax=2` 检测失联。禁用 SSH 主连接复用、持久化与后台运行，使隧道归当前子进程管理。普通失败按 1s / 2s / 5s / 10s 退避；远端转发失败时每 2s 重试，等待旧监听释放。stderr 只归纳错误类型，不保存原始输出。
- 网络恢复：每 2s 检查非回环网卡地址变化，稳定 2s 后重建连接；系统唤醒也触发恢复，窗口关闭后仍然有效。地址未变化的路由或代理切换由 SSH 心跳兜底。重建时先结束旧进程，2s 未退出则强制结束，收到关闭通知后才建立新连接。认证/转发阶段另有 20s 总超时。
- `remoteControlService.ts` 组合 server + tunnel，维护本地服务、隧道、客户端数及通知订阅数，变化时向本机窗口发 `remote:status` 事件；由 `src/main/index.ts` 注入现有 handler 和状态来源。

### 3.3 接入现有 IPC

- `handle()` 在注册 `ipcMain.handle` 的同时，把 handler 记入一个 `Map<channel, handler>`；远程 `/api/invoke` 只能调用其中 **白名单** 内的通道。
- `send()` 在发给主窗口后，再把 **白名单** 内的事件推给所有在线 SSE 客户端。
- 结果中的 `Uint8Array` 等非 JSON 类型的通道不进入白名单。

当前远程可调用通道（普通白名单见 `src/main/remoteControl/policy.ts`；专用 HTTP 通道由 `remoteControlService.ts` 分发）：

| 类别 | 通道 |
|---|---|
| 基础信息 | `system:battery` `agent:status` `agent:models` `agent:commands` `quota:list` `projects:list` `workspace:conversation` |
| 项目管理 | `projects:browseDirectories` `projects:addPath`（可浏览宿主机目录，添加已有项目或创建最后一级目录） |
| 会话 | `sessions:list` `sessions:load` `sessions:search` `sessions:page` `sessions:refresh` `claude/codex/agy:subagents` `…:subagentMessages` |
| 对话 | `chat:send` `chat:interrupt` `chat:steer` `chat:stopBackgroundTask` `chat:setModel` `chat:setPermissionMode` `permission:respond` `chat:live` `chat:snapshot` |
| 输入辅助 | `fs:listProjectFiles` `fs:stageAttachment` |
| Git | `git:branches` `git:graph` `git:switchBranch` `git:branchSwitchPreview` `git:commitAndSwitch` `git:createBranch` |
| 受限文件与工具详情 | `fs:stat` `fs:readText` `fs:readMedia` `tools:detail`；图片另经需登录的 `GET /api/media/…` 获取 |
| 设置 | `settings:get`（保留设置结构，敏感路径与远程配置替换为默认值，见下） |

v1 远程可接收事件：`chat:rows` `chat:state` `chat:commands` `chat:promptSuggestion` `permission:requested` `permission:resolved` `sessions:indexChanged` `quota:updated`。

明确排除及原因：

- `terminal:*`：等同远程 shell。
- `settings:set`：可改 `agentPaths` 指向任意程序。
- 未列入白名单的 Git 通道（包括直接推送）不开放。受限 `fs:*` 走远程专用实现，不能直接复用桌面的任意路径读取。
- `app:*`、`projects:add`：会在本机弹出对话框或打开应用，对手机无意义。
- `chat:close`、`sessions:delete` / `rename` / `fork`、`collaboration:*`、`extensions:*`：v1 不需要，减少误操作面。

额外规则（在主进程远程入口内校验，不依赖界面隐藏）：

- **远程可选择会话支持的权限模式**，包括完全放行；`chat:setPermissionMode` 校验模式属于当前会话的 CLI。远程续聊沿用会话选定的权限模式。
- `chat:send` / `fs:listProjectFiles` 的项目路径必须属于 `projects:list` 或非项目对话工作目录。
- Git 操作校验已添加项目；远程可通过 `projects:addPath` 扩大项目列表。所有登录端共享同一个 Mac 用户的权限，没有独立的项目授权或审计身份。
- 文件预览按真实路径限制到已添加项目及系统临时目录，文本最多 256 KiB、媒体最多 10 MiB；项目内的敏感文件也在此范围内，详见 `filePreview.ts`。附件引用必须先经远程上传暂存。
- 远程 `settings:get` 保留设置结构，但 `remoteControl`、`agentPaths`、自定义声音与背景配置替换为默认值，`notifyOnFinish` 设为 false；不传出这些字段的实际本机配置。

### 3.4 中途接入：`chat:snapshot`

手机打开一个正在运行的会话时，只靠增量 `chat:rows` 会缺前文。当前提供 invoke：

```ts
"chat:snapshot": [[sessionKey: string], {
  rows: ConversationRow[];          // 当前页；投影器 snapshot() 为数据源
  state: ChatStateEvent | null;
  permissions: PermissionRequestEvent[]; // 尚未处理的审批
  seq: number;                    // 快照已覆盖的事件序号
  earlierRows?: SessionLoadResult["earlierRows"]; // 更早历史的分页入口
} | null]
```

数据在主进程：`rowProjectorBase` 维护完整行，经 Provider/registry 提供读取。SSE 断开重连后，手机对当前打开的会话调用 `chat:snapshot` 恢复内容，再接收后续增量（替代 ZCode 的逐条重放）。

当前活跃会话由 `chat:live` 提供，手机侧边栏据此标出正在运行和等待审批的会话。首次历史/活动快照只加载最近 3 个完整回合，按需加载更早历史；工具详情和图片按需读取，事件正文只订阅当前查看的会话。重连时使用快照序号过滤已覆盖事件。

## 4. 渲染进程

- `bridge.ts`：`window.hcode` 存在时用 preload 版本；不存在时（普通浏览器）创建远程版本：
  - `invoke` → `fetch("api/invoke", …)`，错误还原为 `Error`。
  - `on` → 共用一个 `EventSource("api/events")`，按事件名分发；断线后浏览器自动重连，重连成功时触发一次快照刷新。
  - `getPathForFile` → 返回 `null`（附件自动走已有的 `fs:stageAttachment` 上传分支，`Composer.tsx` 已支持）。
  - 新增 `remote: boolean` 标记，供界面隐藏本机功能。
- 未登录时（invoke 返回 401）显示一个只有口令输入框的登录页。
- 首次连接的探测请求最多等待 15s，失败后每 3s 自动重试，支持手动立即重试和浏览器恢复联网时提前重试。已打开页面断线时保留对话并提示重连；事件流恢复后重新取快照，快照失败也继续重试。取消页面连接时清理重连定时器和事件流，过期快照不覆盖新连接的数据。
- 远程模式隐藏终端、Finder/外部应用入口、协作「工作方式」菜单、完整设置对话框和背景设置；提供远程项目选择及受支持的 Git 操作。主题修改保存在浏览器本地；权限菜单允许选择当前 CLI 支持的模式，包括完全放行。界面隐藏不替代服务端白名单校验。
- 本机界面：设置中新增「远程操控」分组——开关、SSH 别名、服务器监听地址、状态、在线客户端数、复制/重新生成口令；有远程客户端在线时侧边栏底部显示提示，可一键关闭。

构建：沿用同一份 `vite build` 产物，远程页面就是 `out/renderer/index.html`。`base: "./"` 已支持子路径 `/hcode/`；CSP `connect-src 'self'` 允许同源 fetch 与 SSE，无需修改。

## 5. 服务器配置（通用模板入仓库，真实参数只保存在部署环境）

从零安装和完整操作顺序见[服务器部署与验收指南](HCode-远程操控-服务器部署与验收指南.md)。下文是配置摘要，不能替代首次部署和验收；证书、用户、密钥与监听地址均需按目标环境设置。

1. **受限隧道用户**：新建无登录 shell 的用户（如 `hcode-tunnel`），为它单独生成一把本机密钥（不复用 root 密钥）。`authorized_keys` 该行加限制：
   `restrict,port-forwarding,permitlisten="<网关地址>:<端口>" ssh-ed25519 …`
   `permitlisten` 需由服务器实际 OpenSSH 版本支持；以 `sshd -t` 与受限转发实测确认。私钥只留在 Mac。
2. **sshd**：为该用户加 `Match User` 块，限制公钥认证、远端 TCP 转发、`PermitListen`、`MaxSessions 0` 和其他转发能力；完整配置以部署指南为准。`ClientAliveInterval 5`、`ClientAliveCountMax 2` 用于清理无响应连接，实际时间依环境而定。改前备份，改后 `sshd -t` 校验，并用 `sshd -T -C` 确认用户生效配置，再重载。重载后的心跳配置适用于新建立的会话。
3. **nginx**：在 443 server 中加：

   ```nginx
   location = /hcode { return 301 /hcode/; }
   location = /hcode/api/notifications { return 404; }
   location ^~ /hcode/api/notifications/ { return 404; }
   location ^~ /hcode/ {
       error_page 500 502 503 504 =503 @hcode_unavailable;
       proxy_pass http://<网关地址>:<端口>/;
       proxy_http_version 1.1;
       proxy_set_header Connection "";
       proxy_buffering off;          # SSE 必需
       proxy_cache off;
       proxy_intercept_errors on;    # 将上游错误统一为下方 503 响应
       proxy_connect_timeout 5s;
       proxy_read_timeout 1h;
       client_max_body_size 30m;     # 附件上传（base64 后约 28 MB）
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header X-Forwarded-Prefix /hcode;  # Cookie 只限此路径
   }
   location @hcode_unavailable {
       default_type text/plain;
       charset utf-8;
       add_header Cache-Control "no-store" always;
       return 503 "HCode 暂时无法连接，请稍后重试。\n";
   }
   ```

   改前备份，`nginx -t` 校验后 reload 容器。配置文件以单文件方式挂载进容器时，需原地写入（保持 inode），`sed -i` 等替换文件的方式会让容器继续读到旧内容。隧道未连接时该路径返回 503，使用独立响应避免缺失的全局错误页把故障转换成 404。
4. **防火墙**：仅使用部署环境已有的 SSH、HTTP/HTTPS 入口，不向公网开放隧道监听端口。宿主机 nginx 使用 `127.0.0.1:<端口>`；Docker nginx 使用实测网桥地址，并在宿主机 INPUT 路径限制该端口只接受所需代理/订阅来源，不能把绑定网桥地址当作访问控制。不得直接套用固定公网端口或覆盖已有防火墙规则。
5. **本机 `~/.ssh/config`**：为隧道用户写一个 Host 别名（`User`、`Port`、`IdentityFile`、`IdentitiesOnly yes`、`StrictHostKeyChecking yes`），HCode 设置里只填这个别名和服务器监听地址。首次连接先经服务器管理员核对主机密钥指纹，再用 `ssh -N` 建立信任；受限用户不能执行普通 shell 命令。HCode 以 `BatchMode=yes` 运行 ssh，不会弹出口令交互。

## 6. 手机界面的最小适配

v1 复用桌面界面，只保证能用：

- 远程模式下窄屏默认收起侧边栏，打开会话后自动收起；输入框和审批卡片宽度跟随视口。
- `<meta name="viewport">` 补 `width=device-width, initial-scale=1`；输入框字号不小于 16px，避免 iOS 聚焦缩放。
- 专门的手机首页/聊天两页布局（ZCode `WebRemoteControlMobileShell` 思路）留到 v2。

## 7. 多端同时使用

- 事件同时发给本机窗口与所有远程客户端；草稿、滚动、打开的标签页等界面状态各端独立，与 ZCode 一致。
- 审批以 `interactionId` 为准，先到先处理；另一端收到 `permission:resolved` 后关闭卡片。后到的响应主进程直接忽略。
- 手机在本机未打开的会话中发送消息时，本机窗口会收到该会话的 `chat:state` / `chat:rows`，需确认本机渲染进程对「未打开的 sessionKey」只更新侧边栏状态、不报错（实施时核对 `sessionViewSync`）。

## 8. 风险与限制

- **数据传输**：浏览器到服务器依赖正确配置的 HTTPS，服务器到本机使用 SSH 加密。HTTPS 在服务器反向代理处终止，因此服务器及其管理员可能接触明文口令、会话和其他传输数据；这不是浏览器到本机的端到端加密。服务器上的代理到隧道监听端口使用 HTTP，必须限制该端口的访问，不应直接暴露公网。
- **远程权限**：已登录用户可以发消息、处理审批并选择当前 CLI 支持的权限模式，包括完全放行。Agent 可按其权限在本机执行命令和访问数据；项目路径校验与接口白名单不能作为 Agent 的完整安全沙箱。应将远程入口视作高敏感入口。
- **口令与设备**：远程操控默认关闭，本地服务仅监听回环地址；访问口令随机生成并由系统加密存储，登录失败有共用限流。登录会话最长 7 天，设备或口令泄露时应在设置中重新生成口令，使已有登录失效并断开远程客户端；不用时关闭远程操控。共用限流也可能被恶意请求触发，暂时阻止正常登录。
- **部署配置**：确保 HTTPS 证书有效、代理正确设置 `X-Forwarded-Proto`，并限制隧道用户和监听地址。上述保护取决于实际服务器配置，应用本身不会验证服务器是否安全部署。
- **本机需保持唤醒**：合盖或睡眠会断开隧道。现有「运行时阻止休眠」只覆盖有会话运行时；远程使用时需接电源并保持唤醒。v1 在设置页提示；是否在开启远程时自动阻止应用挂起，留作后续选项。
- **延迟**：取决于手机、服务器与 Mac 的位置及两段网络质量；跨境或长距离中转可能增加延迟和断线，SSE 自动重连与快照刷新可恢复可读状态，不能保证所有中断操作已经执行。
- **隧道残留**：网络切换后服务器上旧的转发可能尚未释放，新隧道启动失败。依靠服务器 `ClientAlive*` 清理与本机退避重连解决。
- **非 JSON 数据**：invoke 保持 JSON；媒体已有需要登录的独立 HTTP 地址及受限媒体读取接口，不能据此开放任意文件下载。
- **单用户信任模型**：共用口令不等于多用户账号。服务器管理员可接触中转明文，登录者能扩大项目列表、执行受支持的 Git 写操作并选择完全放行；需要多人隔离或不信任服务器管理员时，不适用本方案。

## 9. 实施步骤与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| R1 主进程服务 | 设置项、口令存储、HTTP 服务、白名单 invoke/SSE、`chat:snapshot` | 开关关闭时端口未监听；本机浏览器访问 `127.0.0.1:<本地端口>` 能登录、看到会话、收到实时输出；非白名单通道返回拒绝 |
| R2 渲染进程 | 远程 bridge、登录页、隐藏本机功能、设置分组、状态提示 | 浏览器中能新建/续聊会话、停止、审批、上传图片，并选择当前 CLI 支持的权限模式 |
| R3 隧道与服务器 | ssh 反向隧道与重连、服务器受限用户、sshd 与 nginx 配置 | 手机流量下打开 `https://<域名>/hcode/` 完成一轮带审批的对话；本机断网恢复后自动重连；关闭开关后事件流断开，新请求返回 503（已打开页面可能继续显示缓存内容） |
| R4 最小手机适配 | 视口、侧边栏收起、输入框字号 | iPhone Safari 竖屏可正常阅读和输入 |

每阶段提交前检查改动中没有域名、IP、口令、密钥路径等真实值。

交付部署还需完成指南中的未登录拒绝访问、Cookie 属性、非白名单拒绝、监听范围、公网通知接口屏蔽、口令轮换、服务器重启恢复与证书续期检查。未完成目标服务器和手机验收前，不标记为部署通过。

## 10. 后续（v2 及以后）

- 专门的手机首页/聊天布局。
- 开放协作及进一步扩展远程能力；Git 分支/提交切换、受限文件预览与媒体 HTTP 接口已实现，不再列为待办。
- 远程模式下可选的阻止休眠。
- 多台 Mac 时的设备选择。
- 服务器迁到离使用地更近的机器以降低延迟（方案不变，只换隧道目标和 nginx 所在机器）。

## 11. 通知事件流（通用对接能力）

HCode 只负责提供事件摘要；推送到手机（APNs、IM 机器人等）由对接方服务器实现。

- **开关**：设置 → 远程操控 → 通知订阅 →「允许订阅通知事件」（`remoteControl.notificationFeed`，默认关闭），必须同时开启远程操控。关闭后立即断开已有订阅。
- **订阅令牌**：与访问口令分开生成和存储（userData 下的 `remote-notification-token`，用 safeStorage 加密）。只能读事件摘要，不能登录页面或调用 invoke；重新生成后，已有订阅立即断开。
- **接口**：`GET /api/notifications/stream`，带 `Authorization: Bearer <订阅令牌>`，返回 SSE。每条事件格式为 `id: <启动标识>.<序号>`、`event: notification`、`data: <JSON>`，每 15 秒发一次注释心跳。
- **只接受直连**：请求带任意 `X-Forwarded-*` 头时一律返回 404。对接方服务器应经 SSH 隧道直连服务器侧的监听地址，并在公网反向代理上屏蔽 `/api/notifications/`。
- **补发**：内存保留最近 50 条。重连时带 `Last-Event-ID`：属于本次启动的，补发它之后的事件；属于其他启动的（HCode 重启过），补发全部缓存。首次订阅不带该头时不补发历史事件。HCode 重启后缓存清空，期间的事件不会补发。
- **事件**（`NotificationFeedEvent`，`src/shared/remoteControl.ts`）：

  ```json
  {"id":"9f3a1c2b.7","type":"done","sessionKey":"…","sessionId":"…","agent":"claude","project":"HCode","projectPath":"/Users/me/Projects/HCode","title":"修复通知跳转","summary":"已修复：点按通知直接打开对应会话。","at":1793180000000}
  ```

  `type` 的取值：`done`（运行中或等待审批之后回到空闲）、`error`（运行中之后出错，不含错误详情）、`approval`（出现工具审批或提问，附带 `tool` 工具名，不含命令或参数）。`id` 可以直接作为去重键。
- **会话标题**：可选 `title` 沿用所属 CLI 的会话列表标题；按 CLI、项目和原生会话 ID 精确匹配，新会话尚未进入历史时使用主进程已有的列表占位标题。标题可能来自首条消息的摘要，压成单行并限制为 120 个 Unicode 码点，不发送完整对话或审批参数。读取失败或超过 1.5 秒时记录诊断并省略标题，仍发送项目摘要；异步读取保持事件及补发顺序。旧订阅方可忽略此新增字段，旧 HCode 事件也仍然有效。
- **回复摘要**：`done` 事件可选 `summary`，取本轮最后一条 AI 回复（最后一个用户输入之后），去掉代码块、表格和 Markdown 标记后按句子截取开头，单行、最多 100 个 Unicode 码点；本轮没有回复时省略，不回退到上一轮。`error`、`approval` 不带回复内容。摘要属于对话正文，订阅方应按自己的安全要求决定是否推送。
- **直达会话**：`projectPath` 是项目绝对路径，也是 HCode 的项目唯一键。远程网页支持 `/?agent=<agent>&session=<sessionId>&project=<projectPath>`：初始化时按 CLI 与会话 ID 在该项目会话列表里定位并打开，随后从地址栏移除这些参数；会话不存在或项目不在远程范围内时提示并停在默认页面。项目是否允许访问仍由主进程远程 policy 校验。
- **判断位置**：在主进程中根据 `chat:state` 的状态变化和 `permission:requested` 判断，不依赖窗口是否打开。排队连续发送的消息每结束一轮都会产生一次 `done`；委派、协作子会话的状态变化也会被计入。
