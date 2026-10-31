import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { lostContextAfterCompaction } from "@hcode/shared/conversationChanges";

const compact = { kind: "timelineMarker", marker: { type: "compact", origin: "auto", status: "success" } } as ConversationRow;
const reply = { kind: "assistantText", text: "已收到", state: "complete" } as ConversationRow;
const bash = { kind: "toolCall", toolName: "Bash", status: "success", input: { command: "pwd" } } as ConversationRow;
const patch = {
  kind: "toolCall",
  toolName: "ApplyPatch",
  status: "success",
  input: { changes: { "a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-old\n+new\n" } } },
} as ConversationRow;

describe("压缩后丢失上下文提醒", () => {
  it("压缩后没有任何文件变更就结束时提醒", () => {
    expect(lostContextAfterCompaction([patch, compact, bash, reply])).toBe(true);
  });

  it("压缩后继续改动文件时不提醒", () => {
    expect(lostContextAfterCompaction([compact, bash, patch, reply])).toBe(false);
  });

  it("只看最后一次压缩之后的改动", () => {
    expect(lostContextAfterCompaction([compact, patch, compact, reply])).toBe(true);
  });

  it("本轮没有压缩时不提醒", () => {
    expect(lostContextAfterCompaction([bash, reply])).toBe(false);
  });
});
