# HCode 开发方案（v1：仅支持 Claude Code CLI）

> 本计划批准后执行的第一个动作：把本文件原样保存为 `/Users/hwj/my/mac/code/hcode/docs/HCode-v1-方案.md`（同时 `git init` hcode 目录）。之后按照下文“实施阶段”开发。


## 0. 实施状态（2026-09-23）

v1 已按本方案实现并实测通过：历史浏览、新建会话、续聊、流式输出、停止、审批（允许 / 本会话允许 / 拒绝）、深浅主题，以及 dmg 打包后在最小环境下启动。与方案有出入的地方如下。

| 方案原写法 | 实际实现 | 原因 |
|---|---|---|
| 复制 ZCode 的 claude-native JSONL 解析器 | 改用 SDK 0.3.280 自带的 `listSessions()` / `getSessionMessages()` / `renameSession()` | 官方实现已处理 parentUuid 分支链；列出本机 214 个会话仅需约 150ms |
| 自写 `index-cache.json` 增量索引 | 取消，改为内存缓存，fs.watch 触发时失效 | SDK 读取已经够快 |
| SDK 作为运行时依赖 | 由 tsup 打包进 main 产物，打包时不带 node_modules | SDK 只依赖 Node 内置模块，运行时通过 `pathToClaudeCodeExecutable` 使用用户安装的 claude |
| 审批卡片基于 PermissionDialog 改造 | 直接复用 ZCode 原版 `PermissionDialog`，把请求映射成 `ZCodePermissionRequest`；AskUserQuestion 与 ExitPlanMode 用自写卡片 | 原组件已内置 Edit / Bash 预览与键盘操作 |
| rowId 由主进程生成 key | sessionKey 由渲染进程生成并随 `chat:send` 传入 | 避免事件先于 invoke 返回时丢失 |
| — | 新增“终端运行中”检测：读取 `~/.claude/sessions/<pid>.json`，存活且 entrypoint 为 cli 的会话打标记，并在输入框上方提示冲突 | 实测时发现，续聊一个正在终端里运行的会话会让两边同时写入同一个 JSONL |
| — | 依赖版本锁定为 ZCode lockfile 中的版本（如 @pierre/diffs 1.1.22） | 避免复制来的组件遇到库 API 变化 |

**第 0 阶段结论**
- `pathToClaudeCodeExecutable` 可以直接指向原生 `claude` 2.1.280。
- `canUseTool` 的参数中带有 `suggestions`（例如 `setMode acceptEdits`）、`title`、`displayName`、`toolUseID`。只读命令（如 `ls`）会被 CLI 自动放行，不会触发回调。
- AskUserQuestion 的答案通过 `updatedInput.answers` 回传，形如 `{问题文本: 答案}`。
- 思考内容默认不显示，传入 `thinking: {type:"adaptive", display:"summarized"}` 后可以得到思考摘要。

---

## 1. 背景与目标

**背景**：本机装了 5 个编程 CLI（claude、codex、pi、agy、step），它们都只有终端界面。会话历史分散在各自的目录里，不方便浏览和续聊。ZCode 的桌面版界面好用，对话卡片清晰，而且源码就在 `/Users/hwj/my/mac/code/ZCode`（ZCode v3.14，Apache-2.0）。

**目标**：做一个 macOS 桌面 app，名字叫 **HCode**，界面和对话卡片都复刻 ZCode。整体规划支持 5 个 CLI；**v1 只接 Claude Code**，但架构要给另外 4 个留好扩展点。

**v1 功能范围**

| 功能 | 说明 |
|---|---|
| 项目列表 | 自动收集 Claude Code 用过的所有项目目录，也可以手动添加文件夹。支持置顶、隐藏，按最近活动排序 |
| 会话历史 | 按项目列出 Claude Code 的历史会话（包括在终端里创建的），可以打开查看完整对话。对话用 ZCode 风格的卡片展示 |
| 新建会话 | 选项目，输入问题，发送后流式显示回复 |
| 续聊 | 在任意历史会话里继续对话，底层是 `resume` |
| 停止 | 中断正在生成的回复 |
| 审批卡片 | Claude 要改文件或执行命令时，在对话中弹出“允许 / 本会话允许 / 拒绝”卡片 |
| 权限模式 | 输入框旁可选：默认（逐条审批）/ 自动接受编辑 / 计划模式 / 完全放行 |
| 自动刷新 | 在终端里用 claude 新建或更新的会话，会自动出现在列表中 |
| 主题 | 跟随系统明暗模式；界面默认中文 |

**v1 不做**（放到后续版本）：其余 4 个 CLI、图片或附件输入、子 agent 嵌套展开、终端面板、Git diff 面板、代码签名和自动更新、Windows / Linux。

