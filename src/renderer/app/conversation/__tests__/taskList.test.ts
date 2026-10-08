import { expect, it } from "vitest";
import type { ToolCallRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@hcode/shared/types";
import { applyRowOps } from "../../rows";
import { selectTaskList } from "../taskList";

const steps = [
  { content: "读代码", status: "completed" },
  { content: "改代码", status: "in_progress", activeForm: "正在改代码" },
  { content: "验证", status: "pending" },
];
const tool = (rowId: number, todos = steps, patch: Partial<ToolCallRow> = {}): ToolCallRow => ({
  rowId, turnId: "turn-1", createdAt: rowId, createdAtSeq: rowId,
  kind: "toolCall", toolName: "TodoWrite", toolCallId: `tool-${rowId}`, status: "success",
  input: { todos }, inputText: JSON.stringify({ todos }), ...patch,
});
const header = (patch: Partial<TurnHeaderRow> = {}): TurnHeaderRow => ({
  rowId: 1, turnId: "turn-1", createdAt: 1, createdAtSeq: 1, kind: "turnHeader",
  origin: "userInput", startedAt: 1, state: "running", ...patch,
});
const select = (rows: ConversationRow[], runState: "running" | "awaitingApproval" | "idle" | "error" = "running") =>
  selectTaskList({ agent: "claude", rows, runState });

it("Claude、Codex、StepCode 和 pi 共用 TodoWrite 快照，Antigravity 不显示", () => {
  for (const agent of ["claude", "codex", "step", "pi"] as const) {
    expect(selectTaskList({ agent, rows: [tool(2)], runState: "running" })).toMatchObject({
      completed: 1, current: "改代码", steps: [{ title: "读代码" }, { title: "改代码" }, { title: "验证" }],
    });
  }
  expect(selectTaskList({ agent: "agy", rows: [tool(2)], runState: "running" })).toBeNull();
  expect(select([])).toBeNull();
});

it("取最后一张有效清单，输出优先于输入，完整 inputText 可恢复历史", () => {
  const later = tool(3, [{ content: "新的工作", status: "pending" }]);
  expect(select([tool(2), later])?.current).toBe("新的工作");
  const output = { text: JSON.stringify({ todos: [{ content: "输出中的任务", status: "in_progress" }] }) };
  expect(select([tool(2, steps, { output })])?.current).toBe("输出中的任务");
  expect(select([tool(2, steps, { input: undefined })])?.current).toBe("改代码");
});

it("Codex 原地更新卡片时计数和当前任务跟着更新，全部完成且轮次结束后隐藏", () => {
  let rows: ConversationRow[] = [header(), tool(2)];
  rows = applyRowOps(rows, [{ op: "upsert", row: tool(2, [
    { content: "读代码", status: "completed" },
    { content: "改代码", status: "completed" },
    { content: "验证", status: "in_progress" },
  ]) }]);
  expect(select(rows)).toMatchObject({ completed: 2, current: "验证" });
  rows = applyRowOps(rows, [{ op: "upsert", row: tool(2, steps.map((step) => ({ ...step, status: "completed" }))) }]);
  expect(select(rows)).toMatchObject({ completed: 3, current: "全部完成" });
  expect(select(rows, "awaitingApproval")).not.toBeNull();
  expect(select(rows, "idle")).toBeNull();
  expect(select(rows, "error")).toBeNull();
  rows = applyRowOps(rows, [{ op: "upsert", row: header({ state: "completedSuccess", endedAt: 5 }) }]);
  expect(select(rows)).toBeNull();
});

it("前一轮已完成的清单不会在下一轮重新出现，未完成清单结束后仍可查看", () => {
  const done = tool(2, [{ content: "完成", status: "completed" }]);
  expect(select([header({ state: "completedSuccess" }), done, header({ rowId: 3, turnId: "turn-2" })])).toBeNull();
  expect(select([tool(2)], "idle")).toMatchObject({ completed: 1, current: "改代码" });
  expect(select([tool(2)], "error")).not.toBeNull();
});

it("流式、未获批、失败或格式损坏的调用不覆盖已有清单", () => {
  for (const status of ["inputStreaming", "pendingApproval", "error", "cancelled"] as const) {
    expect(select([tool(2), tool(3, [{ content: "尚未应用", status: "pending" }], { status })])?.current).toBe("改代码");
  }
  expect(select([tool(2), tool(3, [], { input: undefined, inputText: '{"todos":[' })])?.current).toBe("改代码");
  expect(select([tool(2), tool(3, [{ content: "不合法", status: "unknown" }])])?.current).toBe("改代码");
});

it("空清单会清除面板，全部待完成时摘要选第一项", () => {
  expect(select([tool(2), tool(3, [])])).toBeNull();
  expect(select([tool(2), tool(3, steps, { output: { text: '{"todos":[]}' } })])).toBeNull();
  expect(select([tool(2, [{ content: "先开始这里", status: "pending" }])])).toMatchObject({ completed: 0, current: "先开始这里" });
});
