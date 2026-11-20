# HCode Mac 端会话标签页开发方案

> 适用范围：HCode macOS 桌面端（`!isRemote`），远程操控 Web 页面（`isRemote === true`）保持原有单视图交互，不受本方案影响。

---

## 1. 背景与目标

### 1.1 现状分析

HCode 渲染进程状态层（`src/renderer/app/store/appStore.ts`）本身已经采用多会话并存模型：

- `conversations: Record<string, Conversation>` 保存所有已打开的会话视图，`activeViewId` 指向当前激活视图。
- 已具备 `runState`（运行中 / 等待审批 / 出错）、`backgroundTasks`、`unread`（未读蓝/红点）、按 `viewId` 隔离的草稿与附件缓存（`src/renderer/app/composer/drafts.ts`）、按 `sidePanel.viewId` 隔离的文件预览和协作面板、以及按 `projectPath` 隔离的内置终端。
- 已支持 `⌘W` 关闭当前视图、`⌘1–9` 切换已打开会话（`src/shared/shortcuts.ts`）。

但 UI 层缺少可视化标签栏，导致多会话并行时只能通过侧边栏来回查找，`⌘1–9` 也缺少直观的顺序对应。

### 1.2 核心目标

1. **会话级标签栏**：在 Mac 端主内容区 `Header` 下方新增独立标签栏，展示所有已打开会话（多 CLI 对比组合并为单个标签）。
2. **Android Studio 风格交互**：打开即固定（无覆盖式斜体预览）、底部高亮指示条、固定标签（Pin Tab）、拖拽排序、中键关闭、完整右键批量关闭菜单、右侧全部标签下拉菜单、关闭后按最近访问（MRU）回退焦点。
3. **Chrome 风格重启恢复 + 三档设置**：在设置「通用与外观」中提供「每次询问 / 不恢复 / 恢复」三档策略；选择「每次询问」时启动后弹出非阻塞恢复气泡；恢复标签采用按需懒加载，不拖慢启动速度。

### 1.3 非目标（明确边界）

- 不接入 `src/renderer/zcode/store/tabStore.ts`（该文件为 ZCode 遗留的项目级标签 store，与 HCode 会话级模型不匹配，避免双数据源同步）。
- 不做标签拖出为独立窗口（属于规划中的 F31）。
- 不把文件预览 / 侧边终端 / 协作面板塞进会话标签栏，保留现有右侧分栏布局。
- 不做 Android Studio 的“超上限自动静默关闭最旧标签”机制，避免误关带上下文或草稿的 AI 会话，改用「横向滚动 + 全部标签下拉 + 右键批量关闭」管理。

---

## 2. 整体布局与 UI 视觉规范

### 2.1 页面布局位置

标签栏放置在 `#conversation-panels` 内部、`<Header />` 正下方作为独立一行，原因如下：

- 与 Android Studio「顶部工具栏 + 下方编辑区标签栏」的视觉层级一致。
- 完整保留 `Header` 现有的项目名、Git 分支、终端/侧边终端/Finder/外部终端/刷新按钮，不挤压标签宽度。
- `Header` 继续完整承担 `app-drag` 窗口拖拽与侧栏折叠后的红绿灯避让（`pl-[84px]`），标签栏整条 `app-no-drag`，避免拖拽与点选冲突。

布局结构示意：

```text
+------------------+------------------------------------------------------------+
| Sidebar (272px)  | Header (48px, app-drag, 折叠侧栏时 pl-[84px] 避让红绿灯)      |
|                  | [CLI] Project / Title [Branch]      [Term][Side][Finder]...|
|  [RunningTasks]  +------------------------------------------------------------+
|  [Projects]      | ConversationTabBar (36px, !isRemote, app-no-drag)          |
|    - Session A   | [📌 Tab1] | [Tab2 ×] [● Tab3 ×] [Tab4 ×] ...    [+] [▾ 6]  |
|    - Session B   +------------------------------------------------------------+
|  [Conversations] | WorkspaceBody (relative flex-1 min-h-0, Portal 挂载点)      |
|                  |   +------------------------------------+-----------------+ |
|                  |   | FilePreviewLayout                  | (SidePanel /    | |
|                  |   |   ConversationView / CompareView   |  FilePreview /  | |
|                  |   |   + [Chrome 风格恢复提示浮卡(右上)] |  SideTerminal)  | |
|                  |   +------------------------------------+-----------------+ |
|                  +------------------------------------------------------------+
| [Quota] [⚙]      | TerminalPanel (可选，底部折叠/拖拽高度)                      |
+------------------+------------------------------------------------------------+
```

### 2.2 协作面板（`SidePanel`）定位修正

当前问题：`src/renderer/app/collaboration/CollaborationPanel.tsx` 将协作面板 Portal 到 `#conversation-panels`，而 `src/renderer/app/conversation/SidePanel.tsx` 第 23 行对非 docked 面板使用了硬编码 `absolute inset-y-11 right-0`。新增 36px 标签栏后，`inset-y-11`（44px）会遮挡标签栏。

改造方案：

- 在 `AppShell.tsx` 中，把 `<FilePreviewLayout>` 包裹进一个独立的 `<div id="conversation-workspace-body" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">`（位于 `<Header />` 和 `<ConversationTabBar />` 下方、`<TerminalPanel />` 上方）。
- `CollaborationPanel.tsx` 的 Portal 目标改为 `#conversation-workspace-body`。
- `SidePanel.tsx` 中非 docked 面板定位由 `absolute inset-y-11 right-0` 改为 `absolute inset-y-0 right-0`。这样无论是否展示标签栏（Mac 端 vs 远程端），协作面板都精确贴齐内容区顶部，无硬编码高度耦合。

