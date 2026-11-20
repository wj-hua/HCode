import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type PersistedTabsState, type SessionSummary } from "@hcode/shared/types";
import { drafts, fileDrafts, imageDrafts } from "../composer/drafts";

const { invoke, notify } = vi.hoisted(() => ({ invoke: vi.fn(), notify: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: vi.fn(() => () => undefined), platform: "darwin" }, isRemote: false }));
vi.mock("@/components/ui/toast.js", () => ({ toast: notify }));
vi.mock("./uiStore", () => ({ useUiStore: { getState: () => ({ setTheme: vi.fn() }) } }));

import { useAppStore, type Conversation } from "./appStore";
import {
  buildPersistedTabs,
  computeBatchCloseTargets,
  deriveOrderedTabs,
  persistedTabKey,
  reorderTabsWithinGroup,
  selectNextActiveTab,
  togglePinnedOrder,
} from "./tabModel";
import { resetTabPersistenceForTest } from "./tabPersistence";

const PROJECT_A = "/repo/alpha";
const PROJECT_B = "/repo/beta";
const WORKSPACE = "/hcode/workspace/default";

function makeConv(overrides: Partial<Conversation> & { viewId: string }): Conversation {
  return {
    agent: "claude",
    projectPath: PROJECT_A,
    rows: [],
    loading: false,
    runState: "idle",
    permissionMode: "default",
    model: "",
    effort: "",
    codexSpeed: "",
    queue: [],
    ...overrides,
  };
}

function makeSummary(id: string, projectPath = PROJECT_A, agent: "claude" | "codex" = "claude"): SessionSummary {
  return { id, agent, projectPath, title: `标题-${id}`, createdAt: 1, updatedAt: 2 };
}

function resetStore() {
  resetTabPersistenceForTest();
  useAppStore.setState({
    ready: false,
    settings: { ...DEFAULT_SETTINGS, notifyOnFinish: false },
    agentStatuses: null,
    models: {},
    modelsLoading: {},
    modelErrors: {},
    projects: [],
    sessions: {},
    sessionErrors: {},
    expanded: {},
    conversations: {},
    activeViewId: null,
    tabOrder: [],
    pinnedTabKeys: [],
    tabHistory: [],
    lastCompareViewIds: {},
    pendingRestoreTabs: null,
    tabsPersistPaused: true,
    conversationWorkspacePending: false,
  });
  drafts.clear();
  fileDrafts.clear();
  imageDrafts.clear();
}

