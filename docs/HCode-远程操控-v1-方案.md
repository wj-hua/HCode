# HCode 远程操控 v1 方案

参照 ZCode Web 远控（`ZCode/docs/web-remote-control/`），让手机浏览器经云服务器访问本机正在运行的 HCode，查看会话、发送消息和处理审批。Agent 仍在本机执行，手机只是另一个界面。v1 以走通流程为主，不追求 ZCode 的分片 ACK、多版本部署、账号配对等能力。

> 本仓库开源。文档、代码、默认设置中不出现真实域名、服务器 IP、端口、SSH 用户名与私钥路径、访问口令。下文 `<域名>`、`<网关地址>`、`<端口>`、`<SSH 别名>` 均为占位，真实值只存在于本机设置与服务器配置中。

## 1. 目标与范围

v1 做：

- 设置中的「远程操控」开关，**默认关闭**；关闭时不监听端口、不建立隧道、不接受任何远程请求。
- 手机浏览器打开 `https://<域名>/hcode/`，输入访问口令后进入。
- 浏览已添加项目与会话、打开历史会话、查看正在运行会话的实时输出。
- 在已有会话续聊或新建会话、停止当前回合、处理工具审批与提问、上传附件。
- 本机界面显示远程操控状态（关闭 / 连接中 / 已连接 / 出错）和在线客户端数。

v1 不做：

- 内置终端、Git 提交/推送/切换分支、协作与专家评审、扩展管理、修改设置。
- 任意路径文件读取、HTML 预览、背景媒体（依赖 Electron 自定义协议）。
- 专门的手机布局（v1 复用桌面界面，仅做最小适配，见 §6）。
- 多设备配对、账号体系、断线逐条重放。

## 2. 总体结构

```text
手机浏览器
   │ HTTPS（已有证书）
   ▼
云服务器 nginx 容器  location /hcode/ ──proxy──> <网关地址>:<端口>
                                                  │ 仅容器网关可达，不对公网开放
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

- **服务器不写程序**。nginx 已为同机其他服务反代到 Docker 网关地址，沿用同一模式；sshd 负责隧道。
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
}
```

- 不在设置里保存 IP、私钥路径：私钥、用户名、服务器地址都写在用户自己的 `~/.ssh/config` 中，HCode 只记别名。
- `enabled` 为 true 时启动本地服务；`sshHost` 和 `remoteBind` 均为空时不启动隧道，配置不完整或无效时显示隧道错误。
- **访问口令不放进 `Settings`**（`settings:get` 的结果会发给渲染进程，也可能被远程读取）。首次开启时用 `crypto.randomBytes` 生成，经 `safeStorage` 加密后存到 userData 下单独文件（权限 600）。设置页提供「复制口令」「重新生成」；重新生成后所有已登录的远程会话立即失效。
- 应用启动时仅当 `enabled` 为 true 才启动服务；关闭开关立即：断开所有 SSE、清空登录会话、结束 ssh 进程、关闭 HTTP 监听。

### 3.2 RemoteControlService（新增 `src/main/remoteControl/`）

- `remoteControlService.ts`：`http.createServer`，监听 `127.0.0.1:<本地端口>`。
  - 静态文件：从 `out/renderer` 读取，限制在该目录内，开发模式可代理到 Vite。
  - `POST /api/login`：常量时间比较口令（`crypto.timingSafeEqual`）；成功下发 `HttpOnly; SameSite=Strict` 的随机会话 Cookie，代理声明 HTTPS 时附加 `Secure`，路径由代理前缀决定。会话仅存内存、7 天过期、应用重启失效。登录失败共用限流：每分钟最多 5 次。
  - `POST /api/invoke`：校验 Cookie 和自定义头 `X-HCode-Remote: 1`（防 CSRF），请求体 `{ channel, args }`，返回 `{ ok, result }` 或 `{ ok: false, error }`。请求体上限为 30 MiB。
  - `GET /api/events`：SSE，`event: <channel>` + `data: <json>`；每 15 秒发注释心跳。
- `tunnel.ts`：`child_process.spawn("ssh", ["-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-R", `${remoteBind}:127.0.0.1:${localPort}`, sshHost])`。使用登录 shell 环境中的 `ssh`；退出后按 2s / 5s / 15s / 30s 退避重连；`BatchMode=yes` 避免弹出交互密码。stderr 只记录错误类型，不记录服务器地址和用户名。
- `index.ts`：组合 server + tunnel，维护状态 `{ state, clients, error }`，变化时向本机窗口发 `remote:status` 事件。

