# HCode 功能规划（待办需求）

## 背景
v1–v4 与 pi 接入后，主链路已完整：5 个 CLI 的历史会话、流式对话、审批、附件、订阅额度、运行时防休眠。
本文整理下一步可加的功能，按“使用频率高、改动小”排序。每项注明现状、做法、可复用的代码和验收标准。

实现原则：优先复用 `src/renderer/zcode/` 里已复制但尚未接入的 ZCode 组件；优先用 Electron / Node 自带能力，不引入新依赖。

| 优先级 | 编号 | 功能 | 涉及 CLI |
|---|---|---|---|
| P0 | F1 | 任务完成 / 出错系统通知（已完成） | 全部 |
| P0 | F2 | 运行中排队发送（已完成） | 全部 |
| P0 | F3 | 删除 / 归档会话（已完成） | 全部（能力不同） |
| P0 | F4 | `@` 引用项目文件（已完成） | 全部 |
| P0 | F5 | `/` 斜杠命令补全（Claude、Codex 已完成） | Claude、Codex |
| P1 | F6 | 上下文用量与本轮花费 | Claude、Codex 优先 |
| P1 | F7 | 本轮改动 diff 面板 | 全部（基于 git） |
| P1 | F8 | 从某条消息分叉 / 回退 | Claude 优先 |
| P1 | F9 | 会话全文搜索 | 全部 |
| P1 | F10 | 更多快捷键 | — |
| P2 | F11 | macOS 原生菜单栏 | — |
| P2 | F12 | 新版本检查 | — |
| P2 | F13 | 同一问题多 CLI 并行对比 | 全部 |
| P2 | F14 | 导出会话为 Markdown | 全部 |
| P2 | F15 | MCP / Skills 管理 | Claude 优先 |

---

## P0

### F1 任务完成 / 出错系统通知
**现状**：只有审批请求且窗口未聚焦时 Dock 跳动（`src/main/index.ts` 的 `events.permission`）；一轮跑完或出错没有提醒。

**做法**（已实现）
- 渲染进程 `appStore` 收到 `chat:state` 时，会话由 `running` / `awaitingApproval` 变为 `idle` / `error`，
  且 `document.hasFocus()` 为 false，用 Web `Notification` 发通知；等待审批（`permission:requested`）同样通知，主进程的 Dock 跳动保留。
- 标题为“CLI 名 + 状态”，正文为会话标题（没有则项目名）+ 最后一条回复首行 / 错误信息。
- 点击通知：切到该会话，并调用新增的 `app:focusWindow` 恢复、聚焦主窗口。
- 设置里加开关 `notifyOnFinish`（默认开）。

**验收**：切到其他应用后，任务结束弹出通知；点击回到 HCode 并定位到该会话；关闭开关后不再通知。

### F2 运行中排队发送
**现状**：`Composer.tsx` 的 `submit()` 在 `running` 时直接返回，只能等本轮结束再输入发送。

**做法**（已实现）
- `appStore` 的 `Conversation` 增加 `queue: { id, text, images, files }[]` 与 `queuePaused`；运行中按 Enter 调 `enqueue` 入队，输入框清空。
- 收到 `chat:state` 由运行变为 `idle` 时 `drainQueue` 自动发送队首（此时不发“任务已完成”通知）；变为 `error` 时暂停队列（`queuePaused: "error"`），发送失败的条目放回队首。
- 输入框上方 `QueuedMessages` 显示排队条目，可移除，或“编辑”退回输入框（输入框有内容时提示先发送或清空）；暂停时显示原因与“继续”按钮。文案照 ZCode `chat.queue.*`。
- Esc 停止时保留队列并暂停（`queuePaused: "stopped"`），不自动发送；队列为空时直接发送会清除暂停状态。

**验收**：运行中连发两条，本轮结束后依次自动发送；出错后队列不继续；排队项可删除。

### F3 删除 / 归档会话
**现状**：会话只能重命名（`sessions:rename`），无法删除，侧边栏越积越多。

