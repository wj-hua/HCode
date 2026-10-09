// 真实 Agent、Session 和投影器通过模拟 app-server 传输验证窗口重载后的续聊事件路由。
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStateEvent } from "../../../shared/types.js";

const transport = vi.hoisted(() => ({ instance: null as EventEmitter | null, requests: [] as string[] }));
vi.mock("../codex/appServerClient.js", () => ({
  AppServerClient: class extends EventEmitter {
    readonly running = true;
    constructor() { super(); transport.instance = this; }
    async ensureStarted() {}
    async call() { return { data: [], nextCursor: null }; }
    async request(method: string) {
      transport.requests.push(method);
      if (method === "thread/resume") return { model: "codex" };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
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

beforeEach(() => { transport.instance = null; transport.requests = []; });

describe("窗口重新连接同一个 Codex 历史线程", () => {
  it("完成事件送到新绑定，旧绑定被释放", async () => {
    const { agent, states } = createAgent();
    await agent.send(resume("old-view"));
    await flushSend();
    transport.instance!.emit("notification", "turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed" } });
    await agent.send(resume("new-view"));
    await flushSend();
    states.length = 0;
    transport.instance!.emit("notification", "turn/completed", { threadId: THREAD, turn: { id: "turn-1", status: "completed" } });
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
