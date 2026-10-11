// 协作视图只持有主进程快照和任务行；状态流转、权限与持久化均属于主进程。
import { create } from "zustand";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import type { ConversationRow } from "@hcode/shared/types";
import { hcode } from "../bridge";
import { applyRowOps } from "../rows";

interface CollaborationViewState {
  runs: Record<string, CollaborationSnapshot>;
  rows: Record<string, ConversationRow[]>;
  accept(snapshot: CollaborationSnapshot): void;
}

export const useCollaborationStore = create<CollaborationViewState>((set) => ({
  runs: {}, rows: {},
  accept: (snapshot) => set((state) => {
    const previous = state.runs[snapshot.id];
    if (previous && previous.seq > snapshot.seq) return state;
    return { runs: { ...state.runs, [snapshot.id]: snapshot } };
  }),
}));

let references = 0;
let dispose: (() => void) | undefined;

/** 多列会话共用一个订阅；事件携带完整快照，拒绝旧结果覆盖新状态。 */
export function subscribeCollaboration() {
  if (references++ === 0) {
    const updated = hcode.on("collaboration:updated", (snapshot) => useCollaborationStore.getState().accept(snapshot));
    const rows = hcode.on("chat:rows", ({ sessionKey, ops }) => {
      const state = useCollaborationStore.getState();
      if (!Object.values(state.runs).some((run) => run.tasks.some((task) => task.sessionKey === sessionKey))) return;
      useCollaborationStore.setState({ rows: { ...state.rows, [sessionKey]: applyRowOps(state.rows[sessionKey] ?? [], ops) } });
    });
    dispose = () => { updated(); rows(); };
  }
  return () => { if (--references === 0) { dispose?.(); dispose = undefined; } };
}
