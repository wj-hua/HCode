import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { changesFromRows } from "../TurnChangeSummary";

describe("本轮文件摘要", () => {
  it("只汇总成功的文件工具，并合并同一路径", () => {
    const row = (toolName: string, status: string, input: unknown) => ({ kind: "toolCall", toolName, status, input }) as ConversationRow;
    const patch = { changes: { "a.ts": { unified_diff: "@@ -1 +1 @@\n-old\n+new\n", type: "update" } } };
    expect(changesFromRows([row("ApplyPatch", "success", patch), row("ApplyPatch", "success", patch), row("ApplyPatch", "error", patch), row("Write", "success", { file_path: "b.ts" }), row("Bash", "success", { command: "touch c" })])).toEqual([
      { path: "a.ts", patches: [patch.changes["a.ts"].unified_diff, patch.changes["a.ts"].unified_diff], additions: 2, deletions: 2 },
      { path: "b.ts", patches: [], additions: 0, deletions: 0 },
    ]);
  });
});