### 3.3 接入现有 IPC

- `handle()` 在注册 `ipcMain.handle` 的同时，把 handler 记入一个 `Map<channel, handler>`；远程 `/api/invoke` 只能调用其中 **白名单** 内的通道。
- `send()` 在发给主窗口后，再把 **白名单** 内的事件推给所有在线 SSE 客户端。
- 结果中的 `Uint8Array` 等非 JSON 类型的通道不进入白名单。

v1 远程可调用通道：

| 类别 | 通道 |
|---|---|
| 基础信息 | `agent:status` `agent:models` `agent:commands` `quota:list` `projects:list` `workspace:conversation` |
| 会话 | `sessions:list` `sessions:load` `sessions:search` `claude/codex/agy:subagents` `…:subagentMessages` |
| 对话 | `chat:send` `chat:interrupt` `chat:setModel` `chat:setPermissionMode` `permission:respond` `chat:live` `chat:snapshot` |
| 输入辅助 | `fs:listProjectFiles` `fs:stageAttachment` |
| 设置 | `settings:get`（远程专用的只读精简结果，见下） |

v1 远程可接收事件：`chat:rows` `chat:state` `chat:commands` `chat:promptSuggestion` `permission:requested` `permission:resolved` `sessions:indexChanged` `quota:updated`。

明确排除及原因：

- `terminal:*`：等同远程 shell。
- `settings:set`：可改 `agentPaths` 指向任意程序。
- `fs:readText` / `fs:stat` / `fs:readMedia` / `git:*`：任意路径读取、推送代码。
- `app:*`、`projects:add`：会在本机弹出对话框或打开应用，对手机无意义。
- `chat:close`、`sessions:delete` / `rename` / `fork`、`collaboration:*`、`extensions:*`：v1 不需要，减少误操作面。

额外规则（在主进程远程入口内校验，不依赖界面隐藏）：

- **远程可选择会话支持的权限模式**，包括完全放行；`chat:setPermissionMode` 校验模式属于当前会话的 CLI。远程续聊沿用会话选定的权限模式。
- `chat:send` / `fs:listProjectFiles` 的项目路径必须属于 `projects:list` 或非项目对话工作目录。
- 远程 `settings:get` 只返回界面渲染必需字段（主题、语言、界面模式、默认 CLI/模型/权限），不含 `remoteControl`、`agentPaths`、自定义声音与背景路径。

### 3.4 中途接入：`chat:snapshot`

手机打开一个正在运行的会话时，只靠增量 `chat:rows` 会缺前文。新增 invoke：

```ts
"chat:snapshot": [[sessionKey: string], {
  rows: ConversationRow[];          // 投影器 snapshot()，与 reset 操作同源
  state: ChatStateEvent | null;
  permissions: PermissionRequestEvent[]; // 尚未处理的审批
} | null]
```

数据已在主进程：`rowProjectorBase` 维护完整行，`claudeSession.ts` 已用 `snapshot()` 下发 `reset`。各 `AgentProvider` 补一个读取方法，由 registry 路由。SSE 断开重连后，手机对当前打开的会话重新调用一次 `chat:snapshot` 覆盖本地内容（替代 ZCode 的逐条重放）。

此外需要一个「当前活跃会话」列表（可并入 `chat:snapshot` 的批量形式或新增 `chat:liveSessions`），让手机侧边栏标出正在运行和等待审批的会话。

## 4. 渲染进程

- `bridge.ts`：`window.hcode` 存在时用 preload 版本；不存在时（普通浏览器）创建远程版本：
  - `invoke` → `fetch("api/invoke", …)`，错误还原为 `Error`。
  - `on` → 共用一个 `EventSource("api/events")`，按事件名分发；断线后浏览器自动重连，重连成功时触发一次快照刷新。
  - `getPathForFile` → 返回 `null`（附件自动走已有的 `fs:stageAttachment` 上传分支，`Composer.tsx` 已支持）。
  - 新增 `remote: boolean` 标记，供界面隐藏本机功能。
- 未登录时（invoke 返回 401）显示一个只有口令输入框的登录页。
- `remote` 为 true 时隐藏：添加项目、终端、在 Finder 显示/打开文件、外部终端、Git 操作、协作「工作方式」菜单（固定普通对话）、设置对话框（只保留主题切换）、背景设置。权限菜单允许选择当前 CLI 支持的模式，包括完全放行。
- 本机界面：设置中新增「远程操控」分组——开关、SSH 别名、服务器监听地址、状态、在线客户端数、复制/重新生成口令；有远程客户端在线时侧边栏底部显示提示，可一键关闭。

