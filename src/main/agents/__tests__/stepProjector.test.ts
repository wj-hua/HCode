import { describe, expect, it } from "vitest";
import {
  activeBranch,
  projectStepHistory,
  projectStepTool,
  StepRowProjector,
  type StepEntry,
  type StepMessage,
} from "../step/stepProjector.js";
import { kinds, ofKind, RowsMirror } from "./helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ts = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

let nextId = 0;
function entry(message: StepMessage, seconds: number, parentId: string | null, id = `e${++nextId}`): StepEntry {
  return { type: "message", id, parentId, timestamp: ts(seconds), message };
}

describe("projectStepTool", () => {
  it("映射到 ZCode 工具族", () => {
    expect(projectStepTool("read_file", { path: "/a", start_line: 10, end_line: 19 })).toEqual({
      toolName: "Read",
      input: { file_path: "/a", offset: 10, limit: 10 },
    });
    expect(projectStepTool("edit_file", { path: "/a", search: "x", replace: "y" })).toEqual({
      toolName: "Edit",
      input: { file_path: "/a", old_string: "x", new_string: "y" },
    });
    expect(projectStepTool("run_command", { command: "ls", run_in_background: true, timeout_ms: 5 })).toEqual({
      toolName: "Bash",
      input: { command: "ls", run_in_background: true, timeout: 5 },
    });
    expect(projectStepTool("list_directory", {})).toEqual({ toolName: "Glob", input: { pattern: "*", path: "." } });
    expect(projectStepTool("custom_tool", { a: 1 })).toEqual({ toolName: "custom_tool", input: { a: 1 } });
  });
});

describe("activeBranch", () => {
  it("从最后一条沿 parentId 回溯，丢弃被切走的分支", () => {
    const entries: StepEntry[] = [
      { type: "message", id: "a", parentId: null },
      { type: "message", id: "b", parentId: "a" },
      { type: "message", id: "old", parentId: "b" },
      { type: "message", id: "c", parentId: "b" },
      { type: "message", id: "d", parentId: "c" },
    ];
    expect(activeBranch(entries).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("parentId 成环时不会死循环", () => {
    const entries: StepEntry[] = [
      { type: "message", id: "a", parentId: "b" },
      { type: "message", id: "b", parentId: "a" },
    ];
    expect(activeBranch(entries).length).toBeLessThanOrEqual(entries.length + 1);
  });
});

describe("StepCode 历史投影", () => {
  it("两轮对话：上一轮在其最后一条消息的时间结束", () => {
    const u1 = entry({ role: "user", content: "读文件" }, 0, null);
    const a1 = entry(
      {
        role: "assistant",
        model: "step-test",
        content: [
          { type: "thinking", thinking: "看看" },
          { type: "text", text: "好的" },
          { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "/a" } },
        ],
      },
      1,
      u1.id,
    );
    const r1 = entry({ role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "内容" }] }, 2, a1.id);
    const u2 = entry({ role: "user", content: [{ type: "text", text: "第二问" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }, 60, r1.id);
    const rows = projectStepHistory([u1, a1, r1, u2]).snapshot();

    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "assistantText", "toolCall", "turnHeader", "userInput"]);
    const [first, second] = ofKind(rows, "turnHeader");
    expect(first).toMatchObject({ state: "completedSuccess", endedAt: T0 + 2000, activeMs: 2000 });
    expect(second).toMatchObject({ state: "completedSuccess", startedAt: T0 + 60_000 });
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ toolName: "Read", status: "success", output: { text: "内容" } });
    expect(ofKind(rows, "assistantText")[0]?.model).toBe("step-test");
    expect(ofKind(rows, "userInput")[1]?.attachments).toEqual([
      { ref: "data:image/png;base64,AAAA", fileName: "图片", mime: "image/png", bytes: 3 },
    ]);
  });

  it("task_update 的结果带计划快照时显示为 TodoWrite", () => {
    const u = entry({ role: "user", content: "规划" }, 0, null);
    const a = entry({ role: "assistant", content: [{ type: "toolCall", id: "t", name: "task_update", arguments: {} }] }, 1, u.id);
    const r = entry(
      {
        role: "toolResult",
        toolCallId: "t",
        content: "ok",
        details: { plan: [{ subject: "写测试", status: "in_progress", activeForm: "正在写测试" }, { subject: "提交" }] },
      },
      2,
      a.id,
    );
    const tool = ofKind(projectStepHistory([u, a, r]).snapshot(), "toolCall")[0];
    expect(tool).toMatchObject({
      toolName: "TodoWrite",
      status: "success",
      input: {
        todos: [
          { content: "写测试", status: "in_progress", activeForm: "正在写测试" },
          { content: "提交", status: "pending" },
        ],
      },
    });
  });

  it("出错、中断与 ! 命令", () => {
    const u = entry({ role: "user", content: "x" }, 0, null);
    const bash = entry({ role: "bashExecution", command: "false", exitCode: 1, output: "boom" }, 1, u.id);
    const err = entry({ role: "assistant", content: [], stopReason: "error", errorMessage: "quota" }, 2, bash.id);
    const rows = projectStepHistory([u, bash, err]).snapshot();
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ toolName: "Bash", status: "error", output: { text: "boom" } });
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "quota", state: "failed" });

    const u2 = entry({ role: "user", content: "y" }, 0, null);
    const aborted = entry({ role: "assistant", content: [{ type: "text", text: "半" }], stopReason: "aborted" }, 1, u2.id);
    expect(ofKind(projectStepHistory([u2, aborted]).snapshot(), "turnHeader")[0]?.state).toBe("completedInterrupted");
  });

  it("压缩条目显示为时间线标记", () => {
    const u = entry({ role: "user", content: "x" }, 0, null);
    const rows = projectStepHistory([u, { type: "compaction", id: "c", parentId: u.id, timestamp: ts(1) }]).snapshot();
    expect(ofKind(rows, "timelineMarker")).toHaveLength(1);
  });
});