---

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 桌面框架 | **Electron 41.0.3**（与 ZCode 同版本） | 能直接复用 ZCode 的 React 卡片和窗口配置 |
| UI | React 19.2.7 + TypeScript + Tailwind v4 + shadcn（radix-ui）+ lucide-react | 与 ZCode `packages/ui` 相同，复制过来的代码不用改 |
| 构建 | 渲染进程用 Vite；主进程和 preload 用 tsup；开发脚本参照 ZCode `packages/desktop/scripts/dev.mjs` 简化 | 跟 ZCode 保持一致 |
| 打包 | electron-builder（参照 `packages/desktop/electron-builder.config.js`） | 同上 |
| 状态管理 | zustand | ZCode 在用 |
| Markdown / 代码高亮 / diff | streamdown、shiki、@pierre/diffs | ZCode 卡片本身依赖这些 |
| Claude 接入 | **官方 `@anthropic-ai/claude-agent-sdk`** | 官方封装了 `claude` 的 stream-json 双向协议。提供 `canUseTool` 审批回调、`interrupt()`、`setPermissionMode()`，不用自己手写协议 |
| 读历史 | 直接读取 `~/.claude/projects/**/*.jsonl` | 这是唯一的数据源，HCode 不另存一份对话 |
| 运行环境 | Node 24.14 + pnpm 10.33.2（和 ZCode 的 `mise.toml` 一致） | |

**许可证**：ZCode 是 Apache-2.0。复制过来的文件保留原文件头；在 `hcode/NOTICE.md` 中注明来源，并附上 `ZCode/third-party/copied-components.json` 里 shadcn（MIT）和 ai-elements（Apache-2.0）的署名。

---

## 3. 总体架构

```
┌──────────────────────── Renderer（React，ZCode UI）────────────────────────┐
│ Sidebar(项目+会话) │ Header │ ConversationTimeline(卡片) │ Composer │ 审批卡片 │
│            zustand: projectsStore / sessionsStore / conversationStore      │
└──────────────▲──────────────────────────────────────────┬──────────────────┘
               │ IPC 事件（index 变化 / 行增量 / 审批请求）       │ IPC 调用
┌──────────────┴──────────────────── preload（window.hcode）─┴──────────────────┐
┌─────────────────────────────── Main（Node）─────────────────────────────────┐
│ AgentRegistry ── ClaudeAgent                                               │
│                   ├─ ClaudeHistory   读 ~/.claude/projects → 会话索引 & rows │
│                   ├─ ClaudeSession   SDK query() → rows 增量 + 审批          │
│                   └─ ClaudeRowProjector  (历史与实时共用的“Claude记录→rows”) │
│ ProjectService（合并项目 + 用户置顶/隐藏）  SessionIndexCache  FsWatcher      │
│ shellEnv（登录 shell PATH）  AppStore（~/Library/Application Support/HCode） │
└────────────────────────────────────────────────────────────────────────────┘
```

**关键设计**
1. **统一的对话数据模型**：所有对话都转换成 ZCode v4 的 `ConversationRow[]`（`ZCode/packages/shared/src/zcode-protocol-v4/rows.ts`）。行的种类包括 `turnHeader / userInput / assistantText / reasoning / toolCall / timelineMarker`。实时更新按 ZCode 的增量语义推送：结构变化用 `row.upserted` 替换整行，文本增长用 `row.delta` 追加。这样 ZCode 的时间线和卡片组件基本不用改。
2. **历史和实时共用一个投影器**：Claude JSONL 里的每条记录（`type: user/assistant`，`message` 是 Anthropic 消息格式），和 SDK 流出来的 `SDKUserMessage / SDKAssistantMessage`，格式几乎一样。所以只写一个 `ClaudeRowProjector`：历史读取时把 JSONL 记录逐条喂进去，实时对话时把 SDK 消息喂进去，再加上 `stream_event` 处理逐字输出。
3. **Agent 抽象**：定义 `AgentProvider` 接口（历史 + 会话 + 能力声明）。v1 只有 `ClaudeAgent` 一个实现，以后按同一接口加 codex、pi、step、agy。
4. **HCode 不复制对话数据**：对话内容始终以 `~/.claude` 为准。HCode 自己只存三样东西：设置、项目的置顶和隐藏状态、会话索引缓存（加快启动）。

---

## 4. 目录结构

