// 刷新通过真实状态合并策略验证，网络和提示位于外部边界。
import { beforeEach, expect, it, vi } from "vitest";
import type { AppState, Conversation } from "./appStore";
import type { ConversationRow, SessionLoadResult } from "@hcode/shared/types";
const { refreshHistory, refreshSession, invoke, toast } = vi.hoisted(() => ({ refreshHistory: vi.fn(), refreshSession: vi.fn(), invoke: vi.fn(), toast: vi.fn() }));
vi.mock("../bridge", () => ({ remoteBridge: { refreshHistory, refreshSession }, hcode: { invoke } }));
vi.mock("@/components/ui/toast.js", () => ({ toast }));
import { refreshConversation, refreshSessionList } from "./refreshActions";
const row = (rowId: number, text = String(rowId)) => ({ kind: "assistantText", rowId, turnId: "turn", text } as ConversationRow);
let state: AppState;
const patch = (id: string, update: Partial<Conversation>) => { if (state.conversations[id]) state.conversations[id] = { ...state.conversations[id]!, ...update }; };
const set = (update: Partial<AppState>) => { state = { ...state, ...update }; };
beforeEach(() => {
  vi.clearAllMocks();
  state = { conversations: { view: { viewId: "view", agent: "codex", sessionId: "history", projectPath: "/project", rows: [row(4)], queue: [{ id: "draft" }] } }, projects: [{ path: "/project" }], expanded: { "/project": true }, loadSessions: vi.fn() } as unknown as AppState;
});
it("刷新替换旧正文，同时保留请求期间的新增量、已加载范围和队列", async () => {
  let complete!: (result: SessionLoadResult) => void;
  refreshHistory.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = refreshConversation("view", () => state, patch);
  expect(state.conversations.view!.refreshing).toBe(true);
  expect(refreshHistory).toHaveBeenCalledWith({ agent: "codex", id: "history", projectPath: "/project" }, 4);
  patch("view", { rows: [...state.conversations.view!.rows, row(5, "live")] });
  complete({ summary: null, rows: [row(4, "fresh"), row(5, "stale")] });
  await pending;
  expect(state.conversations.view).toMatchObject({ rows: [row(4, "fresh"), row(5, "live")], queue: [{ id: "draft" }], refreshing: false });
});
it("关闭后重开的同名视图拒绝迟到响应", async () => {
  let complete!: (result: SessionLoadResult) => void;
  refreshHistory.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = refreshConversation("view", () => state, patch);
  state.conversations.view = { ...state.conversations.view!, rows: [row(10)], refreshRequest: undefined };
  complete({ summary: null, rows: [row(4, "stale")] }); await pending;
  expect(state.conversations.view!.rows).toEqual([row(10)]);
});
it("刷新失败保留正文，重试后清除错误", async () => {
  refreshHistory.mockRejectedValueOnce(new Error("offline"));
  await refreshConversation("view", () => state, patch);
  expect(state.conversations.view).toMatchObject({ rows: [row(4)], refreshError: "offline", refreshing: false });
  refreshHistory.mockResolvedValueOnce({ summary: null, rows: [row(4, "fresh")] });
  await refreshConversation("view", () => state, patch);
  expect(state.conversations.view!.refreshError).toBeUndefined();
});
it("活跃远程会话走带序号的快照协调器", async () => {
  patch("view", { sessionKey: "live", runState: "running" });
  await refreshConversation("view", () => state, patch);
  expect(refreshSession).toHaveBeenCalledExactlyOnceWith("live");
  expect(refreshHistory).not.toHaveBeenCalled();
});
it("列表刷新强制更新索引，重复点击不并发，失败保留原项目", async () => {
  let fail!: (error: Error) => void;
  invoke.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  const pending = refreshSessionList(() => state, set);
  await refreshSessionList(() => state, set);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("projects:list", true);
  fail(new Error("index unavailable")); await pending;
  expect(state.projects).toEqual([{ path: "/project" }]);
  expect(state.sessionListRefreshing).toBe(false);
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("index unavailable"), expect.anything());
});
