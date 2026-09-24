import { describe, expect, it } from "vitest";
import { ClaudeRowProjector, projectHistory, type ClaudeRecord } from "../claude/rowProjector.js";
import { withFileReferences } from "../fileAttachments.js";
import { kinds, ofKind, RowsMirror } from "./helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ts = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function user(content: unknown, seconds: number, extra: Partial<ClaudeRecord> = {}): ClaudeRecord {
  return { type: "user", timestamp: ts(seconds), message: { role: "user", content }, ...extra };
}

function assistant(content: unknown[], seconds: number, id = "msg_1"): ClaudeRecord {
  return { type: "assistant", timestamp: ts(seconds), message: { id, model: "claude-test", content } };
}

describe("Claude 历史投影", () => {
  it("一轮对话：用户输入 → 正文 + 工具调用 → 工具结果", () => {
    const rows = projectHistory([
      user("列出文件", 0, { uuid: "u1" }),
      assistant(
        [
          { type: "thinking", thinking: "先看看目录" },
          { type: "text", text: "我来看一下。" },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
        ],
        1,
      ),
      user([{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt\nb.txt" }], 2),
      assistant([{ type: "text", text: "有两个文件。" }], 3, "msg_2"),
    ]).snapshot();

    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "assistantText", "toolCall", "assistantText"]);
    const [header] = ofKind(rows, "turnHeader");
    expect(header).toMatchObject({ turnId: "u1", state: "completedSuccess", startedAt: T0, endedAt: T0 + 3000 });
    expect(ofKind(rows, "userInput")[0]).toMatchObject({ text: "列出文件", origin: "realUser" });
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({
      toolCallId: "toolu_1",
      toolName: "Bash",
      status: "success",
      input: { command: "ls" },
      output: { text: "a.txt\nb.txt" },
      endedAt: T0 + 2000,
    });
    expect(ofKind(rows, "assistantText").map((row) => row.model)).toEqual(["claude-test", "claude-test"]);
    // 所有行都归属同一轮，rowId 单调递增
    expect(new Set(rows.map((row) => row.turnId))).toEqual(new Set(["u1"]));
    expect(rows.map((row) => row.rowId)).toEqual([...rows.map((row) => row.rowId)].sort((a, b) => a - b));
  });

  it("注入文本、meta、子 agent 记录不产生用户气泡", () => {
    const rows = projectHistory([
      user("<system-reminder>ignore</system-reminder>", 0),
      user("<local-command-stdout>ok</local-command-stdout>", 0),
      user("hidden", 0, { isMeta: true }),
      user("sub agent prompt", 0, { parent_tool_use_id: "toolu_parent" }),
      user("真正的问题", 1),
    ]).snapshot();
    expect(ofKind(rows, "userInput").map((row) => row.text)).toEqual(["真正的问题"]);
    expect(ofKind(rows, "turnHeader")).toHaveLength(1);
  });

  it("斜杠命令显示为命令本身", () => {
    const rows = projectHistory([
      user("<command-message>model</command-message><command-name>/model</command-name><command-args>opus</command-args>", 0),
    ]).snapshot();
    expect(ofKind(rows, "userInput")[0]?.text).toBe("/model opus");
  });

  it("与 tool_result 同条的文字不当作新一轮", () => {
    const rows = projectHistory([
      user("go", 0),
      assistant([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }], 1),
      user(
        [
          { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "content" }, { type: "image" }] },
          { type: "text", text: "注入的提醒" },
        ],
        2,
      ),
    ]).snapshot();
    expect(ofKind(rows, "turnHeader")).toHaveLength(1);
    expect(ofKind(rows, "toolCall")[0]?.output?.text).toBe("content\n[图片]");
  });

  it("用户中断：轮次标记为已中断，被拒绝的工具为已取消", () => {
    const rows = projectHistory([
      user("do it", 0),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf x" } }], 1),
      user(
        [
          {
            type: "tool_result",
            tool_use_id: "t1",
            is_error: true,
            content: "The user doesn't want to proceed with this tool use.",
          },
        ],
        2,
      ),
      user([{ type: "text", text: "[Request interrupted by user for tool use]" }], 2),
    ]).snapshot();
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ status: "cancelled" });
    expect(ofKind(rows, "toolCall")[0]?.error).toBeUndefined();
    expect(ofKind(rows, "turnHeader")[0]?.state).toBe("completedInterrupted");
    expect(ofKind(rows, "userInput")).toHaveLength(1);
  });

  it("工具报错：状态为 error 并带错误信息", () => {
    const rows = projectHistory([
      user("x", 0),
      assistant([{ type: "tool_use", id: "t1", name: "Bash", input: { command: "false" } }], 1),
      user([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "exit 1" }], 2),
    ]).snapshot();
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({
      status: "error",
      error: { code: "tool_error", message: "exit 1" },
    });
  });

  it("图片与附件清单还原到用户气泡", () => {
    const file = { path: "/tmp/spec.pdf", name: "spec.pdf", mimeType: "application/pdf", size: 3 };
    const rows = projectHistory([
      user(
        [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          { type: "text", text: withFileReferences("看图和文档", [file]) },
        ],
        0,
      ),
    ]).snapshot();
    const [input] = ofKind(rows, "userInput");
    expect(input?.text).toBe("看图和文档");
    expect(input?.attachments).toEqual([
      { ref: "data:image/png;base64,iVBORw0KGgo=", fileName: "图片", mime: "image/png", bytes: 9 },
      { ref: file.path, fileName: file.name, mime: file.mimeType, bytes: file.size },
    ]);
  });

  it("压缩边界显示为时间线标记", () => {
    const rows = projectHistory([
      user("x", 0),
      { type: "system", subtype: "compact_boundary", timestamp: ts(1) },
    ]).snapshot();
    expect(ofKind(rows, "timelineMarker")[0]?.marker).toMatchObject({ type: "compact" });
  });
});