```
hcode/
├─ package.json            # scripts: dev / build / dist / typecheck
├─ tsconfig*.json
├─ vite.config.ts          # renderer，alias "@/" → src/renderer
├─ tsup.config.ts          # main + preload
├─ electron-builder.config.js
├─ NOTICE.md  LICENSE
├─ docs/HCode-v1-方案.md
├─ scripts/dev.mjs         # 并行跑 tsup --watch、vite、electron
├─ resources/icon.icns
└─ src/
   ├─ shared/                       # 主进程与渲染进程共用（纯类型/纯函数）
   │  ├─ protocol/rows.ts           # 从 @zcode/shared 复制并裁剪：ConversationRow、ToolCallRow 等
   │  ├─ protocol/delta.ts          # RowOp：appended/upserted/delta/removed
   │  ├─ tool-identity.ts           # 复制 @zcode/shared/src/tool-identity.ts
   │  ├─ ipc.ts                     # IPC 通道名 + 请求/事件类型
   │  └─ types.ts                   # Project、SessionSummary、PermissionRequest、PermissionMode、AgentKind
   ├─ main/
   │  ├─ index.ts                   # app 生命周期、单实例、菜单
   │  ├─ window.ts                  # 复制自 desktopWindowChrome.ts / desktopWindowButtonPosition.ts
   │  ├─ shellEnv.ts                # 复制自 runtimeLoginShellEnvCapture.ts
   │  ├─ ipc.ts                     # ipcMain.handle 注册 + webContents.send 事件
   │  ├─ appStore.ts                # settings.json / projects.json / index-cache.json
   │  ├─ projects/projectService.ts
   │  ├─ agents/
   │  │  ├─ types.ts                # AgentProvider / AgentSession 接口
   │  │  ├─ registry.ts
   │  │  └─ claude/
   │  │     ├─ claudeAgent.ts       # 实现 AgentProvider
   │  │     ├─ claudeLocate.ts      # 找 claude 可执行文件 + 读取版本
   │  │     ├─ claudeHistory.ts     # 扫描/索引/加载 transcript
   │  │     ├─ jsonl.ts             # 复制自 claude-native/sessionHistoryJsonl.ts、jsonLineRecord.ts
   │  │     ├─ headParser.ts        # 复制自 claudeNativeSessionHeadParser.ts
   │  │     ├─ rowProjector.ts      # Claude 记录 / SDK 消息 → ConversationRow
   │  │     ├─ claudeSession.ts     # 包装 SDK query()：发送、流式输出、中断、审批
   │  │     └─ permission.ts        # canUseTool ↔ 审批卡片桥接
   │  └─ util/processTree.ts        # 复制自 services/src/process/processTreeTerminator.ts（兜底清理子进程）
   ├─ preload/index.ts              # contextBridge.exposeInMainWorld("hcode", api)
   └─ renderer/
      ├─ main.tsx  App.tsx  styles.css（复制 ZCode ui/src/styles.css）
      ├─ components/ui/**           # 复制 ZCode shadcn 组件
      ├─ components/ai-elements/**  # 复制 message/reasoning/code-block 等
      ├─ ToolCallBlocks/**          # 复制 ZCode 全部工具卡片
      ├─ conversation/**            # 复制 v4/ConversationShareReadonlyTimeline 及其依赖文件，改为支持实时
      ├─ permission/PermissionCard.tsx   # 基于 ZCode PermissionDialog.tsx 改造
      ├─ shell/  AppShell.tsx  Sidebar.tsx  ProjectItem.tsx  SessionItem.tsx  TopBar.tsx  Header.tsx
      ├─ composer/Composer.tsx  PermissionModeMenu.tsx  ModelMenu.tsx
      ├─ settings/SettingsDialog.tsx
      ├─ store/  projectsStore.ts  sessionsStore.ts  conversationStore.ts  settingsStore.ts
      ├─ i18n/  IntlProvider.tsx（复制） zh-CN.ts en-US.ts（从 ZCode 语言包中按需摘取）
      └─ lib/**                     # 被复制组件依赖的工具函数（path、fileDisplay、imeComposition 等）
```

---

## 5. ZCode 代码复用清单

下面的路径都相对于 `/Users/hwj/my/mac/code/ZCode/packages/`。

### 5.1 原样复制（只改 import 路径）
| 来源 | 用途 |
|---|---|
| `ui/src/styles.css` | 全部设计 token、zai-light / zai-dark 主题、`text-ui-*` 字号体系 |
| `ui/src/components/ui/*`、`ui/src/components/lib/utils.ts` | 按钮、菜单、tooltip、collapsible、dialog、scroll-area、resizable 等 |
| `ui/src/components/ai-elements/{message,reasoning,code-block,…}.tsx` | 助手 markdown 正文、思考块、代码块 |
| `ui/src/ToolCallBlocks/**` | 工具卡片：`ToolLayout`、`ToolSummaryRow`；renderers 包括 edit（行内 diff）、execute（bash）、read、search、todo、fallback、changes-group |
| `ui/src/components/ui/diff-viewer.tsx` | 完整 diff 视图 |
| `ui/src/v4/ConversationShareReadonlyTimeline.tsx` 及其依赖：`ConversationUserInputBody/Content.tsx`、`conversationTurnRenderUnits.ts`、`conversationTurnFlowItems.ts`、`conversationTurnWorkSegments.ts`、`conversationAssistantWorkItems.ts`、`conversationWorkDuration.ts`、`toolCallRowAdapter.ts` | 对话时间线：按轮分组、把工具调用折叠成“探索 / 执行 / 变更”组 |
| `ui/src/lib/{toolIdentity,toolCallTree,taskChatMessageTypes,path,fileDisplay,codeViewer,codePreviewSettings,imeComposition,permissionRequest}.ts` | 卡片依赖的工具函数 |
| `ui/src/i18n/IntlProvider.tsx` | 国际化 |
| `shared/src/zcode-protocol-v4/{rows,toolDisplay,core}.ts`、`shared/src/tool-identity.ts`、`shared/src/execution-output-preview.ts` | 行类型和工具族映射 |
| `desktop/src/main/desktopWindowChrome.ts`（`buildDesktopWindowVisualOptions`）、`desktopWindowButtonPosition.ts` | macOS 窗口：`titleBarStyle:"hidden"`、红绿灯位置 `{x:22,y:23}`、`vibrancy:"under-window"` |
| `services/src/runtime-tools/runtimeLoginShellEnvCapture.ts` | 从 Finder 启动的 GUI app 拿不到 shell 里的 PATH，靠它找到 `~/.local/bin/claude` |
| `services/src/process/processTreeTerminator.ts` | 退出时兜底清理 claude 子进程 |
| `services/src/session/claude-native/{sessionHistoryJsonl,jsonLineRecord,claudeNativeSessionHeadParser}.ts` | 读取 JSONL，解析会话头部信息（cwd、标题、sidechain 判断） |