### 2.3 标签栏与单标签样式规范

| 元素 | 规范说明 |
|---|---|
| 标签栏容器 | 高度 `h-9`（36px），底部 `border-b border-border/60`，`app-no-drag select-none`，壁纸模式下继承 `.app-reading-surface` 半透明底色 |
| 标签容器 | 横向滚动 `overflow-x-auto scrollbar-none`，支持触控板左右滑动及鼠标滚轮垂直转横向滚动（`onWheel` 映射 `deltaY` → `scrollLeft`） |
| 单个标签 | `h-9 min-w-[100px] max-w-[200px] shrink-0 px-2.5`，固定标签可更紧凑（`min-w-[84px] max-w-[160px]`）；鼠标悬停 `hover:bg-surface-hover/70` |
| 激活指示 | Android Studio New UI 风格：底部 `2px` 品牌/主题色高亮条（`bg-primary`）+ 文字 `text-foreground font-medium` + 轻微背景区分 |
| 非激活态 | 文字 `text-foreground-subtle`，鼠标移入变深 |
| 左侧图标区 | 固定标签优先显示小图钉图标 `PinIcon`（`size-3`）；随后显示 `AgentBadge`（对比组显示多个重叠/并排小 `AgentBadge`） |
| 标题文本 | 单行 `truncate text-ui-sm`；取 `presentationTitle` 后的展示标题；悬停 `title` 或 Tooltip 显示完整标题、项目名、CLI 名称与分支 |
| 重名消歧 | 当同时打开多个同名标题（如多个「新会话」）且属于不同项目时，在标题旁追加灰色短项目名后缀（如 `新会话 · hcode`） |
| 状态指示 | 按优先级显示单个状态位：① 等待审批：黄色圆点 `bg-warning`；② 运行中或存在原生后台任务：`LoaderIcon animate-spin`；③ 未读出错：红点 `bg-destructive`；④ 未读完成：蓝点 `bg-primary` |
| 关闭按钮 | 固定标签不显示 `×`（防止误关，右键或取消固定后关闭）；普通标签激活态常显，非激活态 `opacity-0 group-hover:opacity-100`；尺寸 `size-4` 圆角微悬停态 |
| 右侧操作区 | 固定在标签栏最右，带左侧微渐变遮罩或细竖线分隔：① `+` 新建会话按钮（`title="新建会话 (⌘T)"`）；② 下拉列表按钮（`ChevronDownIcon` + 已开数量，点击展开全部已打开标签的 `DropdownMenu`，当前项带勾选、固定项带图钉、运行中带状态点，溢出或超过 1 个标签时常显） |
| 固定区与普通区 | 固定标签始终排在最左侧；当同时存在固定标签与普通标签时，两者之间渲染一条 `1px` 高 `h-4 bg-border/80` 的垂直分隔线 |

---

## 3. 核心交互规范（Android Studio 风格）

### 3.1 标签模型与身份标识

为兼容单会话与多 CLI 对比组，引入统一的**标签键（`tabKey`）**：

- 普通会话：`tabKey = conv.viewId`
- 多 CLI 对比组：`tabKey = "compare:" + conv.compareId`（整组多个 `Conversation` 聚合为一个标签，点击该标签切回该对比组上次激活的列，默认第一列）

### 3.2 打开与去重规则

1. **点击侧边栏会话 / 全文搜索 / 快速切换（`⌘K`）/ 悬浮窗 / 系统通知**：
   - 若该会话已在标签栏打开：直接激活对应标签，并将其平滑滚动到标签栏可视区域内（`scrollIntoView({ inline: "nearest", block: "nearest" })`）。
   - 若未打开：按 Android Studio 默认行为直接作为**正式标签**打开（不覆盖上一个标签）。
   - **新标签插入位置**：插入到**普通标签区末尾**（即所有已开普通标签之后；如后续需支持“插入当前标签右侧”，只需改一处纯函数，首版按末尾追加更符合从左到右的时间直觉）。
2. **点击标签栏 `+` 按钮（或 `⌘T` / `⌘N`）**：
   - 目标项目路径：取当前激活会话的 `projectPath`；无激活会话时取第一个非 `conversation` 项目；若无项目则调用 `workOutsideProject(true)`。
   - **与现有 `newChat` 草稿复用的衔接**：现有 `newChat(projectPath)` 若同项目已有空白草稿会直接复用。
     - 侧边栏项目上的新建按钮与 `⌘N`：沿用现有逻辑，或与 `+` 保持一致。
     - 标签栏 `+` 按钮：为满足用户“想在同项目再开一个空白标签”的直觉，建议 `newChat(projectPath, agentOverride, { forceNew?: boolean })` 支持 `forceNew: true`——点标签栏 `+` 时若当前激活标签**不是**该项目的空白草稿则复用已有空白草稿，若当前**已经是**该项目的空白草稿则直接新建一个新空白草稿标签（避免点 `+` 毫无反应）。