describe("StepCode 实时流", () => {
  it("流式行被 message_end 原地收尾，工具进度整段替换", () => {
    const projector = new StepRowProjector();
    const mirror = new RowsMirror(projector);
    projector.beginLocalTurn("go", T0);
    projector.consumeMessage({ role: "user", content: "go" }, T0 + 1); // 回显，跳过
    projector.beginAssistantMessage(T0 + 2);
    projector.streamEvent({ type: "text_start", contentIndex: 0 }, T0 + 3);
    projector.streamEvent({ type: "text_delta", contentIndex: 0, delta: "跑" }, T0 + 4);
    mirror.flush();
    projector.streamEvent({ type: "text_delta", contentIndex: 0, delta: "一下" }, T0 + 5);
    expect(ofKind(mirror.flush(), "assistantText")[0]).toMatchObject({ text: "跑一下", state: "streaming" });
    projector.streamEvent({ type: "toolcall_start", contentIndex: 1, id: "c1", toolName: "run_command" }, T0 + 6);
    projector.streamEvent(
      { type: "toolcall_end", contentIndex: 1, toolCall: { id: "c1", name: "run_command", arguments: { command: "ls" } } },
      T0 + 7,
    );
    projector.consumeMessage(
      {
        role: "assistant",
        content: [
          { type: "text", text: "跑一下" },
          { type: "toolCall", id: "c1", name: "run_command", arguments: { command: "ls" } },
        ],
      },
      T0 + 8,
    );
    projector.toolProgress("c1", { content: [{ type: "text", text: "a" }] });
    projector.toolProgress("c1", { content: [{ type: "text", text: "a\nb" }] });
    expect(projector.toolInput("c1")).toEqual({ toolName: "Bash", input: { command: "ls" } });
    projector.consumeMessage({ role: "toolResult", toolCallId: "c1", content: "a\nb" }, T0 + 9);
    projector.closeTurn(T0 + 9);
    const rows = mirror.flush();

    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "assistantText", "toolCall"]);
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "跑一下", state: "complete" });
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ toolName: "Bash", status: "success", output: { text: "a\nb" } });
    expect(rows).toEqual(projector.snapshot());
  });
});
