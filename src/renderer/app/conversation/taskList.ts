import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import type { ZCodePlanStep } from "@zcode/shared";
import type { AgentKind, ChatRunState, ConversationRow } from "@hcode/shared/types";

export interface TaskListState {
  turnId: string;
  steps: ZCodePlanStep[];
  completed: number;
  current: string;
}

function emptyTodos(value: unknown): boolean {
  if (typeof value === "string") {
    try { return emptyTodos(JSON.parse(value)); }
    catch { return false; }
  }
  if (!value || typeof value !== "object" || !("todos" in value)) return false;
  return Array.isArray(value.todos) && value.todos.length === 0;
}

/** 与时间线卡片共用计划解析；流式参数和失败调用不覆盖已生效的清单。 */
export function selectTaskList({ agent, rows, runState }: {
  agent: AgentKind;
  rows: readonly ConversationRow[];
  runState: ChatRunState;
}): TaskListState | null {
  if (agent === "agy") return null;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.kind !== "toolCall" || row.toolName !== "TodoWrite" || (row.status !== "running" && row.status !== "success")) continue;
    const output = extractPlanStepsFromToolOutput({ kind: row.toolName, output: row.output?.text });
    const input = row.input ?? row.inputText;
    // 空清单表示主动清除，不能回退到此前那张非空卡片。
    if (emptyTodos(row.output?.text) || (!output && emptyTodos(input))) return null;
    const steps = output ?? extractPlanStepsFromToolInput({ kind: row.toolName, input });
    if (!steps) continue;
    const completed = steps.filter((step) => step.status === "completed").length;
    if (completed === steps.length) {
      const busy = runState === "running" || runState === "awaitingApproval";
      const header = rows.findLast((item) => item.kind === "turnHeader" && item.turnId === row.turnId);
      // 前一轮完成的清单不能因下一轮开始运行而重新出现。
      if (!busy || row.turnId !== rows.at(-1)?.turnId || (header?.kind === "turnHeader" && header.state !== "running")) return null;
    }
    const current = steps.find((step) => step.status === "in_progress") ?? steps.find((step) => step.status === "pending");
    return { turnId: row.turnId, steps, completed, current: current?.title ?? "全部完成" };
  }
  return null;
}