3. **懒加载占位标签（来自重启恢复）**：
   - `Conversation` 增加可选标记 `deferredLoad?: boolean`。
   - 激活 `deferredLoad === true` 的标签时，立即将 `deferredLoad` 置为 `false`、`loading: true`，并调用 `sessions:load` 拉取完整历史（复用 `openSession` 内的历史加载与模型恢复逻辑）。

### 3.3 关闭与保护规则

触发入口：点击标签 `×`、鼠标中键点击标签（`onAuxClick` 且 `event.button === 1`）、快捷键 `⌘W`、右键菜单各项。

1. **单标签关闭（`closeTab(tabKey)`）**：
   - 收集该 `tabKey` 对应的全部 `Conversation`（普通标签 1 个，对比组为同 `compareId` 的全部成员）。
   - **运行保护**：若任一成员处于 `runState === "running" || runState === "awaitingApproval"`，拦截关闭并 `toast("任务运行中，请先停止任务再关闭会话", { variant: "warning" })`。
   - **清理动作**：逐一调用 `chat:close`（若有 `sessionKey`）、`sessionViews.forget`、`discardPersisted`、`cancelHistoryLoad`、清理 `drafts` / `imageDrafts` / `fileDrafts` 以及滚动位置缓存，同时从 `conversations`、`tabOrder`、`pinnedTabKeys`、`tabHistory` 移除。
   - **固定标签说明**：固定标签隐藏 `×`，但中键或 `⌘W` 显式关闭当前激活标签时，遵循以下规则：
     - 中键点击固定标签：不关闭（防止误触），需先取消固定或右键「关闭」。
     - `⌘W` 关闭当前激活标签：若当前激活标签已固定，则提示「该标签已固定，请先取消固定」或允许关闭；建议遵循 Android Studio 习惯——**固定标签防误关，`⌘W` 跳过固定标签（并轻提示），右键菜单显式点「关闭」才允许关**，最大程度保护重要会话。
2. **右键批量关闭菜单**：
   - **关闭（Close）**：关闭右键目标标签（固定标签右键点击此项仍可执行关闭；运行中拦截）。
   - **关闭其他标签（Close Other Tabs）**：保留右键目标标签 + 所有固定标签 + 所有运行中/等待审批标签，关闭其余标签。
   - **关闭全部标签（Close All Tabs）**：保留所有固定标签 + 所有运行中/等待审批标签，关闭其余标签。
   - **关闭左侧标签（Close Tabs to the Left）**：关闭视觉顺序位于目标左侧的普通且空闲标签。
   - **关闭右侧标签（Close Tabs to the Right）**：关闭视觉顺序位于目标右侧的普通且空闲标签。
   - **固定 / 取消固定标签（Pin / Unpin Tab）**：切换该标签的固定态，固定后自动移到固定区末尾，取消固定后移到普通区首位。
   - 批量关闭若有标签因「运行中/等待审批」被跳过，结束时给一条轻量 toast（如 `已关闭 4 个标签，跳过 1 个运行中的会话`）。
3. **关闭后的焦点落点（MRU 策略）**：
   - 维护访问历史栈 `tabHistory: string[]`（栈顶为当前激活 `tabKey`，每次激活某标签将其去重推到栈顶）。
   - 若关闭的不是当前激活标签：焦点保持不变。
   - 若关闭的是当前激活标签：
     1. 优先从 `tabHistory` 由近到远寻找第一个仍存在的 `tabKey`。
     2. 若找不到（例如刚批量关闭），取原位置右侧相邻标签，再取左侧相邻标签。
     3. 若所有标签均已关闭：`activeViewId` 置为 `null`。此时若仍沿用 `EmptyState.tsx` 的自动 `workOutsideProject(true)`，会自动生成一个新的空白草稿标签（类似浏览器关闭最后一页后自动留一页空白页），确保界面始终可用且不闪烁。

### 3.4 拖拽排序规则

- 复用项目已有依赖 `@dnd-kit/core` + `@dnd-kit/sortable`（`horizontalListSortingStrategy`），配置 `PointerSensor` `activationConstraint: { distance: 6 }` 避免普通点击误触拖拽。
- 限制水平拖拽（`restrictToHorizontalAxis` 或自定义轻量 modifier 锁定 `transform.y = 0`）。
- **分组边界约束**（同 Android Studio）：
  - 拖动固定标签时，只能落点在固定区内（`[0, pinnedCount - 1]`）。
  - 拖动普通标签时，只能落点在普通区内（`[pinnedCount, total - 1]`）。
  - 跨区拖放时自动钳制到所属区边界，防止静默改变固定状态。

### 3.5 切换标签时的滚动位置与面板联动

1. **会话阅读位置保持**：
   - 保持 `AppShell.tsx` 现有的 `<ConversationView key={conversation.viewId} ... />` 卸载/重建策略，避免同时在 DOM 挂载大量 Markdown / Shiki / Mermaid 节点导致内存暴涨。
   - 在 `src/renderer/app/conversation/useConversationScroll.ts` 中新增模块级 `Map<string, { scrollTop: number; stick: boolean }>`（按 `viewId` 存储；关闭视图时清理对应条目）：
     - 滚动或卸载前记录当前 `scrollTop` 与 `stickRef.current`。
     - 重新挂载该 `viewId` 且非 `loading`、无 `searchTarget` 时：若上次 `stick === true` 则滚动到底部，否则精确恢复到上次 `scrollTop`（`useLayoutEffect` 中同步恢复，避免闪跳）。