复制是按 import 依赖一层层拉进来的。遇到 `@zcode/services`、`@zcode/rpc` 或 ZCode 业务 store 时就停，改成下面 5.2 的写法。

### 5.2 复制后需要解耦的地方
| 位置 | 原依赖 | 改法 |
|---|---|---|
| `ToolCallBlocks/ToolCallBody.tsx` | `useServices().fileService` | 改为 `window.hcode.fs.readFile`（只读，用于展开查看文件） |
| `ai-elements/message.tsx` | `useZCodeStore`、`usePlatform` | 改用 HCode 的 `settingsStore`，点击文件链接走 `window.hcode.app.openPath` |
| `ToolCallBlocks/renderers/agent.tsx` | 子 agent store | v1 显示为普通卡片：展示 Task 的 prompt 和最终结果 |
| `OpenSplitButton.tsx`、`pluginReferenceIconContext` | ZCode 平台服务 | 换成空实现或简化版 |
| `useTheme.ts` | ZCode settingService | 改为 `matchMedia('(prefers-color-scheme: dark)')` 加手动切换 |
| 所有 `useZCodeIntl` | IntlProvider | 保留；语言包只摘取用到的 key |

### 5.3 照着重写（复制 JSX 结构和 Tailwind class，数据改用 HCode store）
- `ui/src/DesktopWindowFrame.tsx`、`DesktopTopOverlay.tsx`：窗口框架、顶栏（给红绿灯留出位置、侧边栏开关、新建按钮）
- `ui/src/WorkspaceSidebar.tsx`、`WorkspaceSidebarItem.tsx`、`TaskListItem.tsx`、`NewTaskButtonGroup.tsx`：侧边栏、项目行、会话行、新建按钮
- `ui/src/WorkspaceHeader.tsx`：会话头部（项目名、会话标题）
- `ui/src/prompt-editor/ChatPromptEditor.tsx`：输入框外观（`rounded-2xl bg-input`）。编辑器用普通 `textarea` 自动增高，不引入 lexical
- `ui/src/PermissionDialog.tsx`：审批卡片，里面嵌入了 Edit / Execute 预览
- 设计规范严格遵守 `ZCode/DESIGN.md`：只用语义色 token；字号只用 `text-ui-*`；最外层容器 `rounded-xl`，每往里一层圆角降一级；按钮 `rounded-lg`；层次感靠背景明暗区分，不靠阴影。

---

## 6. Claude Code 接入细节

### 6.1 找到 CLI（`claudeLocate.ts`）
1. 如果设置里填了自定义路径，就用它。
2. 否则用 `shellEnv` 取得登录 shell 的 PATH，在其中查找 `claude`（本机位于 `~/.local/bin/claude`，是指向 `~/.local/share/claude/versions/2.1.280` 的符号链接）。
3. 执行 `claude --version` 取得版本号。找不到时，界面显示引导页，提示安装方法和手动指定路径的入口。

### 6.2 历史索引（`claudeHistory.ts`）

**数据源**：`~/.claude/projects/<编码后的cwd>/<sessionId>.jsonl`
- 目录名是有损编码（`/`、`.` 和非 ASCII 字符都被替换成 `-`），**不能**从目录名还原真实路径，要读记录里的 `cwd` 字段。
- 跳过 `<sessionId>/subagents/` 目录，以及 `isSidechain: true` 的文件。

**扫描流程**
1. 列出所有 `*.jsonl`，读取每个文件的 `mtime` 和 `size`。
2. 对照 `index-cache.json`，以 `path + mtime + size` 为键，只重新解析变化过的文件。
3. 解析时按行流式读取（不把整个文件读进内存），提取以下字段：
   - `sessionId`：取文件名
   - `cwd`：取第一条带 cwd 的记录
   - `gitBranch`
   - `createdAt`：第一条记录的 `timestamp`
   - `updatedAt`：取最后一条记录的 `timestamp`，没有就用 mtime
   - `title`：优先级为 最后一条 `custom-title.customTitle` → 最后一条 `ai-title.aiTitle` → `summary` → 第一条真实用户消息的前 60 个字符
   - `firstPrompt`、`messageCount`
