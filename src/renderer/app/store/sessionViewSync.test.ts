// 通过公开会话动作和真实 IPC 订阅复现独立子会话的身份、内容及状态同步。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type AgentKind, type ChatStateEvent, type ConversationRow, type SessionSummary } from "@hcode/shared/types";

const { invoke, listeners } = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: unknown) => void>() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: (channel: string, listener: (event: unknown) => void) => { listeners.set(channel, listener); return () => listeners.delete(channel); } } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/useTheme.js", () => ({ applyTheme: vi.fn() }));
import { useAppStore } from "./appStore";

let sequence = 0;
let summary: SessionSummary;
let sessionKey: string;

function response(text: string): ConversationRow {
  return { kind: "assistantText", rowId: 1, turnId: "worker-turn", createdAt: 1, createdAtSeq: 1, text, state: "streaming" };
}

function emitState(state: ChatStateEvent["state"], extra: Partial<ChatStateEvent> = {}) {
  listeners.get("chat:state")!({ sessionKey, agent: summary.agent, projectPath: summary.projectPath, sessionId: summary.id, permissionMode: "default", state, ...extra });
}

function emitRows(text: string) {
  listeners.get("chat:rows")!({ sessionKey, ops: [{ op: "reset", rows: [response(text)] }] });
}

beforeEach(async () => {
  sequence++;
  summary = { id: `native-${sequence}`, agent: "agy", projectPath: "/project", title: "独立子会话", createdAt: 1, updatedAt: 2 };
  sessionKey = `worker-${sequence}`;
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("document", { hasFocus: () => true });
  vi.stubGlobal("window", { matchMedia: () => ({ addEventListener: () => {}, removeEventListener: () => {} }) });
  listeners.clear();
  invoke.mockReset();
  invoke.mockImplementation(async channel => {
    if (channel === "settings:get") return { ...DEFAULT_SETTINGS, notifyOnFinish: false };
    if (channel === "projects:list" || channel === "agent:status" || channel === "sessions:list") return [];
    if (channel === "sessions:load") return { summary, rows: [response("旧历史")] };
    if (channel === "chat:close") return;
    throw new Error(`未配置的 IPC: ${channel}`);
  });
  useAppStore.setState({ conversations: {}, activeViewId: null, projects: [], sessions: {}, expanded: {}, permissions: {} });
  await useAppStore.getState().init();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("未打开另一端的新会话也能刷新列表，连续索引通知不会推迟刷新", async () => {
  vi.useFakeTimers();
  useAppStore.setState({ expanded: { [summary.projectPath]: true } });
  invoke.mockImplementation(async channel => {
    if (channel === "sessions:list") return [summary];
    if (channel === "projects:list") return [];
    throw new Error(`未配置的 IPC: ${channel}`);
  });
  emitState("running");
  emitRows("回复中");
  const changed = () => listeners.get("sessions:indexChanged")!({ projectPaths: [summary.projectPath] });
  changed();
  await vi.advanceTimersByTimeAsync(150);
  changed();
  await vi.advanceTimersByTimeAsync(50);
  expect(useAppStore.getState().sessions[summary.projectPath]).toEqual([summary]);
  expect(useAppStore.getState().conversations).toEqual({});
  expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:list")).toHaveLength(1);
  changed();
  await vi.advanceTimersByTimeAsync(200);
  expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:list")).toHaveLength(2);
});

it('后台任务在空闲会话和切换页面时保持详情，结束后同步清除运行数并保留结果', async () => {
  summary.agent = 'claude';
  const task = { id: 'test', description: '全量测试', status: 'running' as const };
  emitState('idle', { backgroundTasks: 1, backgroundTaskDetails: [task] });
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ runState: 'idle', backgroundTasks: 1, backgroundTaskDetails: [task] });
  useAppStore.getState().newChat('/other-project', 'claude');
  const result = { ...task, status: 'failed' as const, summary: '测试失败', outputFile: '/tmp/test.log' };
  emitState('idle', { backgroundTaskDetails: [result] });
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ runState: 'idle', backgroundTaskDetails: [result] });
  expect(useAppStore.getState().conversations[summary.id]!.backgroundTasks).toBeUndefined();
  expect(useAppStore.getState().conversations[summary.id]!.runStartedAt).toBeUndefined();
  emitState('idle', { backgroundTaskDetails: [] });
  expect(useAppStore.getState().conversations[summary.id]!.backgroundTaskDetails).toEqual([]);
});