2. **文件预览 / 协作面板 / 内置终端**：
   - 文件预览和协作面板已通过 `sidePanel.viewId` 绑定会话，切换标签自动隐藏或展示对应会话的侧栏，无需大改。
   - 底部终端和侧边终端已按 `projectPath` 隔离实例，切到其他项目的标签自动切到对应项目的终端，切回同项目标签共享终端。

### 3.6 快捷键与 macOS 菜单栏

扩展 `src/shared/shortcuts.ts` 与 `src/main/menu.ts`：

| 快捷键 | 命令 | 行为 |
|---|---|---|
| `⌘1`–`⌘9` | `switchView`（已有） | **改为按视觉标签顺序** `orderedTabs[index]` 切换（原逻辑按 `Object.keys(conversations)`，改造后所见即所得；第 9 个可按 `orderedTabs[8]`，或仿 Chrome/IDE 跳第 9 个，建议与现有 1–9 一一对应保持一致） |
| `⌘W` | `closeView`（已有） | 关闭当前激活标签（若已固定则跳过并提示；运行中拦截） |
| `⌘T` | `newTab`（新增） | 在当前项目新建会话标签（等同点标签栏 `+`） |
| `⌘⇧[` | `prevTab`（新增） | 切换到上一个标签（循环或停在首位，默认循环） |
| `⌘⇧]` | `nextTab`（新增） | 切换到下一个标签（默认循环） |

> 注：需同步检查 `shortcutFromEvent`（`src/shared/shortcuts.ts`）对 `BracketLeft` / `BracketRight` 的识别，确保非 macOS 或自定义快捷键设置页也能正确录制与展示。

---

## 4. 重启恢复标签与 Chrome 风格提示框设计

### 4.1 设置项设计

在「设置 → 通用与外观」中新增**启动与标签页**配置（或并入「系统策略」卡片上方独立卡片「会话标签页」）：

- 字段名：`tabRestoreMode: TabRestoreMode`
- 类型定义：`export type TabRestoreMode = "ask" | "never" | "always";`
- 默认值：`"ask"`（每次询问）
- UI 控件：复用 `SettingsDialog.tsx` 现有的三段式 `Segmented` 控件：
  - `每次询问`（`"ask"`）
  - `不恢复`（`"never"`）
  - `恢复`（`"always"`）
- 提示文案：`重新打开 HCode 时，是否恢复上次关闭前打开的会话标签`
- 搜索关键词：在 `TAB_KEYWORDS.general` 中补充 `"标签"`, `"标签页"`, `"恢复"`, `"启动"`, `"tab"`, `"restore"`。

### 4.2 持久化数据结构与存储位置

存入主进程 `userData/tabs.json`（与 `window.json`、`settings.json`、`projects.json` 同级，由 `src/main/appStore.ts` 原子读写），避免开发版（`http://localhost`）与正式版（`file://`）或缓存清理导致 `localStorage` 丢失。

```ts
// src/shared/types.ts
export type TabRestoreMode = "ask" | "never" | "always";

export interface PersistedTabItem {
  agent: AgentKind;
  sessionId: string;
  projectPath: string;
  /** 仅用于恢复时的首帧标题占位，真正加载历史或刷新列表后会更新 */
  title: string;
  pinned?: boolean;
}

export interface PersistedTabsState {
  version: 1;
  items: PersistedTabItem[];
  /** 指向 PersistedTabItem 的复合键 `${agent}:${projectPath}:${sessionId}` */
  activeKey: string | null;
  updatedAt: number;
}
```

**过滤规则（哪些标签写入快照）**：

- **写入**：有 `sessionId` 且无 `compareId` 的普通会话标签（按当前标签栏视觉顺序，固定标签在前，普通标签在后，保留 `pinned` 标记）。
- **不写入**：
  - 尚未发送过消息的空白草稿（无 `sessionId`）；
  - 多 CLI 对比组（有 `compareId`，属于临时对比会话，组内各个 CLI 独立保存于各自历史）。
- 当一个草稿发出首条消息并从 `chat:state` 拿到 `sessionId` 后，自动纳入下一次快照写入。

### 4.3 写入时机与防覆盖保护（关键设计）

为防止“应用刚启动、用户还没来得及点提示框里的『恢复』，默认新建的空白草稿就把上次的 `tabs.json` 覆盖清空”这一经典 bug，引入**写回锁 `tabsPersistPaused`**：

1. 启动读取 `tabs.json` 后：
   - 若 `tabRestoreMode === "ask"` 且读取到有效快照（`items.length > 0`）：将快照存入 `pendingRestoreTabs`，同时置 `tabsPersistPaused = true`。
   - 若 `tabRestoreMode === "always"`：直接执行恢复后再解除写回锁。
   - 若 `tabRestoreMode === "never"` 或快照为空：立即解除写回锁。
2. 在 `tabsPersistPaused === true` 期间，任何普通打开/切换/关闭操作都**不写回** `tabs.json`。
3. 一旦用户点击提示框的「恢复」或「暂不 / 关闭」，或用户主动在设置里把 `tabRestoreMode` 改为 `"never"`，才清空 `pendingRestoreTabs`、置 `tabsPersistPaused = false` 并立即持久化一次当前最新状态。
4. 正常运行时：订阅 `appStore` 中与标签快照相关的派生结果（序列化比对变化），**防抖 300ms** 调用 `tabs:save` 写入 `tabs.json`；并在 `window.addEventListener("beforeunload", ...)` 时触发一次立即同步保存（若未加锁）。