describe("tabModel 纯函数", () => {
  it("多 CLI 对比组聚合为单标签，并记忆上次激活列", () => {
    const conversations: Record<string, Conversation> = {
      v1: makeConv({ viewId: "v1", sessionId: "s1", title: "普通会话" }),
      c1: makeConv({ viewId: "c1", agent: "claude", compareId: "cmp-1" }),
      c2: makeConv({ viewId: "c2", agent: "codex", compareId: "cmp-1" }),
    };
    const tabs = deriveOrderedTabs(conversations, ["v1", "compare:cmp-1"], [], { "compare:cmp-1": "c2" });
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.key).toBe("v1");
    expect(tabs[1]).toMatchObject({
      key: "compare:cmp-1",
      isCompare: true,
      viewIds: ["c1", "c2"],
      primaryViewId: "c2",
    });
  });

  it("固定标签始终位于普通标签之前；固定入固定区尾、取消固定入普通区首", () => {
    const step1 = togglePinnedOrder(["a", "b", "c"], [], "c");
    expect(step1).toEqual({ tabOrder: ["c", "a", "b"], pinnedTabKeys: ["c"] });

    const step2 = togglePinnedOrder(step1.tabOrder, step1.pinnedTabKeys, "b");
    expect(step2).toEqual({ tabOrder: ["c", "b", "a"], pinnedTabKeys: ["c", "b"] });

    const step3 = togglePinnedOrder(step2.tabOrder, step2.pinnedTabKeys, "c");
    expect(step3).toEqual({ tabOrder: ["b", "c", "a"], pinnedTabKeys: ["b"] });
  });

  it("拖拽排序严格限制在固定区/普通区内部，跨区自动钳制到边界", () => {
    const ordered = ["p1", "p2", "r1", "r2", "r3"];
    const pinned = new Set(["p1", "p2"]);

    expect(reorderTabsWithinGroup(ordered, pinned, "p1", "p2")).toEqual(["p2", "p1", "r1", "r2", "r3"]);
    // 固定标签拖入普通区：钳制到固定区末尾
    expect(reorderTabsWithinGroup(ordered, pinned, "p1", "r3")).toEqual(["p2", "p1", "r1", "r2", "r3"]);
    // 普通标签拖入固定区：钳制到普通区首位
    expect(reorderTabsWithinGroup(ordered, pinned, "r3", "p1")).toEqual(["p1", "p2", "r3", "r1", "r2"]);
    // 普通区内正常排序
    expect(reorderTabsWithinGroup(ordered, pinned, "r1", "r3")).toEqual(["p1", "p2", "r2", "r3", "r1"]);
  });

  it("MRU 焦点回退优先历史栈，其次原位置右侧相邻，再左侧相邻", () => {
    expect(selectNextActiveTab(["a", "b"], "c", ["a", "b", "c"], ["a", "b", "c"])).toBe("b");
    expect(selectNextActiveTab(["a", "c"], "b", ["a", "b", "c"], [])).toBe("c");
    expect(selectNextActiveTab(["a", "b"], "c", ["a", "b", "c"], [])).toBe("b");
    expect(selectNextActiveTab([], "a", ["a"], ["a"])).toBeNull();
  });

  it("批量关闭跳过固定标签与运行中/等待审批标签并返回准确跳过计数", () => {
    const conversations: Record<string, Conversation> = {
      p1: makeConv({ viewId: "p1", sessionId: "p1" }),
      r1: makeConv({ viewId: "r1", sessionId: "r1", runState: "running" }),
      r2: makeConv({ viewId: "r2", sessionId: "r2" }),
      r3: makeConv({ viewId: "r3", sessionId: "r3", runState: "awaitingApproval" }),
      r4: makeConv({ viewId: "r4", sessionId: "r4" }),
    };
    const tabs = deriveOrderedTabs(conversations, ["p1", "r1", "r2", "r3", "r4"], ["p1"], {});

    const others = computeBatchCloseTargets(tabs, "others", "r2");
    expect(others.closable.map((t) => t.key)).toEqual(["r4"]);
    expect(others.skippedRunning).toBe(2);

    const all = computeBatchCloseTargets(tabs, "all");
    expect(all.closable.map((t) => t.key)).toEqual(["r2", "r4"]);
    expect(all.skippedRunning).toBe(2);

    const left = computeBatchCloseTargets(tabs, "left", "r3");
    expect(left.closable.map((t) => t.key)).toEqual(["r2"]);
    expect(left.skippedRunning).toBe(1);

    const right = computeBatchCloseTargets(tabs, "right", "r2");
    expect(right.closable.map((t) => t.key)).toEqual(["r4"]);
    expect(right.skippedRunning).toBe(1);
  });

  it("buildPersistedTabs 过滤空白草稿与对比组，保留视觉顺序与固定态", () => {
    const conversations: Record<string, Conversation> = {
      draft: makeConv({ viewId: "draft" }),
      s1: makeConv({ viewId: "s1", sessionId: "s1", projectPath: PROJECT_A, title: "任务 1" }),
      s2: makeConv({ viewId: "s2", agent: "codex", sessionId: "s2", projectPath: PROJECT_B, title: "任务 2" }),
      c1: makeConv({ viewId: "c1", sessionId: "cs1", compareId: "cmp" }),
    };
    const tabs = deriveOrderedTabs(conversations, ["draft", "s1", "s2", "compare:cmp"], ["s2"], {});
    const persisted = buildPersistedTabs(tabs, "s1");
    expect(persisted.items).toEqual([
      { agent: "codex", sessionId: "s2", projectPath: PROJECT_B, title: "任务 2", pinned: true },
      { agent: "claude", sessionId: "s1", projectPath: PROJECT_A, title: "任务 1" },
    ]);
    expect(persisted.activeKey).toBe(persistedTabKey({ agent: "claude", projectPath: PROJECT_A, sessionId: "s1" }));
  });
});