it.each<AgentKind>(["claude", "codex", "agy"])("%s 子会话在独立打开后接收已有进度、流式追加和终态", async agent => {
  summary.agent = agent;
  emitRows("已生成");
  emitState("running", { model: "native-model" });
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ sessionKey, runState: "running", activeModel: "native-model", rows: [response("已生成")] });
  listeners.get("chat:rows")!({ sessionKey, ops: [{ op: "append", rowId: 1, field: "text", text: "，继续输出" }] });
  expect(useAppStore.getState().conversations[summary.id]!.rows[0]).toMatchObject({ text: "已生成，继续输出" });
  emitState("awaitingApproval");
  expect(useAppStore.getState().conversations[summary.id]!.runState).toBe("awaitingApproval");
  emitState("idle", { usage: { outputTokens: 42 } });
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ runState: "idle", usage: { outputTokens: 42 } });
  expect(useAppStore.getState().conversations[summary.id]!.runStartedAt).toBeUndefined();
  expect(invoke.mock.calls.some(([channel]) => channel === "chat:send")).toBe(false);
});

it.each<AgentKind>(["claude", "codex", "agy"])("%s 下一轮保留上一轮性能指标，结束后统一更新，上下文仍实时变化", async agent => {
  summary.agent = agent;
  const metrics = { ttftMs: 5050, outputSpeedDurationMs: 70400, outputTokensPerSecond: 26.9, outputSpeedBasis: "activeTurn" as const };
  emitState("running", { usage: { ttftMs: 1000 } });
  await useAppStore.getState().openSession(summary);
  const usage = () => useAppStore.getState().conversations[summary.id]!.usage;
  expect(usage()?.ttftMs).toBeUndefined();
  emitState("idle", { usage: { contextUsedTokens: 47000, contextWindowTokens: 480000, ...metrics } });
  invoke.mockResolvedValueOnce(undefined);
  expect(await useAppStore.getState().send("下一轮")).toBe(true);
  expect(usage()).toMatchObject(metrics);
  emitState("running", { usage: { contextUsedTokens: 48000, contextWindowTokens: 480000 } });
  expect(usage()).toMatchObject({ contextUsedTokens: 48000, ...metrics });
  emitState("running", { usage: { contextUsedTokens: 49000, ttftMs: 2500 } });
  expect(usage()).toMatchObject({ contextUsedTokens: 49000, ...metrics });
  emitState("awaitingApproval", { usage: { ttftMs: 2500 } });
  expect(usage()).toMatchObject(metrics);
  // 同一原生会话换执行 key、切换页面时也不能丢掉上一轮指标。
  useAppStore.getState().newChat("/other-project", "claude");
  sessionKey = `${sessionKey}-continued`;
  emitState("running", { usage: { ttftMs: 2500 } });
  await useAppStore.getState().openSession(summary);
  expect(usage()).toMatchObject(metrics);
  const nextMetrics = { ttftMs: 2500, outputSpeedDurationMs: 10000, outputTokensPerSecond: 40, outputSpeedBasis: "response" as const };
  emitState("idle", { usage: nextMetrics });
  expect(usage()).toEqual(nextMetrics);
  // 失败回合缺少吞吐时，不能拼入上一轮的吞吐和耗时。
  emitState("running", { usage: {} });
  expect(usage()).toMatchObject(nextMetrics);
  emitState("error", { usage: { ttftMs: 700 } });
  expect(usage()).toEqual({ ttftMs: 700 });
});