### 4.4 启动恢复状态机

```text
应用启动 (appStore.init, !isRemote)
  │
  ├─ 1. 读取 settings (含 tabRestoreMode) 与 tabs:get 快照
  ├─ 2. 过滤无效/重复项 (按 agent + projectPath + sessionId 去重)
  │
  ├──[快照为空 或 tabRestoreMode === "never"]
  │     └─ 走原启动流程 (创建默认非项目草稿)，开启 tabs 持久化
  │
  ├──[tabRestoreMode === "always" 且 快照非空]
  │     └─ restorePersistedTabs(snapshot)：
  │          ├─ 批量创建所有标签占位 (deferredLoad: true)
  │          ├─ 还原 tabOrder、pinnedTabKeys
  │          ├─ 激活 snapshot.activeKey 对应标签 (缺省取第一个)，仅对此标签调用 sessions:load
  │          └─ 开启 tabs 持久化
  │
  └──[tabRestoreMode === "ask" 且 快照非空]
        ├─ 保持 tabsPersistPaused = true (保护原 tabs.json)
        ├─ 走原启动流程 (不阻塞首屏)，写入 pendingRestoreTabs = snapshot
        └─ 渲染 Chrome 风格非阻塞悬浮提示框 TabRestorePrompt
             ├─ 点击「恢复」
             │    ├─ 若当前仅有 1 个未输入文字的空白默认草稿，则替换之；
             │    │  否则保留当前已编辑/新开的标签，并将 snapshot 合并到标签栏
             │    ├─ 激活 snapshot.activeKey（仅加载该激活项，其余懒加载）
             │    └─ 清空 pendingRestoreTabs，解除写回锁，保存最新快照
             └─ 点击「暂不」/「×」
                  └─ 清空 pendingRestoreTabs，解除写回锁，按当前标签保存快照
```

### 4.5 Chrome 风格提示框（`TabRestorePrompt`）UI 规范

参考 Chrome 重启后右上角弹出的「恢复页面？」气泡卡片，轻量且不阻塞用户直接打字或点侧边栏：

- **定位**：固定在 `#conversation-workspace-body` 右上角（`absolute top-3 right-4 z-30`），宽度 `w-[320px]`，圆角卡片 `rounded-xl border border-border bg-popover/95 shadow-lg backdrop-blur-xs`。
- **内容结构**：
  - 顶部行：图标（`HistoryIcon`）+ 标题「恢复上次打开的会话？」+ 右上角关闭按钮 `×`
  - 正文：`上次关闭前打开了 N 个会话标签`（下方可选 1 行灰色小字预览前 2 个会话标题，如 `登录页重构、排查内存泄漏 等`）
  - 底部操作行：
    - 左侧文字按钮：`启动设置`（点击打开设置弹窗并定位到「通用与外观」，方便用户一键改成始终恢复或不恢复）
    - 右侧按钮组：`暂不`（`variant="ghost" size="sm"`）+ `恢复`（`variant="default" size="sm"`）
- **交互细节**：
  - 不抢占输入框焦点，不加全屏遮罩。
  - 若用户在没点提示框前就手动把快照里的**所有**会话都一一打开了，提示框可自动消失并解除写回锁。

### 4.6 懒加载恢复的容错处理

- 恢复后的非激活标签在列表中以占位 `Conversation` 存在（`deferredLoad: true`, `loading: false`, `rows: []`, `title: item.title`）。
- 仅在用户**点击激活该标签**（或经 `⌘1–9` / 下拉菜单 / 侧边栏点击命中它）时，才触发一次 `sessions:load`：
  - 若对应项目路径或 CLI 会话文件已被外部删除：`sessions:load` 失败后在内容区展示 `loadError` 提示，并提供一个「关闭此标签」按钮，不影响其他已恢复标签。
  - 若期间该会话在其他地方（如侧栏 `sessions:list` 刷新或原生实时事件 `chat:state`）被更新了标题或进入运行态，正常合并同步。

---

## 5. 技术架构与代码改动清单

### 5.1 Shared 层

| 文件 | 改动内容 |
|---|---|
| `src/shared/types.ts` | 1. 新增 `TabRestoreMode = "ask" \| "never" \| "always"`、`PersistedTabItem`、`PersistedTabsState`。<br>2. `Settings` 新增 `tabRestoreMode: TabRestoreMode`，`DEFAULT_SETTINGS` 默认 `"ask"`。<br>3. 新增 `normalizeTabRestoreMode(value: unknown): TabRestoreMode`。 |
| `src/shared/ipc.ts` | 1. `InvokeMap` 新增：`"tabs:get": [[], PersistedTabsState \| null]`、`"tabs:save": [[state: PersistedTabsState], void]`。<br>2. `INVOKE_CHANNELS` 同步注册 `"tabs:get"`, `"tabs:save"`。<br>（`src/preload/index.ts` 自动读取 `INVOKE_CHANNELS`，无需修改 preload。） |
| `src/shared/shortcuts.ts` | 1. `AppCommand` 新增 `"newTab" \| "prevTab" \| "nextTab"`。<br>2. `APP_SHORTCUTS` 新增 `⌘T`（新建标签）、`⌘⇧[`（上一个标签）、`⌘⇧]`（下一个标签）。<br>3. `shortcutFromEvent` 增加 `BracketLeft` → `"["`、`BracketRight` → `"]"` 支持；`formatShortcut` 保持友好展示。 |

