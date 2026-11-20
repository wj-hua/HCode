// 会话标签页纯模型：统一处理单会话与对比组聚合、固定区/普通区分区排序、批量关闭计算、MRU 焦点回退与快照序列化。
import { arrayMove } from "@dnd-kit/sortable";
import type { PersistedTabItem, PersistedTabsState } from "@hcode/shared/types";
import type { Conversation } from "./appStore";

export interface TabDescriptor {
  /** 普通会话为 viewId，多 CLI 对比组为 "compare:" + compareId。 */
  key: string;
  /** 该标签关联的全部 Conversation viewId。 */
  viewIds: string[];
  /** 点击该标签时激活的 viewId。 */
  primaryViewId: string;
  pinned: boolean;
  isCompare: boolean;
  conversations: Conversation[];
}

export type BatchCloseMode = "others" | "all" | "left" | "right";

export function tabKeyOf(conv: Pick<Conversation, "viewId" | "compareId">): string {
  return conv.compareId ? `compare:${conv.compareId}` : conv.viewId;
}

export function persistedTabKey(item: Pick<PersistedTabItem, "agent" | "projectPath" | "sessionId">): string {
  return `${item.agent}:${item.projectPath}:${item.sessionId}`;
}

export function isConversationBusy(conv: Pick<Conversation, "runState">): boolean {
  return conv.runState === "running" || conv.runState === "awaitingApproval";
}

export function isTabBusy(tab: Pick<TabDescriptor, "conversations">): boolean {
  return tab.conversations.some(isConversationBusy);
}

/** 派生标签栏视觉顺序：固定标签总在左侧，普通标签在右侧；组内对比会话聚合为单个标签。 */
export function deriveOrderedTabs(
  conversations: Record<string, Conversation>,
  tabOrder: readonly string[],
  pinnedTabKeys: readonly string[],
  lastCompareViewIds: Record<string, string>,
): TabDescriptor[] {
  const groups = new Map<string, Conversation[]>();
  for (const conv of Object.values(conversations)) {
    const key = tabKeyOf(conv);
    const list = groups.get(key);
    if (list) list.push(conv);
    else groups.set(key, [conv]);
  }
  if (groups.size === 0) return [];

  const seen = new Set<string>();
  const mergedKeys: string[] = [];
  for (const key of tabOrder) {
    if (groups.has(key) && !seen.has(key)) {
      seen.add(key);
      mergedKeys.push(key);
    }
  }
  for (const key of groups.keys()) {
    if (!seen.has(key)) {
      seen.add(key);
      mergedKeys.push(key);
    }
  }

  const pinnedSet = new Set(pinnedTabKeys);
  const orderedKeys = [
    ...mergedKeys.filter((key) => pinnedSet.has(key)),
    ...mergedKeys.filter((key) => !pinnedSet.has(key)),
  ];

  return orderedKeys.map((key) => {
    const list = groups.get(key)!;
    const viewIds = list.map((conv) => conv.viewId);
    const isCompare = Boolean(list[0]?.compareId);
    const remembered = lastCompareViewIds[key];
    const primaryViewId = isCompare && remembered && viewIds.includes(remembered) ? remembered : list[0]!.viewId;
    return {
      key,
      viewIds,
      primaryViewId,
      pinned: pinnedSet.has(key),
      isCompare,
      conversations: list,
    };
  });
}

/** 拖拽排序：固定标签只能在固定区内移动，普通标签只能在普通区内移动，跨区自动钳制到所属区边界。 */
export function reorderTabsWithinGroup(
  orderedKeys: readonly string[],
  pinnedKeys: ReadonlySet<string>,
  activeKey: string,
  overKey: string,
): string[] {
  const from = orderedKeys.indexOf(activeKey);
  const over = orderedKeys.indexOf(overKey);
  if (from === -1 || over === -1 || from === over) return [...orderedKeys];

  const pinnedCount = orderedKeys.reduce((count, key) => count + (pinnedKeys.has(key) ? 1 : 0), 0);
  const isPinned = pinnedKeys.has(activeKey);
  const minIndex = isPinned ? 0 : pinnedCount;
  const maxIndex = isPinned ? pinnedCount - 1 : orderedKeys.length - 1;
  if (minIndex > maxIndex) return [...orderedKeys];

  const to = Math.min(Math.max(over, minIndex), maxIndex);
  if (from === to) return [...orderedKeys];
  return arrayMove([...orderedKeys], from, to);
}

/** 切换固定状态：固定后移至固定区末尾，取消固定后移至普通区首位。 */
export function togglePinnedOrder(
  orderedKeys: readonly string[],
  pinnedKeys: readonly string[],
  targetKey: string,
): { tabOrder: string[]; pinnedTabKeys: string[] } {
  if (!orderedKeys.includes(targetKey)) {
    return { tabOrder: [...orderedKeys], pinnedTabKeys: [...pinnedKeys] };
  }
  const pinnedSet = new Set(pinnedKeys);
  const pinnedOthers = orderedKeys.filter((key) => key !== targetKey && pinnedSet.has(key));
  const regularOthers = orderedKeys.filter((key) => key !== targetKey && !pinnedSet.has(key));
  if (pinnedSet.has(targetKey)) {
    return {
      tabOrder: [...pinnedOthers, targetKey, ...regularOthers],
      pinnedTabKeys: pinnedOthers,
    };
  }
  return {
    tabOrder: [...pinnedOthers, targetKey, ...regularOthers],
    pinnedTabKeys: [...pinnedOthers, targetKey],
  };
}