it("历史读取未结束时立即显示流式内容，迟到的历史不能回退正文或状态", async () => {
  let finishHistory!: (result: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finishHistory = resolve; }));
  const opening = useAppStore.getState().openSession(summary);
  emitRows("最新正文");
  emitState("running");
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ loading: false, runState: "running", rows: [response("最新正文")] });
  emitState("error", { error: "原生执行失败" });
  finishHistory({ summary, rows: [response("滞后的历史")] });
  await opening;
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ loading: false, runState: "error", error: "原生执行失败", rows: [response("最新正文")] });
});

it("原生 ID 稍后确认时绑定已打开的历史视图，并保留 init 前收到的行", async () => {
  await useAppStore.getState().openSession(summary);
  emitState("running", { sessionId: undefined });
  emitRows("init 前输出");
  emitState("running");
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ sessionKey, runState: "running", rows: [response("init 前输出")] });
  emitState("idle", { sessionId: undefined });
  expect(useAppStore.getState().conversations[summary.id]!.runState).toBe("idle");
});

it("已有实时内容时，历史读取失败不遮挡继续输出的子会话", async () => {
  let failHistory!: (error: Error) => void;
  invoke.mockImplementationOnce(() => new Promise((_resolve, reject) => { failHistory = reject; }));
  const opening = useAppStore.getState().openSession(summary);
  emitState("running");
  emitRows("持续输出");
  failHistory(new Error("旧历史读取失败"));
  await opening;
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ loading: false, runState: "running", rows: [response("持续输出")] });
  expect(useAppStore.getState().conversations[summary.id]!.loadError).toBeUndefined();
});

it("同名原生 ID 的其他 CLI 或项目不会接管当前页面", async () => {
  await useAppStore.getState().openSession(summary);
  emitRows("其他会话的正文");
  emitState("running", { agent: "codex" });
  emitState("running", { projectPath: "/another-project" });
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ runState: "idle", rows: [response("旧历史")] });
  expect(useAppStore.getState().conversations[summary.id]!.sessionKey).toBeUndefined();
});

it("同一原生子会话再次委派时，独立页面跟随新的执行 key", async () => {
  emitRows("第一轮");
  emitState("idle");
  await useAppStore.getState().openSession(summary);
  const previousKey = sessionKey;
  sessionKey = `${sessionKey}-continued`;
  emitRows("第二轮");
  emitState("running");
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ sessionKey, runState: "running", rows: [response("第二轮")] });
  listeners.get("chat:rows")!({ sessionKey: previousKey, ops: [{ op: "reset", rows: [response("旧连接迟到输出")] }] });
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().conversations[summary.id]!.rows).toEqual([response("第二轮")]);
});

it("关闭历史页面后重新打开，旧请求不能覆盖新页面", async () => {
  let finishOldHistory!: (result: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finishOldHistory = resolve; }));
  const firstOpening = useAppStore.getState().openSession(summary);
  await useAppStore.getState().closeActiveView();
  await useAppStore.getState().openSession(summary);
  finishOldHistory({ summary, rows: [response("已关闭页面的旧请求")] });
  await firstOpening;
  expect(useAppStore.getState().conversations[summary.id]!.rows).toEqual([response("旧历史")]);
});

it("没有实时来源时保留历史读取错误，不能伪装成空会话", async () => {
  invoke.mockRejectedValueOnce(new Error("历史文件不可读"));
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ loading: false, loadError: "历史文件不可读" });
});

it("切走再返回后仍显示最新错误终态，不重跑或截断子任务", async () => {
  await useAppStore.getState().openSession(summary);
  emitState("running");
  useAppStore.getState().newChat("/other-project", "claude");
  emitRows("已完成部分输出");
  emitState("error", { error: "输出超过限制" });
  await useAppStore.getState().openSession(summary);
  expect(useAppStore.getState().activeViewId).toBe(summary.id);
  expect(useAppStore.getState().conversations[summary.id]).toMatchObject({ sessionKey, runState: "error", error: "输出超过限制", rows: [response("已完成部分输出")] });
  expect(invoke.mock.calls.filter(([channel]) => channel === "sessions:load")).toHaveLength(1);
  expect(invoke.mock.calls.some(([channel]) => channel === "chat:send" || channel === "chat:interrupt")).toBe(false);
});
