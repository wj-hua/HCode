# HCode 功能规划与进度

## 背景
v1–v4 与 pi 接入后，主链路已完整：5 个 CLI 的历史会话、流式对话、审批、附件、订阅额度、运行时防休眠。
本文记录已完成的功能和后续计划，按“使用频率高、改动小”排序。每项注明当前进度、实现方式或计划，以及验收标准。

实现原则：优先复用 `src/renderer/zcode/` 里已复制但尚未接入的 ZCode 组件；优先用 Electron / Node 自带能力，不引入新依赖。

| 优先级 | 编号 | 功能 | 涉及 CLI |
|---|---|---|---|
| P0 | F1 | 任务完成 / 出错系统通知（已完成） | 全部 |
| P0 | F2 | 运行中排队发送（已完成） | 全部 |
| P0 | F3 | 删除 / 归档会话（已完成） | 全部（能力不同） |
| P0 | F4 | `@` 引用项目文件（已完成） | 全部 |
| P0 | F5 | `/` 斜杠命令补全（Claude、Codex 已完成） | Claude、Codex |
| P1 | F6 | 上下文用量与本轮花费（Claude 已完成；Codex 用量已完成） | Claude、Codex |
| P1 | F7 | 本轮改动 diff 面板（已完成） | 全部（基于 git） |
| P1 | F8 | 从某条消息分叉 / 回退（已完成） | Claude、Codex |
| P1 | F9 | 会话全文搜索 | 全部 |
| P1 | F10 | 更多快捷键（已完成） | — |
| P2 | F11 | macOS 原生菜单栏（已完成） | — |
| P2 | F12 | 新版本检查（不做） | — |
| P2 | F13 | 同一问题多 CLI 并行对比（已完成） | 全部 |
| P2 | F14 | 导出会话为 Markdown（已完成） | 全部 |
| P2 | F15 | MCP / Skills 管理（已完成） | Claude、Codex |
| P1 | F16 | 展示正在执行中的任务 | 全部 |

---

## P0

### F1 任务状态系统通知
**现状**：只有审批请求且窗口未聚焦时 Dock 跳动（`src/main/index.ts` 的 `events.permission`）；一轮跑完或出错没有提醒。

**做法**（已实现）
- 渲染进程 `appStore` 在消息发送成功时触发开始执行提示；收到 `chat:state` 时，会话由 `running` / `awaitingApproval` 变为 `idle` / `error`，
  或收到等待审批事件（`permission:requested`）时，也触发对应提示。窗口未聚焦时用 Web `Notification` 发通知，主进程的 Dock 跳动保留。
- 标题为“CLI 名 + 状态”，正文为会话标题（没有则项目名）+ 对应的任务状态、最后一条回复首行或错误信息。
- 点击通知：切到该会话，并调用新增的 `app:focusWindow` 恢复、聚焦主窗口。
- 设置里加开关 `notifyOnFinish`（默认开）；开始执行时前台只播放所选提示音，后台还发送系统通知。
- 提示音 `notificationSound`：系统（默认）/ 内置语音潇 / 自定义 / 静音。内置语音在
  `src/renderer/app/sounds/`，按开始执行、完成、出错、等待审批各一条；自定义可为四种事件分别选音频文件（`app:pickAudio`），
  由主进程 `fs:readAudio` 读出后在渲染进程播放，未选或读取失败的事件回退到系统提示音。播放 HCode 自己的提示音时通知设为 `silent`。

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
**进度**：Claude 已显示上下文占用、本轮输入 / 输出 Token 和美元估算花费；Codex 已显示上下文占用与本轮 Token。Codex 的用量通知没有美元费用，StepCode / pi / agy 目前没有接入可靠的会话用量数据，界面不显示缺失的数值。