### 5.2 Main 主进程层

| 文件 | 改动内容 |
|---|---|
| `src/main/appStore.ts` | 1. `migrateSettings` 规范化 `tabRestoreMode`。<br>2. 新增 `tabsPath = join(dataDir, "tabs.json")`。<br>3. 新增 `readTabsState(): PersistedTabsState \| null` 与 `writeTabsState(state: PersistedTabsState): void`（含基础结构校验，损坏文件安全回退 `null`）。 |
| `src/main/index.ts` | 在 `bootstrap()` 中注册 IPC handler：`handle("tabs:get", () => store.readTabsState())` 与 `handle("tabs:save", (state) => store.writeTabsState(state))`。 |
| `src/main/menu.ts` | 1. 「文件」菜单新增 `shortcut("newTab")`。<br>2. 「视图 → 切换会话」子菜单顶部加入 `shortcut("prevTab")`、`shortcut("nextTab")` 及分隔线。 |
| `src/main/remoteControl/policy.ts` | **保持不变**（明确不将 `tabs:get` / `tabs:save` 加入远程 `GUARDS` 白名单，防止远程客户端读写本机标签快照）。 |

### 5.3 Renderer 状态层

建议将纯标签排序、分组、批量关闭计算和快照转换逻辑抽离到独立模块，保持 `appStore.ts` 整洁并便于单元测试。

#### 新增：`src/renderer/app/store/tabModel.ts`

负责所有无副作用的标签派生与变换纯函数：

```ts
export interface TabDescriptor {
  key: string;                  // viewId 或 "compare:" + compareId
  viewIds: string[];            // 关联的 Conversation viewId 列表
  primaryViewId: string;        // 点击该标签时激活的 viewId
  pinned: boolean;
  isCompare: boolean;
  conversations: Conversation[];
}

export function tabKeyOf(conv: Pick<Conversation, "viewId" | "compareId">): string;
export function deriveOrderedTabs(
  conversations: Record<string, Conversation>,
  tabOrder: readonly string[],
  pinnedTabKeys: readonly string[],
  lastCompareViewIds: Record<string, string>,
): TabDescriptor[];
export function reorderTabsWithinGroup(
  orderedKeys: readonly string[],
  pinnedKeys: ReadonlySet<string>,
  activeKey: string,
  overKey: string,
): string[];
export function selectNextActiveTab(
  remainingKeys: readonly string[],
  closedKey: string,
  previousOrder: readonly string[],
  history: readonly string[],
): string | null;
export function buildPersistedTabs(
  tabs: readonly TabDescriptor[],
  activeTabKey: string | null,
): PersistedTabsState;
```

#### 修改：`src/renderer/app/store/appStore.ts`

1. `Conversation` 接口新增可选字段：
   - `deferredLoad?: boolean`（恢复的懒加载标签，尚未读取消息行）。
2. `AppState` 新增状态：
   - `tabOrder: string[]`（保存 `tabKey` 的视觉顺序；固定标签总排在前面）
   - `pinnedTabKeys: string[]`（已固定的 `tabKey` 集合，有序）
   - `tabHistory: string[]`（MRU 访问历史栈）
   - `lastCompareViewIds: Record<string, string>`（记录每个对比组上次聚焦的列 `viewId`）
   - `pendingRestoreTabs: PersistedTabsState | null`（`ask` 模式下待确认的恢复快照）
   - `tabsPersistPaused: boolean`（防覆盖锁）
3. `AppState` 新增 / 改造动作：
   - `activateView(viewId)`：更新 `activeViewId`、`tabHistory`、`lastCompareViewIds`；若目标 `conv.deferredLoad === true`，自动触发异步历史加载。
   - `activateTab(tabKey)`：根据 `tabKey` 找到 `primaryViewId` 并调用 `activateView`。
   - `closeView(viewId)` / `closeTab(tabKey, options?: { allowPinned?: boolean })`：统一关闭逻辑（支持单会话与对比组、运行中拦截、清理草稿与滚动位置、MRU 焦点切换）。`closeActiveView()` 委托给 `closeTab(activeTabKey, { allowPinned: false })`。
   - `closeOtherTabs(tabKey)`、`closeAllTabs()`、`closeTabsToLeft(tabKey)`、`closeTabsToRight(tabKey)`：批量关闭，跳过固定标签和运行中/等待审批标签，返回 `{ closed: number; skippedRunning: number }` 供提示。
   - `toggleTabPinned(tabKey)`：切换固定状态并重排 `tabOrder`（固定入固定区尾、取消固定入普通区首）。
   - `reorderTabs(activeKey, overKey)`：调用 `reorderTabsWithinGroup` 更新 `tabOrder`。
   - `newChat(projectPath, agentOverride?, options?: { forceNew?: boolean })`：新增时同步把新 `tabKey` 追加到 `tabOrder` 并推入 `tabHistory`。
   - `deleteSession(summary)`：删除后同步清理 `tabOrder`、`pinnedTabKeys`、`tabHistory`，若删除的是当前激活会话，走 MRU 切换而不是直接置 `null`。
   - `restorePendingTabs()` / `dismissPendingRestoreTabs()`：处理 Chrome 风格提示框的「恢复」和「暂不」动作。
