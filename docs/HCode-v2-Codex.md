# HCode v2：接入 Codex CLI

## 目标
在 v1（Claude Code）基础上接入 Codex，Codex 与 Claude 共用同一套项目列表、会话历史、时间线卡片、审批卡片与输入框。

## 接入方式：codex app-server（官方 JSON-RPC 协议）
与 Claude 使用官方 Agent SDK 同理，Codex 走官方 `codex app-server`（stdio、按行 JSON-RPC；协议类型可用 `codex app-server generate-ts` 生成），不自己解析 `~/.codex` 的 sqlite / rollout 文件。HCode 进程内共用一个 app-server 子进程。

| 功能 | 协议方法 |
|---|---|
| 会话列表 | `thread/list`（分页，sourceKinds = cli / vscode / exec / appServer，`useStateDbOnly`）|
| 历史内容 | `thread/turns/list`（itemsView=full，升序分页；`thread/read includeTurns` 已废弃）|
| 新建 / 续聊 | `thread/start` / `thread/resume`（excludeTurns）+ `turn/start` |
| 停止 | `turn/interrupt` |
| 重命名 | `thread/name/set` |
| 模型列表 | `model/list` |
| 流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta`、`turn/plan/updated`、`turn/completed` |
| 审批 | 服务端请求 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput` |

## 代码结构
- `src/main/agents/types.ts`：`AgentProvider` 接口，每个 CLI 实现一个；`registry.ts` 按 agent / sessionKey / interactionId 路由。
- `src/main/agents/rowProjectorBase.ts`：从 v1 的 Claude 投影器抽出的公共部分（行、轮次、工具行、审批状态、增量操作）。
- `src/main/agents/codex/`
  - `appServerClient.ts`：JSON-RPC 客户端（请求/通知/服务端请求，只按 `\n` 切分）
  - `codexProjector.ts`：ThreadItem → ZCode 行
  - `codexSession.ts`：一个 thread 的实时会话与审批
  - `codexAgent.ts`：历史、会话管理、通知路由、`~/.codex/sessions` 监听
- `src/shared/agents.ts`：各 CLI 的名称、权限模式、内置模型选项（主/渲染进程共用）。

## Codex item → ZCode 卡片
| Codex item | 卡片 |
|---|---|
| agentMessage / plan | 助手正文（markdown）|
| reasoning（summary）| 思考块 |
| commandExecution | 按 commandActions：单个 read → Read 卡；search → Grep 卡；其余 → Bash 卡（去掉 `/bin/zsh -lc` 外壳）|
| fileChange | ApplyPatch 卡，unified diff 解析为 `file_diffs` 展示（多文件 diff）|
| mcpToolCall | `mcp__server__tool` |
| webSearch | WebSearch 卡 |
| turn/plan/updated | TodoWrite 卡（每轮一张，原地更新）|
| contextCompaction | “上下文已压缩”分隔 |

## 权限模式（HCode → codex）
| HCode | approvalPolicy | sandbox |
|---|---|---|
| 自动（工作区）默认 | on-request | workspace-write |
| 逐条审批 | untrusted | workspace-write |
| 只读 | on-request | read-only |
| 完全放行 | never | danger-full-access |

会话中途切换模式时，通过下一次 `turn/start` 的 `approvalPolicy` + `sandboxPolicy` 生效。

审批决定映射：允许 → `accept`，本会话总是允许 → `acceptForSession`，拒绝 → `decline`（拒绝并停止 → `cancel`）。

## 界面变化
- 侧边栏会话行、会话头部显示 CLI 徽标（C = Claude Code，X = Codex）；同一项目下两种会话混排。
- 新会话（还没发送时）可在输入框左下角切换 CLI；项目菜单可直接“新建 Claude Code / Codex 会话”。
- 权限模式与模型下拉按 CLI 切换；Codex 模型列表来自 `model/list`。
- 设置页：新会话默认 CLI；每个 CLI 的默认权限模式、默认模型、可执行文件路径。
- 设置文件从 v1 结构自动迁移（`claudePath` 等 → `agentPaths.claude` 等）。

## 实测（本机 codex-cli 0.155.1）
- 列出 1370 个 Codex 会话（211 个项目）约 0.4 秒；抽样 60 个会话投影 2486 行，0 个 schema 错误。
- 新建 Codex 会话、逐条审批模式下命令审批卡片 → 允许 → 执行；拒绝后命令未执行。
- 续聊 Codex 历史会话，apply_patch 修改文件，diff 卡片正确显示。
- Esc 停止 Codex 生成；会话中途切换权限模式在下一轮生效。
- Claude Code 回归：新建会话、读取文件正常。
- 修复：开发版与正式版同时运行时单实例锁冲突（userData 切换移到申请锁之前）；新建会话后列表未刷新（改为每轮结束刷新，并防止进行中的旧列表覆盖缓存）。

## 发布
- 版本号 0.2.0，安装包 `release/HCode-0.2.0-arm64.dmg`（本地未签名）；打包版在最小环境变量下启动实测可同时识别 claude 与 codex。

## 未做 / 已知限制
- Codex 子 agent（collab）只显示为一张 Agent 卡，不展开内部过程。
- `item/tool/requestUserInput`（Codex 提问）已接入问答卡片，但未在实测中触发。
- 图片输入仍不支持。