describe("appStore 标签交互与重启恢复", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    invoke.mockReset();
    notify.mockReset();
    resetStore();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings:get") return { ...DEFAULT_SETTINGS, notifyOnFinish: false };
      if (channel === "tabs:get") return null;
      if (channel === "tabs:save") return undefined;
      if (channel === "workspace:conversation") return WORKSPACE;
      if (channel === "projects:list") return [];
      if (channel === "projects:takeExternalPaths") return [];
      if (channel === "agent:status") return [];
      if (channel === "sessions:list") return [];
      if (channel === "sessions:load") return { rows: [{ rowId: 1, kind: "userInput", text: "你好", turnId: "t1" }] };
      if (channel === "chat:close") return undefined;
      if (channel === "settings:set") return { ...DEFAULT_SETTINGS, notifyOnFinish: false, tabRestoreMode: "never" };
      return undefined;
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("重复打开同一会话去重；关闭非当前标签不影响焦点；MRU 焦点回退正常", async () => {
    const sA = makeSummary("a");
    const sB = makeSummary("b");
    const sC = makeSummary("c");
    await useAppStore.getState().openSession(sA);
    await useAppStore.getState().openSession(sB);
    await useAppStore.getState().openSession(sC);
    await useAppStore.getState().openSession(sA);
    expect(Object.keys(useAppStore.getState().conversations)).toEqual(["a", "b", "c"]);
    expect(useAppStore.getState().activeViewId).toBe("a");

    // 切换顺序：A -> B -> C，关闭 C 应回到 B
    useAppStore.getState().activateTab("b");
    useAppStore.getState().activateTab("c");
    await useAppStore.getState().closeTab("a");
    expect(useAppStore.getState().activeViewId).toBe("c");

    await useAppStore.getState().closeTab("c");
    expect(useAppStore.getState().activeViewId).toBe("b");
  });

  it("运行中拦截单关；固定标签在 ⌘W 下防误关，显式右键可关；批量关闭返回跳过计数", async () => {
    await useAppStore.getState().openSession(makeSummary("s1"));
    await useAppStore.getState().openSession(makeSummary("s2"));
    await useAppStore.getState().openSession(makeSummary("s3"));

    useAppStore.getState().toggleTabPinned("s1");
    useAppStore.setState((state) => ({
      conversations: {
        ...state.conversations,
        s2: { ...state.conversations.s2!, runState: "running" },
      },
    }));

    // 运行中拦截单关
    expect(await useAppStore.getState().closeTab("s2", { allowPinned: true })).toBe(false);
    expect(useAppStore.getState().conversations.s2).toBeDefined();

    // ⌘W 跳过固定标签
    useAppStore.getState().activateTab("s1");
    await useAppStore.getState().closeActiveView();
    expect(useAppStore.getState().conversations.s1).toBeDefined();

    // 批量关闭全部：保留固定 s1 与运行中 s2，只关闭 s3
    const result = await useAppStore.getState().closeAllTabs();
    expect(result).toEqual({ closed: 1, skippedRunning: 1 });
    expect(Object.keys(useAppStore.getState().conversations).sort()).toEqual(["s1", "s2"]);

    // 右键显式允许关闭固定标签
    expect(await useAppStore.getState().closeTab("s1", { allowPinned: true })).toBe(true);
    expect(useAppStore.getState().conversations.s1).toBeUndefined();
  });

  it("ask 模式初始化不覆盖旧快照；点恢复替换空白草稿，已有输入则合并；点暂不解除写回锁", async () => {
    const saved: PersistedTabsState = {
      version: 1,
      items: [
        { agent: "claude", sessionId: "s1", projectPath: PROJECT_A, title: "旧任务 1", pinned: true },
        { agent: "codex", sessionId: "s2", projectPath: PROJECT_B, title: "旧任务 2" },
      ],
      activeKey: persistedTabKey({ agent: "codex", projectPath: PROJECT_B, sessionId: "s2" }),
      updatedAt: 100,
    };
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings:get") return { ...DEFAULT_SETTINGS, notifyOnFinish: false, tabRestoreMode: "ask" };
      if (channel === "tabs:get") return saved;
      if (channel === "workspace:conversation") return WORKSPACE;
      if (channel === "projects:list") return [];
      if (channel === "projects:takeExternalPaths") return [];
      if (channel === "agent:status") return [];
      if (channel === "sessions:list") return [];
      if (channel === "sessions:load") return { rows: [] };
      if (channel === "tabs:save") return undefined;
      return undefined;
    });

    await useAppStore.getState().init();
    expect(useAppStore.getState().tabsPersistPaused).toBe(true);
    expect(useAppStore.getState().pendingRestoreTabs).toEqual(saved);
    expect(invoke).not.toHaveBeenCalledWith("tabs:save", expect.anything());

    // 仅含空白默认草稿时点击「恢复」：替换草稿，仅加载激活项 s2，s1 保持懒加载
    await useAppStore.getState().restorePendingTabs();
    const afterRestore = useAppStore.getState();
    expect(afterRestore.pendingRestoreTabs).toBeNull();
    expect(afterRestore.tabsPersistPaused).toBe(false);
    expect(Object.keys(afterRestore.conversations).sort()).toEqual(["s1", "s2"]);
    expect(afterRestore.pinnedTabKeys).toEqual(["s1"]);
    expect(afterRestore.activeViewId).toBe("s2");
    expect(afterRestore.conversations.s1?.deferredLoad).toBe(true);
    expect(invoke).toHaveBeenCalledWith("sessions:load", { agent: "codex", id: "s2", projectPath: PROJECT_B });
    expect(invoke).not.toHaveBeenCalledWith("sessions:load", { agent: "claude", id: "s1", projectPath: PROJECT_A });

    // 切换到懒加载标签 s1 时才触发加载
    useAppStore.getState().activateTab("s1");
    expect(invoke).toHaveBeenCalledWith("sessions:load", { agent: "claude", id: "s1", projectPath: PROJECT_A });

    // 验证已有草稿输入时恢复应合并保留
    resetStore();
    await useAppStore.getState().init();
    const draftId = useAppStore.getState().activeViewId!;
    drafts.set(draftId, "已经写好的草稿");
    await useAppStore.getState().restorePendingTabs();
    expect(useAppStore.getState().conversations[draftId]).toBeDefined();
    expect(useAppStore.getState().conversations.s1).toBeDefined();
    expect(useAppStore.getState().conversations.s2).toBeDefined();

    // 验证点「暂不」后解除写回锁并保存当前状态
    resetStore();
    invoke.mockClear();
    await useAppStore.getState().init();
    expect(invoke).not.toHaveBeenCalledWith("tabs:save", expect.anything());
    useAppStore.getState().dismissPendingRestoreTabs();
    expect(useAppStore.getState().pendingRestoreTabs).toBeNull();
    expect(useAppStore.getState().tabsPersistPaused).toBe(false);
    expect(invoke).toHaveBeenCalledWith("tabs:save", expect.objectContaining({ items: [] }));
  });

  it("always 模式自动静默恢复并懒加载；never 模式忽略旧快照", async () => {
    const saved: PersistedTabsState = {
      version: 1,
      items: [
        { agent: "claude", sessionId: "s1", projectPath: PROJECT_A, title: "旧任务 1" },
        { agent: "claude", sessionId: "s2", projectPath: PROJECT_A, title: "旧任务 2" },
      ],
      activeKey: persistedTabKey({ agent: "claude", projectPath: PROJECT_A, sessionId: "s1" }),
      updatedAt: 100,
    };

    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings:get") return { ...DEFAULT_SETTINGS, notifyOnFinish: false, tabRestoreMode: "always" };
      if (channel === "tabs:get") return saved;
      if (channel === "workspace:conversation") return WORKSPACE;
      if (channel === "projects:list") return [];
      if (channel === "projects:takeExternalPaths") return [];
      if (channel === "agent:status") return [];
      if (channel === "sessions:list") return [];
      if (channel === "sessions:load") return { rows: [] };
      if (channel === "tabs:save") return undefined;
      return undefined;
    });

    await useAppStore.getState().init();
    expect(useAppStore.getState().pendingRestoreTabs).toBeNull();
    expect(useAppStore.getState().tabsPersistPaused).toBe(false);
    expect(useAppStore.getState().activeViewId).toBe("s1");
    expect(useAppStore.getState().conversations.s2?.deferredLoad).toBe(true);
    expect(invoke).toHaveBeenCalledWith("sessions:load", { agent: "claude", id: "s1", projectPath: PROJECT_A });
    expect(invoke).not.toHaveBeenCalledWith("sessions:load", { agent: "claude", id: "s2", projectPath: PROJECT_A });

    // never 模式忽略旧快照
    resetStore();
    invoke.mockClear();
    invoke.mockImplementation(async (channel: string) => {
      if (channel === "settings:get") return { ...DEFAULT_SETTINGS, notifyOnFinish: false, tabRestoreMode: "never" };
      if (channel === "tabs:get") return saved;
      if (channel === "workspace:conversation") return WORKSPACE;
      if (channel === "projects:list") return [];
      if (channel === "projects:takeExternalPaths") return [];
      if (channel === "agent:status") return [];
      if (channel === "sessions:list") return [];
      if (channel === "tabs:save") return undefined;
      return undefined;
    });

    await useAppStore.getState().init();
    expect(useAppStore.getState().pendingRestoreTabs).toBeNull();
    expect(useAppStore.getState().tabsPersistPaused).toBe(false);
    expect(useAppStore.getState().conversations.s1).toBeUndefined();
    expect(useAppStore.getState().conversations.s2).toBeUndefined();
    expect(useAppStore.getState().activeViewId).toBeTruthy();
  });

  it("启动后的空白草稿在点击项目新建或打开历史会话时原地替换，已有输入、固定或 forceNew 时保留", async () => {
    await useAppStore.getState().init();
    const initialId = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().conversations[initialId]?.projectPath).toBe(WORKSPACE);

    // 未输入任何内容时点击项目新建会话：原地替换默认草稿，不产生多余标签
    useAppStore.getState().newChat(PROJECT_A, "codex");
    const projectDraftId = useAppStore.getState().activeViewId!;
    expect(projectDraftId).not.toBe(initialId);
    expect(Object.keys(useAppStore.getState().conversations)).toEqual([projectDraftId]);
    expect(useAppStore.getState().tabOrder).toEqual([projectDraftId]);
    expect(useAppStore.getState().conversations[projectDraftId]).toMatchObject({ projectPath: PROJECT_A, agent: "codex" });

    // 未输入内容时打开历史会话：原地替换当前空白草稿
    await useAppStore.getState().openSession(makeSummary("s1", PROJECT_A));
    expect(Object.keys(useAppStore.getState().conversations)).toEqual(["s1"]);
    expect(useAppStore.getState().tabOrder).toEqual(["s1"]);
    expect(useAppStore.getState().activeViewId).toBe("s1");

    // 已有历史会话时新建空白草稿应追加新标签，再显式 forceNew 也保留原空白草稿
    useAppStore.getState().newChat(PROJECT_A);
    const secondDraftId = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().tabOrder).toEqual(["s1", secondDraftId]);
    useAppStore.getState().newChat(PROJECT_A, undefined, { forceNew: true });
    const thirdDraftId = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().tabOrder).toEqual(["s1", secondDraftId, thirdDraftId]);

    // 已有草稿输入时切换项目或打开历史会话均不替换
    drafts.set(thirdDraftId, "已写一半的提示词");
    useAppStore.getState().newChat(PROJECT_B);
    const fourthDraftId = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().conversations[thirdDraftId]).toBeDefined();
    expect(useAppStore.getState().tabOrder).toEqual(["s1", secondDraftId, thirdDraftId, fourthDraftId]);

    // 固定的空白草稿不被替换
    useAppStore.getState().toggleTabPinned(fourthDraftId);
    await useAppStore.getState().openSession(makeSummary("s2", PROJECT_B));
    expect(useAppStore.getState().conversations[fourthDraftId]).toBeDefined();
    expect(useAppStore.getState().conversations.s2).toBeDefined();
  });
});