describe("Claude 实时流", () => {
  function stream(event: Record<string, unknown>): ClaudeRecord {
    return { type: "stream_event", event };
  }

  it("流式行被完整消息原地收尾，增量操作与快照一致", () => {
    const projector = new ClaudeRowProjector();
    const mirror = new RowsMirror(projector);
    projector.beginUserTurn("hi", T0);
    mirror.flush();

    projector.consume(stream({ type: "message_start", message: { id: "msg_s" } }), T0 + 10);
    projector.consume(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }), T0 + 10);
    projector.consume(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }), T0 + 20);
    projector.consume(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }), T0 + 30);
    projector.consume(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "你" } }), T0 + 40);
    mirror.flush();
    projector.consume(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "好" } }), T0 + 50);
    projector.consume(stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "Bash" } }), T0 + 60);
    projector.consume(stream({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"command":' } }), T0 + 70);
    projector.consume(stream({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"ls"}' } }), T0 + 80);

    let rows = mirror.flush();
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "你好", state: "streaming" });
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ status: "inputStreaming", inputText: '{"command":"ls"}' });

    projector.consume(
      {
        type: "assistant",
        message: {
          id: "msg_s",
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "想好了" },
            { type: "text", text: "你好！" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
      T0 + 100,
    );
    projector.consume({ type: "result", subtype: "success", duration_ms: 1234 }, T0 + 200);
    rows = mirror.flush();

    // 没有因为完整消息而重复出现正文 / 推理 / 工具行
    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "assistantText", "toolCall"]);
    expect(ofKind(rows, "reasoning")[0]).toMatchObject({ text: "想好了", state: "complete", durationMs: 90 });
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "你好！", state: "complete", model: "claude-test" });
    // 结果到达时工具仍在运行 → 轮次结束时收尾为已取消
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ status: "cancelled", input: { command: "ls" } });
    expect(ofKind(rows, "turnHeader")[0]).toMatchObject({ state: "completedSuccess", activeMs: 1234 });
    expect(rows).toEqual(projector.snapshot());
  });

  it("审批：待审批 → 允许后运行 → 结果成功", () => {
    const projector = new ClaudeRowProjector();
    const mirror = new RowsMirror(projector);
    projector.beginUserTurn("edit", T0);
    projector.setToolPendingApproval("t1", "Edit", { file_path: "/a" }, "ix-1", T0 + 1);
    let rows = mirror.flush();
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ status: "pendingApproval", approvalInteractionId: "ix-1" });

    projector.resolveToolApproval("t1", true);
    rows = mirror.flush();
    expect(ofKind(rows, "toolCall")[0]?.status).toBe("running");
    expect(ofKind(rows, "toolCall")[0]).not.toHaveProperty("approvalInteractionId");

    projector.consume(user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }], 1), T0 + 5);
    rows = mirror.flush();
    expect(ofKind(rows, "toolCall")[0]?.status).toBe("success");
    expect(rows).toEqual(projector.snapshot());
  });

  it("审批被拒绝后，Claude 回传的 is_error 结果保持已取消", () => {
    const projector = new ClaudeRowProjector();
    projector.beginUserTurn("edit", T0);
    projector.setToolPendingApproval("t1", "Edit", {}, "ix-1", T0 + 1);
    projector.resolveToolApproval("t1", false);
    projector.consume(user([{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "用户拒绝了这次操作" }], 1), T0 + 2);
    const tool = ofKind(projector.snapshot(), "toolCall")[0];
    expect(tool?.status).toBe("cancelled");
    expect(tool?.error).toBeUndefined();
  });

  it("出错的 result 写入失败提示并把轮次标记为失败", () => {
    const projector = new ClaudeRowProjector();
    projector.beginUserTurn("x", T0);
    projector.consume({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom", "bang"] }, T0 + 5);
    const rows = projector.snapshot();
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "boom\nbang", state: "failed" });
    expect(ofKind(rows, "turnHeader")[0]?.state).toBe("failed");
    expect(projector.hasOpenTurn).toBe(false);
  });

  it("中断后的出错 result 不写失败提示", () => {
    const projector = new ClaudeRowProjector();
    projector.beginUserTurn("x", T0);
    projector.markInterrupted();
    projector.consume({ type: "result", subtype: "error_during_execution", is_error: true, result: "aborted" }, T0 + 5);
    const rows = projector.snapshot();
    expect(ofKind(rows, "assistantText")).toHaveLength(0);
    expect(ofKind(rows, "turnHeader")[0]?.state).toBe("completedInterrupted");
  });
});
