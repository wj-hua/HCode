import { describe, expect, it } from "vitest";
import { listCodexSubagents } from "../subagents.js";

describe("Codex 原生子代理", () => {
  it("查询分页及归档线程，并只接受可验证的父子关系", async () => {
    const calls: { method: string; params: any }[] = [];
    const client = { async call<T>(method: string, params: any): Promise<T> {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "root", cwd: "/project" } } as T;
      if (params.archived) return { data: [{ id: "archived", parentThreadId: "root" }], nextCursor: null } as T;
      if (!params.cursor) return { data: [{ id: "nested", parentThreadId: "child" }, { id: "foreign", parentThreadId: "other" }], nextCursor: "next" } as T;
      return { data: [{ id: "child", parentThreadId: "root", agentNickname: "Alice" }], nextCursor: null } as T;
    } };
    const agents = await listCodexSubagents(client, "root", "/project");
    expect(agents.map(agent => agent.id).sort()).toEqual(["archived", "child", "nested"]);
    expect(agents.find(agent => agent.id === "child")?.nickname).toBe("Alice");
    expect(calls.filter(call => call.method === "thread/list").every(call => call.params.ancestorThreadId === "root")).toBe(true);
  });

  it("拒绝工作目录不匹配的根会话", async () => {
    const client = { async call<T>(): Promise<T> { return { thread: { id: "root", cwd: "/other" } } as T; } };
    await expect(listCodexSubagents(client, "root", "/project")).rejects.toThrow("工作目录不匹配");
  });
});
