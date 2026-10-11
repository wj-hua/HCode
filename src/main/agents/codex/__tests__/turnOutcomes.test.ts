// 原生通知经过真实 Session 投影与生命周期；传输替代仅在 app-server IO 边界。
import { expect, it } from "vitest";
import type { TurnOutcome } from "../../../../shared/collaboration.js";
import type { AppServerClient } from "../appServerClient.js";
import { CodexSession } from "../codexSession.js";

function fixture() {
  const outcomes: TurnOutcome[] = [];
  let nextTurn = 0;
  const client = { running: true, ensureStarted: async () => {}, request: async (method: string) => {
    if (method === "config/read") return { config: {} };
    if (method === "thread/start") return { thread: { id: "thread" } };
    if (method === "turn/start") return { turn: { id: `turn-${++nextTurn}` } };
    if (method === "turn/interrupt" || method === "thread/unsubscribe") return {};
    throw new Error(`未配置外部响应：${method}`);
  } } as unknown as AppServerClient;
  const session = new CodexSession({ client, emitRows: () => {}, emitState: () => {}, emitPermission: () => {}, emitPermissionResolved: () => {}, onThreadId: () => {}, onTurnCompleted: () => {}, emitTurnOutcome: (result) => outcomes.push(result) }, { key: "key", projectPath: "/fixture", permissionMode: "read-only" });
  return { session, outcomes };
}

it("非重试错误和缺失终态不能成为成功；重复和迟到事件不覆盖新回合", async () => {
  const { session, outcomes } = fixture();
  try {
    await session.send("first", [], [], undefined, "execution-1");
    session.handleNotification("error", { error: { message: "quota exceeded" }, willRetry: false });
    session.handleNotification("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(outcomes[0]).toMatchObject({ executionTurnId: "execution-1", outcome: "failed", error: "quota exceeded" });
    await session.send("second", [], [], undefined, "execution-2");
    session.handleNotification("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(outcomes).toHaveLength(1);
    session.handleNotification("turn/completed", { turn: { id: "turn-2" } });
    expect(outcomes[1]).toMatchObject({ executionTurnId: "execution-2", outcome: "failed", error: "Codex 未提供可信回合终态" });
  } finally { session.close(); }
});

it("原生中断才确认取消；共享进程退出使当前回合失败", async () => {
  const { session, outcomes } = fixture();
  try {
    await session.send("first", [], [], undefined, "execution-1");
    await session.interrupt();
    expect(outcomes).toHaveLength(0);
    session.handleNotification("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
    expect(outcomes[0]).toMatchObject({ executionTurnId: "execution-1", outcome: "cancelled" });
    await session.send("second", [], [], undefined, "execution-2");
    session.detach("app-server exited");
    expect(outcomes[1]).toMatchObject({ executionTurnId: "execution-2", outcome: "failed", error: "app-server exited" });
  } finally { session.close(); }
});

it("结构化结果只使用原生 final_answer，进度说明不混入 JSON", async () => {
  const { session, outcomes } = fixture();
  try {
    await session.send("report", [], [], undefined, "execution-1");
    session.handleNotification("item/completed", { item: { id: "progress", type: "agentMessage", phase: "commentary", text: "我会先读取文件" } });
    session.handleNotification("item/completed", { item: { id: "final", type: "agentMessage", phase: "final_answer", text: '{"summary":"actual report"}' } });
    session.handleNotification("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    expect(JSON.parse(outcomes[0]!.text)).toEqual({ summary: "actual report" });
  } finally { session.close(); }
});

it("普通历史线程没有动态工具时拒绝启用研究，保留原生线程身份", async () => {
  const { session, outcomes } = fixture();
  try {
    await session.send("ordinary", [], [], undefined, "ordinary-turn");
    session.handleNotification("turn/completed", { turn: { id: "turn-1", status: "completed" } });
    await session.configureResearch({ root: "/fixture" });
    await session.send("must not silently create another thread", [], [], undefined, "research-turn");
    expect(outcomes.at(-1)).toMatchObject({ outcome: "failed", executionTurnId: "research-turn", nativeSessionId: "thread" });
    expect(outcomes.at(-1)!.error).toContain("匹配工具");
    expect(session.threadId).toBe("thread");
  } finally { session.close(); }
});