**实现**
- Claude：每轮 `result.usage` 提供 Token；`total_cost_usd` 是累计估算费用，以相邻结果的差值计算本轮费用；`Query.getContextUsage({ detail: "summary" })` 提供上下文已用量和窗口容量。续聊旧会话时若拿不到之前的费用基线，第一轮费用隐藏。
- Codex：使用 app-server 的 `thread/tokenUsage/updated` 通知。相邻 `total` 用量的差值累计本轮 Token，首次通知用 `last`；最近一次 `last` 的输入、输出 Token 与 `modelContextWindow` 用于估算上下文占用。
- `ChatStateEvent.usage` 把用量传到会话状态。输入框工具栏的 `UsageIndicator` 复用 ZCode 的 Context 环形图和悬停面板；占用达到 75% / 90% 时分别变为警示色 / 危险色。

**范围**：只显示当前打开会话收到的实时用量；打开历史会话后，要等下一轮返回用量才会显示。费用是 CLI 的估算值，不是账单金额。

### F7 本轮改动 diff 面板
**实现**
- 每轮开始记录 HEAD 和已有未提交文件的内容；结束时比较工作区与发送前快照，包含未跟踪文件、删除文件和本轮提交的改动。大文件和二进制文件列出路径，但不显示行级预览。
- Git 项目头部显示“改动”按钮，右侧面板列出本轮文件、增删行与差异；复用 ZCode 的轻量 diff 渲染。可用系统默认应用打开单个文件。
- 结果仅在当前打开的会话中保留；重新打开历史会话后，下一轮发送才会产生新的本轮改动记录。

**验收**：一轮修改 3 个文件后，面板列出这 3 个文件和正确的增删行。

### F8 从某条消息分叉 / 回退
**实现**（已完成）
- Claude、Codex 会话（已有会话 id 且未在运行）的用户消息悬停时显示两个按钮，都会生成新会话并打开，原会话不变：
  - **从这里分叉**：新会话保留到这条消息及其回复。
  - **回退到这里**：新会话只保留这条消息之前的内容，并把这条消息（含图片、文件附件）放回输入框重新编辑；回退第一条消息时直接开空白新会话。
- `AgentProvider` 增加可选 `forkSession(params)`，新增 IPC `sessions:fork`；渲染进程传第几条用户消息和消息总数，主进程重新读取会话记录、按同一套投影逻辑定位，数量不一致时提示重新打开会话。
- 各 CLI：
  | CLI | 做法 |
  |---|---|
  | Claude | SDK `forkSession(id, { upToMessageId })` 复制记录到新会话：分叉截到本轮最后一条记录，回退截到上一轮最后一条记录 |
  | Codex | app-server `thread/fork`（`lastTurnId` 含该轮）：分叉取本轮，回退取上一轮；随后 `thread/name/set` 命名并 `thread/unsubscribe`，发送时照常 `thread/resume` |
- 新会话标题为“分叉：原标题”。
- 其他 CLI 不显示按钮（`AGENTS[kind].fork`）。

**范围**：只分叉对话上下文，不撤销文件改动（Claude 分叉会话没有文件 checkpoint；Codex `thread/revert` 也只改历史）；需要时参考 F7 的本轮改动面板手动处理。Codex 分叉出的线程在发出第一条消息前不会出现在侧边栏（`thread/list` 不返回尚无新消息的线程）。

**验收**：在第 2 条消息处分叉，新会话只含前 2 轮上下文，原会话不变；回退第 3 条消息，新会话只含前 2 轮，输入框里是第 3 条消息。

### F9 会话全文搜索
**现状**：侧边栏搜索只过滤项目名与会话标题（`Sidebar.tsx`）。

**做法**
- 主进程新增 `sessions:search(query)`：遍历各 CLI 的会话文件做文本匹配（先简单实现，不建索引），返回会话与命中片段。
- ⌘F 打开全文搜索面板，结果点击后打开会话并滚动到命中行；⌘K 用于快速切换项目与会话。

**验收**：搜索某段只在对话内容里出现的文字能找到对应会话。