构建：沿用同一份 `vite build` 产物，远程页面就是 `out/renderer/index.html`。`base: "./"` 已支持子路径 `/hcode/`；CSP `connect-src 'self'` 允许同源 fetch 与 SSE，无需修改。

## 5. 服务器配置（手动操作，不入仓库）

以下步骤只写进本机私有笔记，仓库中仅保留此占位说明。

1. **受限隧道用户**：新建无登录 shell 的用户（如 `hcode-tunnel`），为它单独生成一把本机密钥（不复用 root 密钥）。`authorized_keys` 该行加限制：
   `restrict,port-forwarding,permitlisten="<网关地址>:<端口>" ssh-ed25519 …`
   （服务器 OpenSSH 8.0 支持 `permitlisten`）。
2. **sshd**：为该用户加 `Match User` 块：`GatewayPorts clientspecified`、`AllowTcpForwarding remote`、`PermitTTY no`、`X11Forwarding no`、`ClientAliveInterval 30`、`ClientAliveCountMax 3`（及时清理断掉的旧隧道，否则重连会因端口占用失败）。改前备份，改后 `sshd -t` 校验再重载。
3. **nginx**：在 443 server 中加：

   ```nginx
   location = /hcode { return 301 /hcode/; }
   location /hcode/ {
       proxy_pass http://<网关地址>:<端口>/;
       proxy_http_version 1.1;
       proxy_buffering off;          # SSE 必需
       proxy_read_timeout 1h;
       client_max_body_size 30m;     # 附件上传（base64 后约 28 MB）
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header X-Forwarded-Prefix /hcode;  # Cookie 只限此路径
   }
   ```

   改前备份，`nginx -t` 校验后 reload 容器。配置文件以单文件方式挂载进容器时，需原地写入（保持 inode），`sed -i` 等替换文件的方式会让容器继续读到旧内容。隧道未连接时该路径返回 502，属正常。
4. **防火墙**：不新增端口。`<网关地址>:<端口>` 只在 Docker 网桥上可达，公网仍只开 22/80/443。
5. **本机 `~/.ssh/config`**：为隧道用户写一个 Host 别名（`User`、`IdentityFile`、`IdentitiesOnly yes`），HCode 设置里只填这个别名和 `<网关地址>:<端口>`。HCode 以 `BatchMode=yes` 运行 ssh，首次使用前需先在终端连接一次以信任主机密钥。

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
- **延迟**：服务器在国内，手机与本机在海外时链路需跨境往返两次，流式输出会有可感知延迟和偶发断线；SSE 自动重连 + 快照刷新可恢复。
- **隧道残留**：网络切换后服务器上旧的转发可能尚未释放，新隧道启动失败。依靠服务器 `ClientAlive*` 清理与本机退避重连解决。
- **非 JSON 数据**：白名单内通道都返回 JSON；以后开放媒体读取需单独做 HTTP 下载接口。

## 9. 实施步骤与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| R1 主进程服务 | 设置项、口令存储、HTTP 服务、白名单 invoke/SSE、`chat:snapshot` | 开关关闭时端口未监听；本机浏览器访问 `127.0.0.1:<本地端口>` 能登录、看到会话、收到实时输出；非白名单通道返回拒绝 |
| R2 渲染进程 | 远程 bridge、登录页、隐藏本机功能、设置分组、状态提示 | 浏览器中能新建/续聊会话、停止、审批、上传图片，并选择当前 CLI 支持的权限模式 |
| R3 隧道与服务器 | ssh 反向隧道与重连、服务器受限用户、sshd 与 nginx 配置 | 手机流量下打开 `https://<域名>/hcode/` 完成一轮带审批的对话；本机断网恢复后自动重连；关闭开关后手机立即断开、页面返回 502 |
| R4 最小手机适配 | 视口、侧边栏收起、输入框字号 | iPhone Safari 竖屏可正常阅读和输入 |

每阶段提交前检查改动中没有域名、IP、口令、密钥路径等真实值。

## 10. 后续（v2 及以后）

- 专门的手机首页/聊天布局。
- 开放协作、Git 只读查看、文件预览（HTTP 下载接口）。
- 远程模式下可选的阻止休眠。
- 多台 Mac 时的设备选择。
- 服务器迁到离使用地更近的机器以降低延迟（方案不变，只换隧道目标和 nginx 所在机器）。