4. 持久化订阅（仅 `!isRemote`）：
   - 在 `appStore.ts` 底部或独立 `src/renderer/app/store/tabPersistence.ts` 中订阅 `conversations`、`tabOrder`、`pinnedTabKeys`、`activeViewId`、`tabsPersistPaused`。
   - 当 `!tabsPersistPaused` 且序列化快照发生变化时，防抖 300ms 调用 `hcode.invoke("tabs:save", snapshot)`。
   - 注册 `window.addEventListener("beforeunload", flushTabsSave)` 在窗口关闭前立刻落盘。

### 5.4 Renderer UI 层

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/renderer/app/shell/ConversationTabBar.tsx` | 新增 | 渲染标签栏容器、`DndContext` + `SortableContext`、横向滚动（含滚轮映射和激活项自动滚入可见区）、固定/普通分隔线、右侧 `+` 按钮、右侧「全部标签下拉菜单」。 |
| `src/renderer/app/shell/ConversationTabItem.tsx` | 新增 | 单个可拖拽标签：图钉/CLI 图标、标题+同名项目后缀、Tooltip、状态点、`×` 关闭按钮、中键关闭、完整 Radix `ContextMenu`（关闭/关闭其他/关闭左右/关闭全部/固定）。 |
| `src/renderer/app/shell/TabRestorePrompt.tsx` | 新增 | Chrome 风格非阻塞悬浮气泡：显示待恢复标签数量与标题预览，提供「恢复」「暂不」「启动设置」按钮。 |
| `src/renderer/app/shell/AppShell.tsx` | 修改 | 1. 在 `<Header />` 下方挂载 `{!isRemote ? <ConversationTabBar /> : null}`。<br>2. 用 `#conversation-workspace-body` 包裹 `<FilePreviewLayout>` 并在其内挂载 `{!isRemote ? <TabRestorePrompt /> : null}`。<br>3. `useGlobalShortcuts` 接入 `newTab`、`prevTab`、`nextTab`，并将 `switchView` 改为按 `deriveOrderedTabs` 的索引切换。 |
| `src/renderer/app/conversation/SidePanel.tsx` | 修改 | 非 docked 面板定位从 `inset-y-11` 改为 `inset-y-0`。 |
| `src/renderer/app/collaboration/CollaborationPanel.tsx` | 修改 | Portal 目标从 `conversation-panels` 改为 `conversation-workspace-body`。 |
| `src/renderer/app/conversation/useConversationScroll.ts` | 修改 | 按 `viewId` 缓存和恢复 `scrollTop` 与 `stick` 状态，暴露 `clearConversationScroll(viewId)` 供关闭标签时清理。 |
| `src/renderer/app/settings/SettingsDialog.tsx` | 修改 | 在 `GeneralTab` 新增「启动时恢复会话标签」设置行（三段 `Segmented`：每次询问 / 不恢复 / 恢复），并更新 `TAB_KEYWORDS.general`。 |

---

## 6. 关键边界场景与细节处理

1. **多 CLI 对比组（`compareId`）**：
   - 发起对比时，若原有草稿转化为对比组，原草稿 `viewId` 的位置由 `compare:<compareId>` 接替，避免标签位置跳动。
   - 对比组标签标题显示首条用户消息/会话标题，图标位展示组内各 CLI 的 `AgentBadge`；状态点取组内最高优先级（任一等待审批 → 黄点；任一运行中 → 旋转；任一出错未读 → 红点；全部完成未读 → 蓝点）。
   - 关闭对比组标签时，只要组内任一成员在运行中即阻止整组关闭。
2. **空白草稿替换规则（点击「恢复」时）**：
   - 判断当前是否存在“启动自动建的未动过空白草稿”：`!conv.sessionId && !conv.sessionKey && !conv.compareId && conv.rows.length === 0 && !drafts.get(conv.viewId)?.trim() && !(imageDrafts.get(conv.viewId)?.length) && !(fileDrafts.get(conv.viewId)?.length)`。
   - 若启动后用户**没有**编辑过该草稿且只开了这 1 个草稿，点「恢复」时直接移除该默认草稿，呈现干净的上次工作区。
   - 若用户已经在提示框弹出前主动新建/打开了会话或输入了草稿，则保留用户当前会话，并将恢复的标签按原顺序去重合并进来。
3. **启动参数 / 外部唤起链接（`openExternalProjects`）**：
   - 当通过 `hcode://open-project?path=...` 外部唤起打开项目时，若处于 `ask` 模式，保留 `pendingRestoreTabs` 让用户自行决定是否还要恢复旧标签，不强行覆盖。
4. **同名会话与协作标题联动**：
   - 标签标题使用与 `Header`、`SessionItem` 相同的 `presentationTitle` 逻辑（订阅 `usePresentationStore`），保证侧栏、头部、标签栏三处标题实时一致。
   - 重命名会话后，若处于未加锁状态，防抖写回最新标题到 `tabs.json`。
5. **切换设置项 `tabRestoreMode` 的即时效应**：
   - 若当前正显示 `TabRestorePrompt`，用户点进去把设置改为 `"never"`，关闭设置后自动收起提示框并解除写回锁；改为 `"always"` 则保持提示框直到用户本次选择或下次启动自动生效。
6. **高数量标签下的性能**：
   - 标签栏只订阅轻量元数据（通过 `useShallow` 或按 `tabKey` 切片订阅单标签组件），避免某个会话在流式输出 `rows` 时触发整条标签栏频繁重渲染。
   - `ConversationTabItem` 使用 `React.memo`，仅在标题、状态、未读、固定态、激活态变化时重绘。

