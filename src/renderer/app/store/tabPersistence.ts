// Mac 端标签快照自动持久化：防抖写回 userData/tabs.json，窗口关闭前同步落盘，远程端禁用。
import type { StoreApi } from "zustand";
import { hcode } from "../bridge";
import type { AppState, Conversation } from "./appStore";
import {
  buildPersistedTabs,
  deriveOrderedTabs,
  serializePersistedTabs,
  tabKeyOf,
} from "./tabModel";

const SAVE_DEBOUNCE_MS = 300;
const isRemoteRuntime = () => Boolean(hcode.remote);

let installed = false;
let lastSavedSerialized: string | null = null;
let wasPaused = true;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let storeRef: StoreApi<AppState> | null = null;

function resolveSnapshotTitle(state: AppState, conv: Conversation): string {
  const summary = conv.sessionId
    ? state.sessions[conv.projectPath]?.find((item) => item.id === conv.sessionId && item.agent === conv.agent)
    : undefined;
  if (summary?.title) return summary.title;
  if (conv.title) return conv.title;
  const first = conv.rows.find((row) => row.kind === "userInput");
  const line = first?.kind === "userInput"
    ? first.text.split("\n").map((item) => item.trim()).find(Boolean)
    : undefined;
  return line ?? "新会话";
}

function computeSnapshot(state: AppState) {
  const tabs = deriveOrderedTabs(
    state.conversations,
    state.tabOrder,
    state.pinnedTabKeys,
    state.lastCompareViewIds,
  );
  const activeConv = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
  const activeTabKey = activeConv ? tabKeyOf(activeConv) : null;
  return buildPersistedTabs(tabs, activeTabKey, (conv) => resolveSnapshotTitle(state, conv));
}

export function flushTabsPersistence(): void {
  if (isRemoteRuntime() || !storeRef) return;
  const state = storeRef.getState();
  if (state.tabsPersistPaused) return;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const snapshot = computeSnapshot(state);
  const serialized = serializePersistedTabs(snapshot);
  if (serialized === lastSavedSerialized) return;
  lastSavedSerialized = serialized;
  void hcode.invoke("tabs:save", snapshot).catch(() => undefined);
}

export function installTabPersistence(store: StoreApi<AppState>): void {
  storeRef = store;
  if (installed || isRemoteRuntime()) return;
  installed = true;

  store.subscribe((state) => {
    if (isRemoteRuntime()) return;
    if (state.tabsPersistPaused) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      wasPaused = true;
      return;
    }

    const snapshot = computeSnapshot(state);
    const serialized = serializePersistedTabs(snapshot);
    const justUnpaused = wasPaused;
    wasPaused = false;

    if (!justUnpaused && serialized === lastSavedSerialized) return;

    if (justUnpaused) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      lastSavedSerialized = serialized;
      void hcode.invoke("tabs:save", snapshot).catch(() => undefined);
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushTabsPersistence();
    }, SAVE_DEBOUNCE_MS);
  });

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", flushTabsPersistence);
  }
}

/** 仅供单元测试重置内部缓存状态。 */
export function resetTabPersistenceForTest(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastSavedSerialized = null;
  wasPaused = true;
}
