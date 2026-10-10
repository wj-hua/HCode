// 真实 Agent、Session 和投影器通过模拟 app-server 传输验证窗口重载后的续聊事件路由。
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStateEvent } from "../../../shared/types.js";

const transport = vi.hoisted(() => ({ instance: null as EventEmitter | null, requests: [] as string[], turns: 0 }));
vi.mock("../codex/appServerClient.js", () => ({
  AppServerClient: class extends EventEmitter {
    readonly running = true;
    constructor() { super(); transport.instance = this; }
    async ensureStarted() {}
    async call() { return { data: [], nextCursor: null }; }
    async request(method: string) {
      transport.requests.push(method);
      if (method === "thread/resume") return { model: "codex" };
      if (method === "turn/start") {
        const id = `turn-${++transport.turns}`;
        transport.instance!.emit("notification", "turn/started", { threadId: "saved-thread", turn: { id, status: "inProgress" } });
        return { turn: { id } };
      }
      if (method === "thread/unsubscribe") return {};
      throw new Error(`未配置的 app-server 请求: ${method}`);
    }
    dispose() {}
  },
}));
import { CodexAgent } from "../codex/codexAgent.js";

const THREAD = "saved-thread";
const WORKSPACE = "/hcode/workspace/default";
const flushSend = () => new Promise<void>((resolve) => setImmediate(resolve));

function createAgent() {
  const states: ChatStateEvent[] = [];
  const agent = new CodexAgent({
    rows: () => undefined,
    state: (event) => states.push(event),
    commands: () => undefined,
    permission: () => undefined,
    permissionResolved: () => undefined,
    indexChanged: () => undefined,
    quotaStale: () => undefined,
  }, () => ({}), () => "codex", "test");
  return { agent, states };
}

const resume = (sessionKey: string) => ({
  agent: "codex" as const, sessionKey, resumeSessionId: THREAD, projectPath: WORKSPACE,
  permissionMode: "on-request" as const, text: "继续对话",
});

beforeEach(() => { transport.instance = null; transport.requests = []; transport.turns = 0; });

describe("窗口重新连接同一个 Codex 历史线程", () => {
  it("实时推送 TTFT，结束后显示速度，并在下一轮清空", async () => {
    let at = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => at);
    const { agent, states } = createAgent();
    try {
      await agent.send(resume("metrics-view"));
      await flushSend();
      const notify = (method: string, params: Record<string, unknown>) =>
        transport.instance!.emit("notification", method, { threadId: THREAD, turnId: "turn-1", ...params });
      notify("item/started", { item: { id: "text-1", type: "agentMessage", text: "" } });
      at = 300;
      notify("item/agentMessage/delta", { itemId: "text-1", delta: "检查" });
      expect(states.at(-1)?.usage?.ttftMs).toBe(300);
      expect(states.at(-1)?.usage?.outputTokensPerSecond).toBeUndefined();
      at = 1300;
      notify("item/agentMessage/delta", { itemId: "text-1", delta: "项目" });
      notify("item/completed", { item: { id: "text-1", type: "agentMessage", text: "检查项目" } });
      notify("thread/tokenUsage/updated", { tokenUsage: {
        total: { inputTokens: 50, outputTokens: 102 }, last: { inputTokens: 50, outputTokens: 102 },
      } });
      notify("item/started", { item: { id: "tool-1", type: "commandExecution", command: "ls" } });
      at = 60300;
      notify("item/completed", { item: { id: "tool-1", type: "commandExecution", command: "ls", status: "completed" } });
      notify("item/started", { item: { id: "text-2", type: "agentMessage", text: "" } });
      notify("item/agentMessage/delta", { itemId: "text-2", delta: "完成" });
      at = 63300;
      notify("item/agentMessage/delta", { itemId: "text-2", delta: "回复" });
      notify("item/completed", { item: { id: "text-2", type: "agentMessage", text: "完成回复" } });
      notify("thread/tokenUsage/updated", { tokenUsage: {
        total: { inputTokens: 100, outputTokens: 202 },
        last: { inputTokens: 50, outputTokens: 100 },
      } });
      // 重复的最终用量通知不能重复计入输出 Token。
      notify("thread/tokenUsage/updated", { tokenUsage: {
        total: { inputTokens: 100, outputTokens: 202 }, last: { inputTokens: 50, outputTokens: 100 },
      } });
      at = 70000;
      notify("turn/completed", { turn: { id: "turn-1", status: "completed" } });
      expect(states.at(-1)).toMatchObject({ state: "idle", usage: {
        outputTokens: 202, ttftMs: 300, outputTokensPerSecond: 202 / 11, outputSpeedBasis: "activeTurn", outputSpeedDurationMs: 11000,
      } });
      await agent.send(resume("metrics-view"));
      await flushSend();
      expect(states.at(-1)?.usage?.ttftMs).toBeUndefined();
      expect(states.at(-1)?.usage?.outputTokensPerSecond).toBeUndefined();
      // 旧轮的延迟用量和文本不能污染第二轮。
      const count = states.length;
      notify("item/agentMessage/delta", { itemId: "text-2", delta: "旧轮延迟片段" });
      notify("thread/tokenUsage/updated", { tokenUsage: {
        total: { inputTokens: 100, outputTokens: 202 }, last: { inputTokens: 100, outputTokens: 202 },
      } });
      expect(states).toHaveLength(count);
    } finally {
      agent.dispose();
      clock.mockRestore();
    }
  });

  it("完成事件送到新绑定，旧绑定被释放", async () => {
    const { agent, states } = createAgent();
    await agent.send(resume("old-view"));
    await flushSend();
    transport.instance!.emit("notification", "turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed" } });
    await agent.send(resume("new-view"));
    await flushSend();
    states.length = 0;
    transport.instance!.emit("notification", "turn/completed", { threadId: THREAD, turn: { id: "turn-2", status: "completed" } });
    expect(states).toContainEqual(expect.objectContaining({ sessionKey: "new-view", state: "idle" }));
    expect(agent.hasSession("old-view")).toBe(false);
    expect(transport.requests).not.toContain("thread/unsubscribe");
    agent.dispose();
  });

  it("已有线程运行中时拒绝新的绑定，保留原运行会话", async () => {
    const { agent } = createAgent();
    await agent.send(resume("running-view"));
    await flushSend();
    await expect(agent.send(resume("another-view"))).rejects.toThrow("运行");
    expect(agent.hasSession("running-view")).toBe(true);
    expect(agent.hasSession("another-view")).toBe(false);
    agent.dispose();
  });
});
