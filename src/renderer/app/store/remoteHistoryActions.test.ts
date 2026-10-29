// 验证补历史与实时内容并存，以及旧请求不能回写关闭后重开的视图。
import { beforeEach, expect, it, vi } from "vitest";
import type { AppState, Conversation } from "./appStore";
import type { ConversationRow, SessionLoadResult } from "@hcode/shared/types";
import { SessionViewSync } from "./sessionViewSync";

const { loadEarlier, invoke } = vi.hoisted(() => ({ loadEarlier: vi.fn(), invoke: vi.fn() }));
vi.mock("../bridge", () => ({ remoteBridge: { loadEarlier }, hcode: { invoke } }));
import { loadRemoteHistory } from "./remoteHistoryActions";

const ref = { agent: "codex" as const, id: "history", projectPath: "/project" };
const row = (rowId: number, text = String(rowId)) => ({ kind: "assistantText", rowId, turnId: `turn-${rowId}`, text } as ConversationRow);
let state: AppState;
const patch = (id: string, update: Partial<Conversation>) => { if (state.conversations[id]) state.conversations[id] = { ...state.conversations[id]!, ...update }; };

beforeEach(() => {
  vi.clearAllMocks();
  state = { conversations: { view: { viewId: "view", agent: "codex", sessionId: "history", projectPath: "/project", rows: [row(4)], earlierRows: { ref, beforeRowId: 4 } } } } as unknown as AppState;
});

it("补历史时保留期间到达的实时更新，按 rowId 合并且不重复", async () => {
  let complete!: (page: SessionLoadResult) => void;
  loadEarlier.mockImplementation(() => new Promise<SessionLoadResult>(resolve => { complete = resolve; }));
  const pending = loadRemoteHistory("view", () => state, patch);
  patch("view", { rows: [row(4, "updated"), row(5)] });
  complete({ summary: null, rows: [row(1), row(4, "old")] });
  await pending;
  expect(state.conversations.view!.rows).toEqual([row(1), row(4, "updated"), row(5)]);
  expect(state.conversations.view!.earlierRows).toBeUndefined();
  expect(state.conversations.view!.earlierRowsLoading).toBe(false);
});

it("旧请求不能覆盖关闭后重开的同名视图", async () => {
  let complete!: (page: SessionLoadResult) => void;
  loadEarlier.mockImplementation(() => new Promise<SessionLoadResult>(resolve => { complete = resolve; }));
  const pending = loadRemoteHistory("view", () => state, patch);
  state.conversations.view = { ...state.conversations.view!, rows: [row(10)], historyRequest: undefined };
  complete({ summary: null, rows: [row(1)] });
  await pending;
  expect(state.conversations.view!.rows).toEqual([row(10)]);
});

it("读取失败保留当前内容与分页位置，并可重试", async () => {
  loadEarlier.mockRejectedValueOnce(new Error("network unavailable"));
  await loadRemoteHistory("view", () => state, patch);
  expect(state.conversations.view).toMatchObject({ rows: [row(4)], earlierRows: { beforeRowId: 4 }, earlierRowsError: "network unavailable", earlierRowsLoading: false });
  loadEarlier.mockResolvedValueOnce({ summary: null, rows: [row(1)] });
  await loadRemoteHistory("view", () => state, patch);
  expect(state.conversations.view!.earlierRowsError).toBeUndefined();
});

it("实时增量及重连快照不会丢掉已展开的历史；缺失中间区间时重新提供分页入口", () => {
  const sync = new SessionViewSync();
  sync.rememberHistory("session", [row(1), row(2), row(3)], undefined);
  const restored = sync.captureRows({ sessionKey: "session", earlierRows: { ref, beforeRowId: 3 }, ops: [{ op: "reset", rows: [row(3, "updated"), row(4)] }] });
  expect(restored).toEqual({ rows: [row(1), row(2), row(3, "updated"), row(4)], earlierRows: undefined });
  expect(sync.captureRows({ sessionKey: "session", ops: [{ op: "append", rowId: 4, field: "text", text: "+" }] }).rows).toHaveLength(4);
  const gap = sync.captureRows({ sessionKey: "session", earlierRows: { ref, beforeRowId: 8 }, ops: [{ op: "reset", rows: [row(8), row(9)] }] });
  expect(gap).toEqual({ rows: [row(8), row(9)], earlierRows: { ref, beforeRowId: 8 } });
});