**做法**（已实现）
- `AgentProvider` 增加 `deleteSession(id, projectPath)`，新增 IPC `sessions:delete`；文件统一用 `shell.trashItem` 移到废纸篓（`src/main/util/trash.ts`）。
- 各 CLI：
  | CLI | 做法 |
  |---|---|
  | Claude | 与 SDK `deleteSession()` 删除的内容相同（`<id>.jsonl` 与子 agent 目录 `<id>/`），但移到废纸篓 |
  | Codex | app-server `thread/archive`（归档后 `thread/list` 默认不返回） |
  | StepCode / pi | 会话 JSONL 移到废纸篓 |
  | Antigravity | `brain/<id>`、`conversations/<id>.db*`、`annotations/<id>.pbtxt` 移到废纸篓，删除摘要库记录 |
- 会话右键菜单加“删除会话”（Codex 为“归档会话”），二次确认；删除前关闭 HCode 里已打开的活动会话并关掉对话视图。
- 正在运行（HCode 中运行 / 等待审批，或在终端中运行）的会话菜单项禁用，避免 CLI 继续写会话文件。

**验收**：删除后侧边栏与项目会话数更新；在对应 CLI 终端里也看不到该会话（Codex 为归档）；文件可从废纸篓恢复。

### F4 `@` 引用项目文件
**已实现**：输入 `@` 可搜索项目文件，用方向键和 Enter / Tab 选择；发送后在用户消息中显示文件引用。Git 项目遵守 `.gitignore`，非 Git 项目限量递归搜索。Antigravity、StepCode 会附上文件绝对路径说明。

**做法**
- 主进程新增 `fs:listProjectFiles(cwd, query)`：优先 `git ls-files`（遵守 .gitignore），非 git 目录用 `fs.readdir` 递归并限制数量。
- 输入框输入 `@` 弹出模糊匹配列表，↑↓ 选择、Enter / Tab 确认，插入 `@相对路径`；复用 mentions 的 chip 渲染。
- 发送时保持 `@路径` 文本（Claude / Codex / pi 原生识别），agy 等不识别的 CLI 转为绝对路径说明。

**验收**：输入 `@comp` 能列出 `Composer.tsx`；选择后插入路径；忽略 node_modules 等被 gitignore 的文件。

### F5 `/` 斜杠命令补全
**现状**：Claude Code 已接入项目命令和 skills 的 `/` 补全；Codex 已接入 `/compact`、`/review` 和当前项目启用的 skills。其他 CLI 尚未提供可在当前会话协议中执行的命令目录。

**做法**
- `AgentProvider` 增加可选 `listCommands(projectPath, sessionKey?, sessionId?)`，新增 IPC `agent:commands`。
- Claude：Agent SDK `Query.supportedCommands()` 获取当前项目命令和 skills，并监听 SDK 的 `commands_changed` 更新。
- Codex：app-server `skills/list` 获取当前项目启用的技能；`/compact` 调用 `thread/compact/start`，`/review` 调用 `review/start`，技能转换为 `turn/start` 的 skill 输入项。监听 `skills/changed` 刷新目录。其他终端专有命令不加入补全。
- 输入框以 `/` 开头时弹出命令列表，显示名称与说明；支持键盘和鼠标选择，填入后由用户发送。

**验收**：Claude 会话输入 `/` 能看到 `/compact`、项目自定义命令与 skills；Codex 会话能看到 `/review`、当前项目启用的 skills，已有会话还能看到 `/compact`。选择命令后可正常执行。

---

## P1

### F6 上下文用量与本轮花费
**现状**：只显示订阅额度，没有单会话的 token / 上下文占用。

**做法**
- Claude：`result` 消息的 `usage`、`total_cost_usd`；上下文占用用 `Query.getContextUsage()`。
- Codex：app-server 的 token 用量通知（接入前核实事件名）。
- StepCode / pi / agy：有则显示，无则隐藏。
- `ChatStateEvent` 增加 `usage?: { contextUsedPercent?, inputTokens?, outputTokens?, costUsd? }`。
- 输入框工具栏显示上下文占用环形图，悬停看明细；复用 `zcode/chat-input-toolbar/contextUsage.tsx`。