export function pushTabHistory(history: readonly string[], tabKey: string): string[] {
  return [...history.filter((key) => key !== tabKey), tabKey];
}

/** 关闭当前激活标签后的焦点落点：优先 MRU 访问历史栈，其次原位置右侧相邻，再左侧相邻。 */
export function selectNextActiveTab(
  remainingKeys: readonly string[],
  closedKey: string,
  previousOrder: readonly string[],
  history: readonly string[],
): string | null {
  if (remainingKeys.length === 0) return null;
  const remaining = new Set(remainingKeys);

  for (let i = history.length - 1; i >= 0; i--) {
    const candidate = history[i]!;
    if (candidate !== closedKey && remaining.has(candidate)) return candidate;
  }

  const closedIndex = previousOrder.indexOf(closedKey);
  if (closedIndex !== -1) {
    for (let i = closedIndex + 1; i < previousOrder.length; i++) {
      const candidate = previousOrder[i]!;
      if (remaining.has(candidate)) return candidate;
    }
    for (let i = closedIndex - 1; i >= 0; i--) {
      const candidate = previousOrder[i]!;
      if (remaining.has(candidate)) return candidate;
    }
  }

  return remainingKeys[0] ?? null;
}

/** 计算批量关闭目标：保留固定标签与运行中/等待审批标签。 */
export function computeBatchCloseTargets(
  tabs: readonly TabDescriptor[],
  mode: BatchCloseMode,
  targetKey?: string,
): { closable: TabDescriptor[]; skippedRunning: number } {
  let candidates: readonly TabDescriptor[];
  if (mode === "all") {
    candidates = tabs;
  } else {
    const targetIndex = targetKey ? tabs.findIndex((tab) => tab.key === targetKey) : -1;
    if (targetIndex === -1) return { closable: [], skippedRunning: 0 };
    if (mode === "others") {
      candidates = tabs.filter((tab) => tab.key !== targetKey);
    } else if (mode === "left") {
      candidates = tabs.slice(0, targetIndex);
    } else {
      candidates = tabs.slice(targetIndex + 1);
    }
  }

  const closable: TabDescriptor[] = [];
  let skippedRunning = 0;
  for (const tab of candidates) {
    if (tab.pinned) continue;
    if (isTabBusy(tab)) {
      skippedRunning += 1;
      continue;
    }
    closable.push(tab);
  }
  return { closable, skippedRunning };
}

function defaultTabTitle(conv: Conversation): string {
  if (conv.title) return conv.title;
  const first = conv.rows.find((row) => row.kind === "userInput");
  const line = first?.kind === "userInput"
    ? first.text.split("\n").map((item) => item.trim()).find(Boolean)
    : undefined;
  return line ?? "新会话";
}

/** 构造持久化快照：仅写入含 sessionId 的非对比普通会话，按视觉顺序保留 pinned 标记。 */
export function buildPersistedTabs(
  tabs: readonly TabDescriptor[],
  activeTabKey: string | null,
  resolveTitle: (conv: Conversation) => string = defaultTabTitle,
): PersistedTabsState {
  const items: PersistedTabItem[] = [];
  const seen = new Set<string>();
  let activeKey: string | null = null;

  for (const tab of tabs) {
    if (tab.isCompare) continue;
    const conv = tab.conversations[0];
    if (!conv?.sessionId || !conv.projectPath) continue;
    const key = persistedTabKey({
      agent: conv.agent,
      projectPath: conv.projectPath,
      sessionId: conv.sessionId,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      agent: conv.agent,
      sessionId: conv.sessionId,
      projectPath: conv.projectPath,
      title: resolveTitle(conv),
      ...(tab.pinned ? { pinned: true } : {}),
    });
    if (tab.key === activeTabKey) activeKey = key;
  }

  return {
    version: 1,
    items,
    activeKey,
    updatedAt: Date.now(),
  };
}

/** 忽略 updatedAt 比较快照内容是否发生变化。 */
export function serializePersistedTabs(state: PersistedTabsState): string {
  return JSON.stringify({
    version: state.version,
    items: state.items,
    activeKey: state.activeKey,
  });
}

/** 过滤损坏或重复的快照项；无有效项时返回 null。 */
export function sanitizePersistedTabs(snapshot: PersistedTabsState | null): PersistedTabsState | null {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) return null;
  const seen = new Set<string>();
  const items: PersistedTabItem[] = [];
  for (const item of snapshot.items) {
    if (!item || !item.sessionId || !item.projectPath || !item.agent) continue;
    const key = persistedTabKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      agent: item.agent,
      sessionId: item.sessionId,
      projectPath: item.projectPath,
      title: typeof item.title === "string" && item.title ? item.title : "新会话",
      ...(item.pinned ? { pinned: true } : {}),
    });
  }
  if (items.length === 0) return null;
  const activeKey = snapshot.activeKey && seen.has(snapshot.activeKey) ? snapshot.activeKey : null;
  return {
    version: 1,
    items,
    activeKey,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : 0,
  };
}

/** 判断是否为启动后未编辑过的空白默认草稿。 */
export function isBlankDefaultDraft(
  conv: Pick<Conversation, "sessionId" | "sessionKey" | "compareId" | "rows">,
  hasDraftContent: boolean,
): boolean {
  return !conv.sessionId && !conv.sessionKey && !conv.compareId && conv.rows.length === 0 && !hasDraftContent;
}