4. 过滤掉没有真实用户消息的会话。以下不算真实用户消息：`isMeta`、只有 `tool_result` 的消息，以及 `<command-name>`、`<local-command-stdout>` 这类命令包装文本。
5. 按 `cwd` 分组得到项目，按 `updatedAt` 倒序排列。
6. 辅助数据源：`~/.claude/sessions/<pid>.json` 记录了正在运行的终端会话（`sessionId`、`cwd`），用来在会话行上标出“终端运行中”。

**监听**：用 `fs.watch(~/.claude/projects, { recursive: true })`（macOS 支持递归监听），300ms 防抖后增量更新索引，再推送 `sessions.indexChanged` 事件。

### 6.3 读取对话内容（`loadTranscript(sessionId)`）
1. 流式读取整个 JSONL，只保留 `type` 为 `user`、`assistant`、`system`（部分子类型）的记录。
2. **只保留当前分支**：记录之间通过 `uuid / parentUuid` 构成树（回退或编辑会产生分叉）。取最后一条消息记录，沿 `parentUuid` 往回走到根节点，得到当前可见的链。
3. 按时间顺序把这条链喂给 `ClaudeRowProjector`，输出 `ConversationRow[]`。
4. 大文件（>20MB）先只返回最后 N 轮，界面上提供“加载更早”（v1 可以先整体加载，同时记录耗时）。

### 6.4 ClaudeRowProjector（历史与实时共用）

**输入**有三类：Claude JSONL 记录 / SDK 消息（`user`、`assistant`）、SDK 的 `stream_event`（逐字输出）、SDK 的 `result` 和 `system`（init、compact_boundary）。
**输出**：增量操作 `RowOp[]`（历史读取时一次性累积成 rows 数组）。

| Claude 数据 | 生成的 Row |
|---|---|
| user 消息，内容为字符串或 `text` 块（真实输入） | 新建一轮：`turnHeader{origin:"userInput", state}` 加 `userInput{origin:"realUser", text}` |
| user 消息中的 `<command-name>/xxx</command-name>` 包装 | 一行简短的 `userInput`，显示为“/xxx 命令” |
| assistant 消息里的 `thinking` 块 | `reasoning{text, state}` |
| assistant 消息里的 `text` 块 | `assistantText{text, state, model}` |
| assistant 消息里的 `tool_use` 块 | `toolCall{toolCallId:id, toolName:name, input, inputText:JSON.stringify(input), status:"running"}` |
| user 消息里的 `tool_result` 块（按 `tool_use_id` 找到对应工具行） | 对应 toolCall 行做 upsert：`status` 为 success，或 error（当 `is_error` 为真）；`output` 按 `toolDisplay.ts` 的 `toolOutputSchema` 构造，文本超长时截断 |
| user 消息里的 `image` 块 | v1 显示为占位文字“[图片]” |
| `system` 的 `compact_boundary` 或 `summary` | `timelineMarker`（显示“上下文已压缩”） |
| `system` 的 `api_error` | `timelineMarker`，错误样式 |
| SDK `result` | 结束当前轮的 `turnHeader`：state 为 completedSuccess / failed / completedInterrupted，写入 `endedAt`、`activeMs` |

**规则**
- 同一个 `message.id` 的多条 assistant 记录（Claude 会把多个内容块拆成多行写入）合并处理，共用同一个 `assistantResponseId`。
- `rowId` 在会话内单调递增、从不复用；`turnId` 使用那条用户记录的 `uuid`。
- 实时逐字输出（`includePartialMessages: true`）的处理：
  - 收到 `content_block_start`：新建一行 assistantText、reasoning 或 toolCall，state 设为 `streaming`（工具行设为 `inputStreaming`）。
  - 收到 `text_delta` 或 `thinking_delta`：发出 `row.delta` 追加文字。
  - 收到 `input_json_delta`：更新工具行的 `inputText`。
  - 随后到来的完整 `assistant` 消息，用 upsert 覆盖成最终内容，state 改为 `complete`。
- 工具名基本不用映射，因为 Claude 的工具名（Read / Edit / MultiEdit / Write / Bash / Grep / Glob / TodoWrite / WebFetch / WebSearch / Task / NotebookEdit / `mcp__*`）本来就是 ZCode 的 `tool-identity.ts` 能识别的。不认识的工具名走 fallback 卡片。

### 6.5 实时会话（`claudeSession.ts`，基于 Agent SDK）

