import { describe, expect, it } from "vitest";
import { agyHistorySubagents, agyLiveSubagents, filterAgySubagentSessions } from "../agySubagents.js";
import { projectAgySubagentHistory } from "../agyProjector.js";

const parent = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";

describe("Antigravity 原生子代理", () => {
  it("只隐藏已确认的子代理，保留普通未命名会话", () => {
    const session = (id: string) => ({ id, agent: "agy" as const, title: "未命名会话", projectPath: "/p", createdAt: 1, updatedAt: 1 });
    const result = filterAgySubagentSessions([session(parent), session(child), session("ordinary")], new Set([child]));
    expect(result.map(item => item.id)).toEqual([parent, "ordinary"]);
  });
  it("从运行事件取得子会话，但不把派发结束当成子代理完成", () => {
    const result = agyLiveSubagents(parent, { step_type: "subagent", tool_name: "invoke_subagent", state: "DONE",
      subagent_info: { subagents: [{ conversation_id: child, role: "研究员", type_name: "research" }, { conversation_id: "../invalid" }] } });
    expect(result).toEqual([{ id: child, parentId: parent, role: "研究员", nickname: "research" }]);
  });

  it("按工具顺序从历史结果恢复父子关联", () => {
    const steps = [
      { type: "PLANNER_RESPONSE", tool_calls: [{ name: "view_file", args: {} }, { name: "invoke_subagent", args: { Role: "研究员", TypeName: "research" } }] },
      { type: "GENERIC", status: "DONE", content: `Created the following subagent: {"conversationId":"${parent}"}` },
      { type: "GENERIC", status: "DONE", content: `Created the following subagent:\n{ "conversationId": "${child}" }` },
    ];
    expect(agyHistorySubagents(parent, steps)).toEqual([{ id: child, parentId: parent, role: "研究员", nickname: "research" }]);
  });

  it("展示发给子代理的消息，且不推断任务终态", () => {
    const rows = projectAgySubagentHistory([
      { type: "SYSTEM_MESSAGE", content: "<SYSTEM_MESSAGE>\n[Message] sender=parent content=请检查文件\n</SYSTEM_MESSAGE>" },
      { type: "PLANNER_RESPONSE", content: "正在检查" },
    ]).snapshot();
    expect(rows.filter(row => row.kind === "assistantText").map(row => row.text)).toEqual(["来自其他代理的消息：\n请检查文件", "正在检查"]);
    expect(rows.find(row => row.kind === "turnHeader")?.state).toBe("running");
  });
});
