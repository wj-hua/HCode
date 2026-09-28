import { describe, expect, it } from "vitest";
import { CodexSession, type CodexSessionHost } from "../codex/codexSession.js";
import type { AppServerClient } from "../codex/appServerClient.js";

function makeSession() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    ensureStarted: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "turn/start" || method === "review/start") return { turn: { id: "turn-1" } };
      return {};
    },
  } as unknown as AppServerClient;
  const host: CodexSessionHost = {
    client,
    emitRows: () => undefined,
    emitState: () => undefined,
    emitPermission: () => undefined,
    emitPermissionResolved: () => undefined,
    onThreadId: () => undefined,
    onTurnCompleted: () => undefined,
  };
  const session = new CodexSession(host, {
    key: "session-1",
    projectPath: "/project",
    threadId: "thread-1",
    permissionMode: "on-request",
  });
  return { session, calls };
}

describe("Codex 斜杠命令", () => {
  it("/compact 调用 app-server 压缩接口", async () => {
    const { session, calls } = makeSession();
    await session.send("/compact");
    expect(calls.at(-1)).toEqual({ method: "thread/compact/start", params: { threadId: "thread-1" } });
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("/review 调用审查接口", async () => {
    const { session, calls } = makeSession();
    await session.send("/review");
    expect(calls.at(-1)).toEqual({
      method: "review/start",
      params: { threadId: "thread-1", delivery: "inline", target: { type: "uncommittedChanges" } },
    });
  });

  it("技能命令转换为 Codex 的文本标记和 skill 输入项", async () => {
    const { session, calls } = makeSession();
    await session.send("/build 修复测试", [], [], { name: "build", path: "/skills/build/SKILL.md" });
    expect(calls.at(-1)).toMatchObject({
      method: "turn/start",
      params: {
        input: [
          { type: "text", text: "$build 修复测试" },
          { type: "skill", name: "build", path: "/skills/build/SKILL.md" },
        ],
      },
    });
  });
});