**核心调用**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const input = new AsyncMessageQueue<SDKUserMessage>();     // 流式输入：同一进程里多轮对话
const q = query({
  prompt: input,
  options: {
    cwd: projectPath,
    resume: existingSessionId,                  // 续聊时传入；新会话不传
    pathToClaudeCodeExecutable: claudePath,     // 使用用户安装的 claude（共享登录状态和历史）
    env: loginShellEnv,
    permissionMode,                             // "default" | "acceptEdits" | "plan" | "bypassPermissions"
    canUseTool: permissionBridge.handle,        // 审批卡片
    includePartialMessages: true,
    settingSources: ["user", "project", "local"],               // 加载 CLAUDE.md、settings、hooks，行为和终端一致
    systemPrompt: { type: "preset", preset: "claude_code" },
    model,                                      // 不传就使用用户的默认模型
  },
});
for await (const msg of q) projector.consume(msg);  // → RowOp[] → IPC 推给渲染进程
```

**生命周期**
- **新建**：用户第一次发送时创建 `ClaudeSession`。收到 `system/init` 后拿到 `session_id`，触发 `session.created` 事件，侧边栏立刻插入这条会话（标题先用第一句提问，之后被 ai-title 覆盖）。
- **多轮**：同一个 query 保持存活，后续发送只需 `input.push(userMessage)`。
- **续聊历史会话**：界面先显示从 JSONL 读出的 rows；发送时用 `resume: sessionId` 创建 query，新的 rows 接在后面，`rowId` 从现有最大值继续递增。
- **停止**：调用 `q.interrupt()`。当前轮的 turnHeader 标为 `completedInterrupted`，所有 running 的工具行标为 `cancelled`。
- **空闲回收**：10 分钟没有活动就结束输入队列、关闭进程；下次发送时自动用 `resume` 重建。
- **并发**：允许多个会话同时运行，每个会话一个子进程。侧边栏会话行显示“运行中”转圈和“待审批”角标。
- **退出 app**：关闭所有 query；3 秒后仍未退出的，用 `terminateProcessTree` 强制清理。
- **错误**：进程异常退出或 SDK 抛错时，写一条错误 `timelineMarker`，把 stderr 摘要放进可展开区域，并在输入框上方提示“重试”。

### 6.6 审批卡片（`permission.ts` + `PermissionCard.tsx`）

**流程**
1. SDK 调用 `canUseTool(toolName, input, { signal, suggestions })`。
2. 主进程生成 `interactionId`，把对应 toolCall 行改为 `status:"pendingApproval", approvalInteractionId`，同时推送 `permission.requested { sessionKey, interactionId, toolName, input, suggestions }`。
3. 渲染进程在该工具卡片位置显示审批卡片，外观照 ZCode `PermissionDialog`：Edit / Write 显示 diff 预览，Bash 显示命令和说明。按钮如下：
   - **允许**：返回 `{ behavior: "allow", updatedInput: input }`。
   - **本会话总是允许**：返回 `{ behavior: "allow", updatedInput: input, updatedPermissions: suggestions }`，其中 suggestions 的 destination 改为 session。
   - **拒绝**：返回 `{ behavior: "deny", message: 用户填写的原因 || "用户拒绝" }`，可选“拒绝并停止”（`interrupt: true`）。
4. `signal` 被中止（用户点了停止）时，关闭卡片，工具行标为 `cancelled`。
5. 支持快捷键：`⌘↩` 允许，`⎋` 拒绝。

**特殊工具**（同样走 `canUseTool`）
- **`ExitPlanMode`**：卡片显示计划的 markdown，按钮是“批准计划并开始执行”和“继续规划”。批准后调用 `q.setPermissionMode("acceptEdits" | "default")`。
- **`AskUserQuestion`**：显示为选项卡片，用户选择后通过 `updatedInput` 回传答案。具体回传格式在第 0 阶段用 SDK 实测确认；如果不支持，v1 就把它当普通审批处理。

**权限模式切换**：输入框旁的下拉菜单改动时，调用 `q.setPermissionMode(mode)`；还没有启动的会话，在创建时传入。默认值为“默认（逐条审批）”，可在设置里修改。

### 6.7 模型选择
下拉菜单项为“默认 / Opus / Sonnet / Haiku”（对应 CLI 的别名）。query 建立后，如果 SDK 支持 `supportedModels()`，就用它返回的列表。切换时调用 `q.setModel()`。

---

## 7. IPC 接口（`src/shared/ipc.ts`，preload 暴露为 `window.hcode`）

```ts
// 调用（ipcRenderer.invoke）
agent.status(): { claude: { found: boolean; path?: string; version?: string } }
projects.list(): Project[]                      // {path, name, lastActiveAt, sessionCount, pinned, hidden, exists}
projects.add(): Project | null                  // 弹出 showOpenDialog 选择文件夹
projects.setPinned(path, bool) / setHidden(path, bool)
sessions.list(projectPath): SessionSummary[]    // {id, agent:"claude", title, createdAt, updatedAt, gitBranch, runningInTerminal}
sessions.load(sessionId): { rows: ConversationRow[]; meta }
sessions.rename(sessionId, title)               // 以 custom-title 记录追加写入 JSONL，与 CLI 的 /rename 行为一致（第 0 阶段确认格式）
chat.send({ sessionKey?, sessionId?, projectPath, text, permissionMode, model }): { sessionKey }
chat.interrupt(sessionKey)
chat.setPermissionMode(sessionKey, mode) / chat.setModel(sessionKey, model)
permission.respond(interactionId, { decision: "allow"|"allowSession"|"deny"|"denyAndStop", message?, updatedInput? })
fs.readFile(path, { maxBytes })                 // 卡片里展开查看文件时用
app.openPath(path) / app.showInFinder(path) / app.openInTerminal(cwd, sessionId)  // 用 Terminal.app 执行 claude --resume
settings.get() / settings.set(patch)            // 主题、字号、claude 路径、默认权限模式、语言