---

## 7. 分阶段实施计划

建议按 5 个小阶段推进，每阶段都能独立通过 `pnpm typecheck` 与单测：

| 阶段 | 内容 | 涉及范围 | 产出检查 |
|---|---|---|---|
| **Phase 1** | 数据契约、设置项与主进程持久化 | `shared/types.ts`、`shared/ipc.ts`、`main/appStore.ts`、`main/index.ts`、`SettingsDialog.tsx` | 设置页可切换并持久化「每次询问 / 不恢复 / 恢复」；`tabs.json` 读写单测通过 |
| **Phase 2** | 标签状态机、MRU 焦点、懒加载与滚动记忆 | `store/tabModel.ts`、`store/appStore.ts`、`store/tabPersistence.ts`、`useConversationScroll.ts` | 纯函数单测覆盖去重、对比组、Pin 分区、批量关闭、MRU 回退、恢复合并 |
| **Phase 3** | 标签栏 UI、拖拽排序、右键菜单与布局修正 | `ConversationTabBar.tsx`、`ConversationTabItem.tsx`、`AppShell.tsx`、`SidePanel.tsx`、`CollaborationPanel.tsx` | Mac 端标签栏完整渲染，拖拽/右键/Pin/溢出下拉正常，协作面板不遮挡标签栏 |
| **Phase 4** | Chrome 风格恢复气泡与快捷键/菜单栏 | `TabRestorePrompt.tsx`、`shared/shortcuts.ts`、`main/menu.ts`、`AppShell.tsx` | 三档启动模式闭环；`⌘1–9`、`⌘W`、`⌘T`、`⌘⇧[`、`⌘⇧]` 在菜单栏与快捷键设置可用 |
| **Phase 5** | 测试补全与全场景验收 | `src/main/__tests__/appStore.test.ts`、`src/renderer/app/store/tabModel.test.ts` | `pnpm typecheck && pnpm test` 全通过 + Electron 实机验收 |

---

## 8. 测试与验收标准

### 8.1 自动化单元测试（Vitest）

1. **`src/main/__tests__/appStore.test.ts`**：
   - 旧版 `settings.json` 缺少 `tabRestoreMode` 时默认迁移为 `"ask"`；非法值回退 `"ask"`。
   - `writeTabsState` / `readTabsState` 正常往返；损坏 JSON 或非法结构安全返回 `null`。
2. **`src/renderer/app/store/tabModel.test.ts`**：
   - 打开新会话、重复打开同一会话去重、多 CLI 对比组聚合为单标签。
   - 固定标签始终位于普通标签之前；拖拽重排无法跨越固定区/普通区边界。
   - 关闭保护：运行中 / 等待审批拦截单关；批量关闭（其他 / 全部 / 左侧 / 右侧）跳过固定标签和运行中标签并返回准确的跳过计数。
   - MRU 焦点回退：连续在 A → B → C 切换后关闭 C 回到 B；关闭非当前标签不影响焦点。
   - 重启恢复：
     - `ask` 模式下初始化不覆盖旧快照，点击「恢复」在仅含空白默认草稿时替换草稿，在已有输入/会话时合并保留；点击「暂不」后解除写回锁。
     - `always` 模式仅加载激活标签，其余保持 `deferredLoad: true`，切换到懒加载标签时触发 `sessions:load`。
     - `never` 模式忽略旧快照。

### 8.2 Mac 端实机验收清单

- [ ] **布局与视觉**：`Header` 下方标签栏高度克制，深色/浅色主题与自定义壁纸模式下对比度清晰；侧栏折叠/展开及全屏切换时无红绿灯遮挡、窗口拖拽手感不变；打开协作侧边面板与文件预览时不会遮挡标签栏。
- [ ] **基础标签交互**：侧栏单击会话新开标签、重复点击高亮跳转并自动滚入视口；激活态有底部高亮条；运行中/审批/未读状态点与侧边栏同步；切换标签后保留各自草稿与聊天滚动位置。
- [ ] **Android Studio 交互**：横向拖拽排序流畅且固定区与普通区互不越界；中键关闭普通标签生效、固定标签防误关；右键「关闭其他 / 全部 / 左 / 右 / 固定」均按预期工作；溢出时可横向滚动且右侧下拉列表可一键跳转。
- [ ] **对比组与特殊入口**：发起多 CLI 对比只显示 1 个聚合标签；通过 `⌘K`、全文搜索、系统通知、悬浮窗打开会话均可正确定位并高亮对应标签。
- [ ] **快捷键**：`⌘1–9` 精确对应视觉第 1–9 个标签；`⌘T` 新建标签；`⌘W` 关闭当前非固定标签；`⌘⇧[` / `⌘⇧]` 前后切换标签。
- [ ] **重启恢复**：
  - 设为「每次询问」：重启后右上角弹出非阻塞恢复气泡；点「恢复」还原上次标签顺序与固定态，且非激活标签点过去才加载；点「暂不」关闭气泡且再次重启不再重复提示旧会话。
  - 设为「恢复」：重启自动静默恢复。
  - 设为「不恢复」：重启直接进入空白草稿，无提示框。
- [ ] **远程端隔离**：浏览器打开远程操控页，不显示标签栏与恢复提示，不影响本机 `tabs.json`。