**验收**：Claude 会话每轮结束后更新占用百分比与花费；接近上限时颜色变化提示。

### F7 本轮改动 diff 面板
**做法**
- 每轮开始时记录 `git rev-parse HEAD` 与工作区状态；结束后用 `git diff`（含未跟踪文件 `git ls-files --others`）列出改动。
- 头部加“改动”按钮，右侧抽屉显示文件列表与 diff；复用 ZCode 卡片里已有的 diff 渲染。
- 支持单文件“在编辑器打开”（`app:openPath`）。
- 非 git 目录不显示按钮。基础代码在 `src/main/git.ts`。

**验收**：一轮修改 3 个文件后，面板列出这 3 个文件和正确的增删行。

### F8 从某条消息分叉 / 回退
**做法**
- Claude：用户消息卡片悬停出现“从这里重试”，用 `resume` + `resumeSessionAt`（`forkSession: true`）开新会话；
  可选配合 `Query.rewindFiles()` 恢复文件（需开启文件 checkpoint）。
- Codex：核实 app-server 的 fork / rollback 接口后接入。
- 其他 CLI 暂不支持，不显示按钮。

**验收**：在第 2 条消息处分叉，新会话只含前 2 轮上下文，原会话不变。

### F9 会话全文搜索
**现状**：侧边栏搜索只过滤项目名与会话标题（`Sidebar.tsx`）。

**做法**
- 主进程新增 `sessions:search(query)`：遍历各 CLI 的会话文件做文本匹配（先简单实现，不建索引），返回会话与命中片段。
- ⌘K / ⌘F 打开搜索面板，结果点击后打开会话并滚动到命中行。

**验收**：搜索某段只在对话内容里出现的文字能找到对应会话。

### F10 更多快捷键
现有：⌘, / ⌘N / ⌘B（`AppShell.tsx` 的 `useGlobalShortcuts`）。新增：
| 快捷键 | 功能 |
|---|---|
| ⌘1–9 | 切换到侧边栏第 N 个打开的会话 |
| ⌘K | 快速切换会话 / 项目（配合 F9） |
| ⌘W | 关闭当前会话视图 |
| ⌘L | 聚焦输入框 |
| ⌘⇧C | 复制最后一条回复 |

---

## P2

### F11 macOS 原生菜单栏
用 `Menu.setApplicationMenu` 建立 应用 / 文件 / 编辑 / 视图 / 窗口 菜单，快捷键在菜单中可见，编辑菜单使用系统 role。与 F10 共用同一份快捷键定义。

### F12 新版本检查
dmg 未签名，不做自动安装。启动时（每天一次）请求 GitHub Releases 最新版本，比 `app.getVersion()` 新时在设置页与侧边栏提示，点击打开下载页（`app:openExternal`）。使用 Node 自带 `fetch`。

### F13 同一问题多 CLI 并行对比
新建会话时可多选 CLI，同一消息同时发给多个 CLI，结果分栏显示。每个 CLI 仍是独立会话，只是界面并排展示。HCode 多 CLI 的独有能力。

### F14 导出会话为 Markdown
会话菜单加“导出”，把 `ConversationRow` 转为 Markdown（用户消息、回复、工具调用摘要），用 `dialog.showSaveDialog` 保存或复制到剪贴板。

### F15 MCP / Skills 管理
设置页新增页签，列出 Claude 的 MCP 服务器状态（SDK `mcpServerStatus()`）与 skills，可启用 / 停用；其他 CLI 读取各自配置文件只读展示。参考 `vendor/zcode-shared` 的 `mcp.ts`、`skills-types.ts`。

---

## 建议实施顺序
1. F1 + F3 + F2：每天都用，改动集中在主进程事件与输入框。
2. F4 + F5：输入效率，复用 ZCode 已有组件。
3. F6 + F7：可观察性。
4. 其余按需。
