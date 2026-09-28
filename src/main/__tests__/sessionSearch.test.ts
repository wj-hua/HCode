import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConversationRow, SessionSummary } from "../../shared/types.js";
import type { AgentRegistry } from "../agents/registry.js";
import { findSessionMatches, searchSessions } from "../sessionSearch.js";

const session: SessionSummary = {
  id: "session-1", agent: "claude", projectPath: "/project", title: "修复登录", createdAt: 1, updatedAt: 2,
};
const base = { turnId: "turn-1", createdAt: 1, createdAtSeq: 1 };

describe("会话全文搜索", () => {
  it("能定位只出现在正文或工具输出里的文字", () => {
    const rows: ConversationRow[] = [
      { ...base, rowId: 1, kind: "userInput", origin: "realUser", text: "检查登陆页面" },
      { ...base, rowId: 2, kind: "assistantText", state: "complete", text: "已找到 authentication 问题" },
      { ...base, rowId: 3, kind: "toolCall", toolCallId: "call-1", toolName: "Bash", status: "success", inputText: "pwd", output: { text: "MATCH_IN_OUTPUT" } },
    ];
    expect(findSessionMatches(session, rows, "AUTHENTICATION").map((result) => [result.rowId, result.kind])).toEqual([[2, "assistant"]]);
    expect(findSessionMatches(session, rows, "match_in_output").map((result) => [result.rowId, result.kind])).toEqual([[3, "tool"]]);
  });

  it("标题命中可以打开会话，正文命中带行号", () => {
    const rows: ConversationRow[] = [
      { ...base, rowId: 4, kind: "userInput", origin: "realUser", text: "请修复登录" },
    ];
    expect(findSessionMatches(session, rows, "登录").map((result) => result.rowId)).toEqual([null, 4]);
  });

  it("先筛原始记录，再加载可能命中的会话", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hcode-search-"));
    try {
      const misses = { ...session, id: "miss", agent: "step" as const, title: "无关会话" };
      const hit = { ...session, id: "hit", agent: "step" as const, title: "另一个会话" };
      await Promise.all([
        writeFile(join(dir, "miss.jsonl"), '{"text":"其他文字"}\n'),
        writeFile(join(dir, "hit.jsonl"), '{"text":"\\u5185\\u5bb9"}\n'),
      ]);
      const loaded: string[] = [];
      const agents = {
        allSessions: async () => [misses, hit],
        get: () => ({
          sessionFilePath: (id: string) => join(dir, `${id}.jsonl`),
          loadSession: async (id: string) => {
            loaded.push(id);
            return { summary: null, rows: [{ ...base, rowId: 4, kind: "userInput" as const, origin: "realUser" as const, text: "这里有内容" }] };
          },
        }),
      } as unknown as AgentRegistry;
      expect((await searchSessions(agents, "内容")).map((result) => [result.session.id, result.rowId])).toEqual([["hit", 4]]);
      expect(loaded).toEqual(["hit"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