### F10 更多快捷键
现有：⌘, / ⌘N / ⌘B（`AppShell.tsx` 的 `useGlobalShortcuts`）。已新增：
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
用 `Menu.setApplicationMenu` 建立 应用 / 文件 / 编辑 / 视图 / 窗口 菜单，快捷键在菜单中可见，编辑菜单使用系统 role。与 F10 共用 `src/shared/shortcuts.ts`；macOS 由原生菜单分发快捷键。

### F12 新版本检查
已决定不做。原设想：dmg 未签名不做自动安装，仅启动时请求 GitHub Releases 最新版本并提示；收益小于维护成本，用户自行到发布页下载即可。

### F13 同一问题多 CLI 并行对比
新建会话时可多选 CLI，同一消息同时发给多个 CLI，结果分栏显示。每个 CLI 仍是独立会话，只是界面并排展示。HCode 多 CLI 的独有能力。

已完成：草稿会话输入框工具条新增“对比”下拉，勾选其他 CLI 后发送，`startCompare` 为每个 CLI 建一个同项目的独立会话，共用 `compareId`，同时发送。`CompareView` 把同组会话分栏显示（每列是不带输入框的 `ConversationView`），底部共用一个输入框：发送走 `sendGroup`（空闲的立即发送，运行中的进入各自队列），停止会中断整组；点击某一列使其成为当前会话，工具条里的模型、权限模式作用于该列。注意各 CLI 在同一目录工作，同时改文件可能互相覆盖，需要时可把权限模式设为只读 / 计划。

### F14 导出会话为 Markdown
已完成：侧边栏会话右键菜单新增“导出为 Markdown…”和“复制为 Markdown”。`src/renderer/app/exportMarkdown.ts` 把 `ConversationRow` 转为 Markdown（用户消息与回复完整保留，工具调用只留一行摘要，思考过程和工具输出不导出）；保存走新增的 `app:saveText`（`dialog.showSaveDialog`），复制走 `app:copyText`。已打开的会话用界面上的行，未打开的通过 `sessions:load` 读取。

### F15 MCP / Skills 管理
已完成：设置页新增 MCP / Skills 页签，按项目切换 Claude Code / Codex。Claude 通过 SDK 读取 MCP 状态，通过原生 CLI 添加、删除服务器；项目 `.mcp.json` 服务器可在本机设置启用或停用。扫描用户、项目及插件技能；用户和项目技能通过 `skillOverrides` 按项目切换，插件技能只读。Codex 通过 app-server 读取生效配置和技能、切换用户范围 MCP 及技能，通过原生 CLI 添加、删除用户范围 MCP；项目范围 MCP 展示为只读（当前 app-server 只允许写用户配置）。

### F16 展示正在执行中的任务
**现状**：只有侧边栏每个会话前有旋转图标（`SessionItem.tsx`，`runState` 为 `running` / `awaitingApproval`）。项目折叠或会话不在列表里时看不到，也无法一眼看出全部项目里有几个任务在跑、跑了多久、谁在等审批。

**做法**：
- 侧边栏顶部（项目列表上方）新增“运行中”区块，汇总 `appStore.conversations` 中 `runState` 为 `running` / `awaitingApproval` 的会话，没有时隐藏。
- 每行显示：CLI 图标（`AgentBadge`）、会话标题（没有则项目名）、状态（运行中 / 等待审批）、已运行时长（取当前轮开始时间计时）。
- 点击跳转到该会话（复用 `openSession`）；等待审批的排在最前并用 `bg-warning` 提示。
- 对比组（`compareId`）的多个会话合并为一行，显示 “N 个 CLI 运行中”。
- 终端里正在运行的会话（`activeInTerminal`）单独用终端图标标出，不计入 HCode 任务数。
- 只读取现有渲染进程状态，不新增 IPC，也不引入依赖。

**验收**：同时在两个项目各启动一个任务，折叠项目后仍能在“运行中”看到两项；任务结束后该行消失；审批请求出现时该行置顶并变色。

---

## 后续建议顺序
1. F9：会话全文搜索。
2. F12 已取消，其余按需实施。
