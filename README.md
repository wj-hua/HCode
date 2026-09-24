# HCode

macOS 桌面版编程助手工作台，界面与对话卡片复刻 [ZCode](../ZCode)。支持 **Claude Code**、**Codex**、**StepCode** 与 **Antigravity** 四个 CLI（同一套界面，会话按项目混排）：

- 项目列表：手动添加、置顶或移除项目文件夹；根据各 CLI 的会话统计已添加项目的会话数和最近活动时间
- 会话历史：按已添加的项目列出各 CLI 的历史会话（包括终端里创建的），用 ZCode 卡片查看完整对话
- 新建会话 / 续聊历史会话，流式输出，随时停止（Esc）
- 附件输入：可粘贴、拖入或选择图片、视频、文档、APK 等文件；图片按各 CLI 的原生图片输入发送，其他文件将本地路径提供给 CLI 读取，发送后显示文件卡片（图片显示缩略图）
- 审批卡片：Claude Code、Codex、StepCode 的工具审批与提问；Antigravity 无头模式不能交互审批，需要确认的操作会自动拒绝
- 按 CLI 提供各自支持的权限模式与模型切换
- 已添加项目中，终端新建或更新的会话会自动刷新；Claude Code 正在终端运行的会话会提示冲突风险

## 使用

需要 Node 24+、pnpm 10+，以及已登录的 `claude`、`codex`、`step`、`agy` 中至少一个命令（默认从登录 shell 的 PATH 查找，step 优先用 `~/.stepcode/bin/step`，可在设置里指定路径）。

```bash
pnpm install
pnpm dev          # 开发模式（Vite HMR + 主进程自动重启）
pnpm typecheck    # 类型检查
pnpm dist         # 打包 release/HCode-<版本>-arm64.dmg（本地未签名）
```

开发调试：`HCODE_CDP_PORT=9229 pnpm dev` 开启远程调试端口；`HCODE_DEBUG=1` 打印 claude 子进程 stderr。

未签名的 dmg 首次打开如被拦截：右键 HCode.app →「打开」，或执行 `xattr -dr com.apple.quarantine /Applications/HCode.app`。

## 多 CLI 兼容方式

Electron 主进程为每个 CLI 实现 `AgentProvider`，由 `AgentRegistry` 按 CLI、会话和审批请求路由。各适配器把历史记录和实时事件转换为同一套 ZCode v4 `ConversationRow`；渲染进程通过统一的 IPC 接收行增量、运行状态和审批事件，因此共用项目列表、时间线与输入框。

| CLI | 历史会话 | 实时对话 |
|---|---|---|
| Claude Code | Agent SDK 的 `listSessions` / `getSessionMessages` | Agent SDK `query()`，审批走 `canUseTool` |
| Codex | `codex app-server` 的 `thread/list` / `thread/turns/list` | 所有会话共用一个 app-server，使用 JSON-RPC 的 `thread/start` / `turn/start` 和审批请求 |
| StepCode | 读取本地会话 JSONL | 每个会话一个 `step --mode rpc` 进程，审批走 `extension_ui_request` |
| Antigravity | 读取本地 transcript 和 SQLite 元数据 | 每个会话一个 `agy` stream-json 进程；无头模式没有交互审批 |

项目列表只包含手动添加的文件夹。若某个 CLI 的历史会话属于尚未添加的目录，需先添加该项目文件夹，才能从侧边栏查看会话。

## 结构

```
src/main/        Electron 主进程
  agents/types.ts  AgentProvider 接口；registry.ts 按 CLI / 会话 / 审批路由
  agents/claude/   Claude 接入：Agent SDK（listSessions / getSessionMessages / query）
  agents/codex/    Codex 接入：codex app-server JSON-RPC（thread/list、thread/turns/list、turn/start、审批请求）
  agents/step/     StepCode 接入：读 ~/.stepcode/agent/sessions 历史；每个会话一个 `step --mode rpc` 进程
  agents/agy/      Antigravity 接入：读 ~/.gemini/antigravity-cli 的 transcript 历史；每个会话一个 `agy -p` stream-json 进程
  agents/rowProjectorBase.ts  各 CLI 投影器公共部分：把记录 / 流事件投影为 ZCode v4 ConversationRow
src/preload/     contextBridge 暴露 window.hcode（通道白名单见 src/shared/ipc.ts）
src/shared/      主/渲染进程共用类型与 IPC 契约
src/renderer/
  app/             HCode 自己的界面：外壳、侧边栏、时间线、输入框、审批卡片、设置
  zcode/           从 ZCode packages/ui/src 复制的组件（卡片、markdown、shadcn 组件、样式）
                   带 “HCode shim” 注释的文件是对 ZCode services/store 依赖的替代实现
vendor/          ZCode 的 @zcode/shared、@zcode/model-option-map 原样复制；@zcode/services 为类型桩
docs/            方案文档
```

以后接入 pi 等其他 CLI：在 `src/main/agents/` 下实现 `AgentProvider`（历史读取、会话驱动、审批），
投影成同样的 `ConversationRow`；同时扩展 `AgentKind`、默认设置和 `src/shared/agents.ts` 的描述，
在主进程注册适配器，即可复用现有界面。
方案文档：`docs/HCode-v1-方案.md`、`docs/HCode-v2-Codex.md`、`docs/HCode-v3-StepCode.md`、`docs/HCode-v4-Antigravity.md`。

## 许可

Apache-2.0。复制自 ZCode 的代码保留原许可，见 [NOTICE.md](NOTICE.md)。