// 事件（webContents.send → ipcRenderer.on）
sessions.indexChanged { projectPaths[] }
chat.rows { sessionKey, sessionId?, ops: RowOp[] }        // 按 16ms 合批发送，避免 IPC 过于频繁
chat.state { sessionKey, state: "idle"|"running"|"awaitingApproval"|"error", error? }
chat.sessionCreated { sessionKey, sessionId, projectPath }
permission.requested / permission.resolved
```

---

## 8. UI 设计（照 ZCode）

**窗口**：采用隐藏标题栏加 vibrancy 毛玻璃效果。最小尺寸 960×600，记住上次的窗口大小和位置。

**侧边栏**（宽 260px，可拖动调整，可收起为窄条）
- 顶部：留出红绿灯的位置，放折叠按钮和“新建会话”按钮（`⌘N`）。
- 搜索框：按标题过滤会话（`⌘K` 聚焦）。
- 项目列表：每行显示文件夹图标、项目名（目录名，悬停时显示完整路径）和会话数，可展开或折叠。每个项目默认显示最近 10 条会话，底部有“显示更多”。
  - 右键菜单：新建会话、在 Finder 中显示、在终端中打开、置顶或取消置顶、从列表隐藏。
  - 目录已经不存在的项目显示为灰色。
- 会话行：显示标题、相对时间（如“3 小时前”），以及“运行中 / 待审批 / 终端运行中”的状态标记。
  - 右键菜单：重命名、复制会话 ID、在终端中继续（`claude --resume <id>`）。
- 底部：设置入口、Claude CLI 状态（版本号；未找到时显示红点）。

**主区域**
- 头部：项目名 / 会话标题、git 分支、权限模式标签。
- 时间线：用户消息显示为气泡；助手正文是 markdown；思考块可折叠；工具调用用卡片，连续的读取和搜索会自动折叠成“探索了 N 个文件”这样的组；每轮结束显示耗时。新内容到达时自动滚到底部（手动上翻时停止自动滚动）。
- 输入框：`rounded-2xl`，支持多行和自动增高；`↩` 发送、`⇧↩` 换行，输入法组字时按回车不会误发送。下方工具栏有权限模式、模型、停止/发送按钮。
- 空状态：没有选中会话时，显示“选择项目，开始新会话”，以及最近项目的快捷入口。

**设置**（`⌘,`）：主题（系统 / 浅色 / 深色）、界面字号、Claude 路径、默认权限模式、语言。

---

## 9. 实施阶段与验收

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **0. 验证**（约 0.5 天） | 在 scratchpad 里写 SDK 小脚本实测：① `pathToClaudeCodeExecutable` 能否指向本机原生 claude 2.1.280（不行就用 SDK 内置的 CLI，登录和历史都共享 `~/.claude`，影响不大）；② `canUseTool` 的参数、`suggestions` 的结构；③ `stream_event` 的事件序列；④ AskUserQuestion 和 ExitPlanMode 的回传格式；⑤ `custom-title` 记录格式。把真实 SDK 输出和几份本机 JSONL 存为样本 | 形成结论，修正第 6 节 |
| **1. 脚手架 + UI 复刻**（约 2 天） | 建工程；复制第 5 节的代码并解耦；用样本 rows 渲染时间线 | `pnpm dev` 能打开窗口；样本对话的卡片（diff、bash、read、todo、thinking）效果与 ZCode 一致；明暗主题正常 |
| **2. 历史**（约 2 天） | claudeLocate、shellEnv、claudeHistory、rowProjector（历史部分）、侧边栏、只读对话页、fs.watch | 能列出本机全部 38 个 Claude 项目及其会话；打开任意历史会话都能正确显示；在终端新建的会话会自动出现 |
| **3. 实时会话**（约 2–3 天） | claudeSession、流式投影、输入框、新建 / 续聊 / 停止、多会话并发、错误处理 | 新建会话后回复逐字显示；续聊能接上上下文；点停止能立即中断；重启 app 后会话仍能打开和续聊 |
| **4. 审批**（约 1.5 天） | permission bridge、审批卡片、权限模式切换、ExitPlanMode / AskUserQuestion | 默认模式下写文件和执行命令都会弹出卡片；允许、本会话允许、拒绝都生效；计划模式能批准执行 |
| **5. 打磨与打包**（约 1 天） | 快捷键、右键菜单、设置页、窗口状态记忆、electron-builder 打包 dmg（arm64，本地不签名） | 打出的 `.app` 从 Finder 启动能找到 claude，完整走通上述所有流程 |

## 10. 端到端验证清单（手动）
1. 从 Finder 启动打包后的 HCode，底部状态显示 claude 2.1.280。
2. 侧边栏的项目数与 `~/.claude/projects` 中实际的 cwd 数量一致；中文路径的项目名显示正确。
3. 打开一条包含 Edit、Bash、TodoWrite、thinking 的历史会话，逐一核对卡片展示。
4. 新建临时目录 `/tmp/hcode-test`，添加为项目，在默认模式下新建会话，发送“创建 hello.txt 写入 hi，然后运行 ls”：
   - 先后出现 Write 和 Bash 两张审批卡片，允许后显示 diff 卡片和 bash 输出卡片；
   - 在终端执行 `claude --resume <id>` 能看到同一段对话。
5. 再发送“删除 hello.txt”并点“拒绝”，Claude 收到拒绝原因并作出回应。
6. 发一个耗时较长的任务，中途点停止，状态恢复为空闲，可以继续对话。
7. 在终端里另开一个 claude 会话并聊一句，几秒内 HCode 侧边栏出现这条会话。
8. 同时运行两个会话，互不串流。
9. 退出 HCode 后，用 `ps aux | grep claude` 确认没有残留的子进程。

测试策略：遵循“避免不必要测试”的原则。只给 `rowProjector` 写少量样本比对（输入样本 JSONL，检查输出 rows 的快照），因为它是最容易出错且最难靠肉眼发现问题的环节。其他部分按上面的清单手动验证。

---

## 11. 风险与对策
| 风险 | 对策 |
|---|---|
| SDK 版本与本机 claude 版本不兼容 | 第 0 阶段实测；不兼容时退回 SDK 内置 CLI，或固定一个兼容的 SDK 版本 |
| 复制 ZCode 组件时依赖一路牵连，越拉越多 | 以 ReadonlyTimeline 为边界逐层复制，遇到 services 或 store 就换成简化实现；ZCode 专属的卡片（workflow、cua、plugin）不复制 |
| JSONL 格式随 Claude 版本变化 | 投影器遇到未知类型一律忽略、不报错；样本比对覆盖常见记录 |
| 超长会话渲染卡顿 | v1 的只读时间线不做虚拟滚动；超过 500 行时改用 ZCode 的 `ConversationTimeline.tsx`（`@tanstack/react-virtual`） |
| GUI 进程拿不到 PATH 和代理等环境变量 | 用 shellEnv 捕获登录 shell 的完整环境，传给 SDK 的 `env` |
| 与终端里同时续聊同一会话 | 会话行显示“终端运行中”提示；发送前给出确认提示 |

---

## 12. 后续版本路线（其余 4 个 CLI，调研结论备查）

> **更新（v2，2026-09-24）**：Codex 已接入，实际方案与下表不同——历史与会话都改走官方 `codex app-server` 协议（`thread/list`、`thread/turns/list`、`turn/start`、审批请求），不直接读取 sqlite / rollout 文件。详见 `docs/HCode-v2-Codex.md`。

所有 CLI 都按 `AgentProvider` 接口接入，并投影成同样的 `ConversationRow`。

| CLI | 项目/会话列表 | 对话内容 | 实时驱动 | 审批 |
|---|---|---|---|---|
| Codex 0.155 | 只读打开 `~/.codex/state_5.sqlite` 的 `threads` 表（cwd、title、updated_at_ms、archived、rollout_path；WAL 模式） | rollout JSONL：`event_msg` 中的 user_message、agent_message、`item_completed`（CommandExecution / FileChange / McpToolCall / Reasoning） | `codex app-server --listen stdio://`（JSON-RPC；类型用 `codex app-server generate-ts` 生成） | app-server 发来的命令和文件修改审批请求 |
| pi 0.84 | `~/.pi/agent/sessions/--<cwd>--/*.jsonl`，首行 `session` 含 id 和 cwd | JSONL v3 是树结构，沿 `parentId` 回溯出当前分支 | `pi --mode rpc`（按行切分只认 `\n`） | 附带一个 pi 扩展，在 `tool_call` 时调用 `ctx.ui.confirm`，经 RPC 以 `extension_ui_request` 转发 |
| StepCode 0.1 | pi 的 fork，格式相同，目录为 `~/.stepcode/agent/sessions` | 同 pi | 同 pi，另加 `--approval-mode confirm` | 验证 approval-mode 或 `--sdk-stdio` 的 permission-callback |
| agy 1.2.9 | `~/.gemini/antigravity-cli/conversation_summaries.db` 与 `history.jsonl` 取并集 | 对话存成 protobuf，难以解析：HCode 自己创建的会话缓存流事件；其他会话只显示用户提问 | `agy -p --output-format stream-json --input-format stream-json --conversation <id>` | 待验证；不支持时用模式开关代替 |
