import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { changesFromRows } from "../TurnChangeSummary";

describe("本轮文件摘要", () => {
  it("只汇总成功的文件工具，并合并同一路径", () => {
    const row = (toolName: string, status: string, input: unknown, output?: unknown) => ({ kind: "toolCall", toolName, status, input, output }) as ConversationRow;
    const patch = { changes: { "a.ts": { unified_diff: "@@ -1 +1 @@\n-old\n+new\n", type: "update" } } };
    expect(changesFromRows([row("ApplyPatch", "success", patch), row("ApplyPatch", "success", patch), row("ApplyPatch", "error", patch), row("Edit", "success", { file_path: "b.ts", old_string: "old", new_string: "new" }, { text: "ok" }), row("Write", "success", { file_path: "c.ts" }), row("Bash", "success", { command: "touch d" })])).toEqual([
      { path: "a.ts", patches: [patch.changes["a.ts"].unified_diff, patch.changes["a.ts"].unified_diff], additions: 2, deletions: 2 },
      { path: "b.ts", patches: [], additions: 0, deletions: 0 },
    ]);
  });

  it("忽略无变化、无结果或无法确认原内容的工具记录", () => {
    const row = (toolName: string, input: unknown, output?: unknown) => ({ kind: "toolCall", toolName, status: "success", input, output }) as ConversationRow;
    expect(changesFromRows([
      row("Edit", { file_path: "same", old_string: "a", new_string: "a" }, { text: "ok" }),
      row("Edit", { file_path: "unknown", old_string: "a", new_string: "b" }),
      row("Write", { file_path: "write", content: "a" }, { text: "ok" }),
      row("ApplyPatch", { changes: { empty: { type: "update", unified_diff: "" }, context: { type: "update", unified_diff: "@@ -1 +1 @@\n same\n" } } }),
    ])).toEqual([]);
  });
});
