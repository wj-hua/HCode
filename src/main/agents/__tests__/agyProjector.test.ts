import { describe, expect, it } from "vitest";
import {
  AgyRowProjector,
  projectAgyHistory,
  projectAgyTool,
  uploadedImagesNote,
  userRequestText,
  type AgyStep,
} from "../agy/agyProjector.js";
import { kinds, ofKind, RowsMirror } from "./helpers.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const ts = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

describe("userRequestText", () => {
  it("取出 USER_REQUEST 包裹的原文", () => {
    expect(userRequestText("<USER_REQUEST>\n修 bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…</ADDITIONAL_METADATA>")).toBe("修 bug");
    expect(userRequestText("plain")).toBe("plain");
  });
});

describe("projectAgyTool", () => {
  it("映射到 ZCode 工具族", () => {
    expect(projectAgyTool("view_file", { AbsolutePath: "/a", StartLine: 5, EndLine: 9 })).toEqual({
      toolName: "Read",
      input: { file_path: "/a", offset: 5, limit: 5 },
    });
    expect(
      projectAgyTool("multi_replace_file_content", {
        TargetFile: "/a",
        ReplacementChunks: [
          { TargetContent: "a", ReplacementContent: "A" },
          { TargetContent: "b", ReplacementContent: "B" },
        ],
      }),
    ).toEqual({ toolName: "Edit", input: { file_path: "/a", old_string: "a\n…\nb", new_string: "A\n…\nB" } });
    expect(projectAgyTool("run_command", { CommandLine: "ls", Cwd: "/r", toolSummary: "列目录" })).toEqual({
      toolName: "Bash",
      input: { command: "ls", cwd: "/r", description: "列目录" },
    });
    expect(projectAgyTool("read_url_content", { Url: "https://x" })).toEqual({ toolName: "WebFetch", input: { url: "https://x" } });
  });

  it("未知工具去掉 toolAction / toolSummary 后原样保留", () => {
    expect(projectAgyTool("browser_open", { url: "u", toolAction: "open", toolSummary: "s" })).toEqual({
      toolName: "browser_open",
      input: { url: "u" },
    });
  });
});

describe("Antigravity 历史投影", () => {
  it("GENERIC 结果按顺序对应工具调用；没有结果的工具在下次回复时视为完成", () => {
    const steps: AgyStep[] = [
      { type: "USER_INPUT", step_index: 0, created_at: ts(0), content: "<USER_REQUEST>\n看看项目\n</USER_REQUEST>" },
      {
        type: "PLANNER_RESPONSE",
        step_index: 1,
        created_at: ts(1),
        thinking: " 先列目录 ",
        content: "我来看看",
        tool_calls: [
          { name: "list_dir", args: { DirectoryPath: "/repo" } },
          { name: "grep_search", args: { Query: "TODO" } },
        ],
      },
      { type: "GENERIC", step_index: 2, created_at: ts(2), content: "Created At: x\nCompleted At: y\n\nsrc\nREADME.md" },
      { type: "PLANNER_RESPONSE", step_index: 3, created_at: ts(3), content: "看完了" },
      { type: "SYSTEM_MESSAGE", step_index: 4, created_at: ts(4), content: "后台任务通知" },
    ];
    const rows = projectAgyHistory(steps).snapshot();
    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "assistantText", "toolCall", "toolCall", "assistantText"]);
    expect(ofKind(rows, "userInput")[0]?.text).toBe("看看项目");
    expect(ofKind(rows, "reasoning")[0]?.text).toBe("先列目录");
    const [list, grep] = ofKind(rows, "toolCall");
    expect(list).toMatchObject({ toolName: "Glob", status: "success", output: { text: "src\nREADME.md" } });
    expect(grep).toMatchObject({ toolName: "Grep", status: "success" });
    expect(ofKind(rows, "turnHeader")[0]).toMatchObject({ state: "completedSuccess", endedAt: T0 + 4000 });
  });

  it("出错的工具结果", () => {
    const rows = projectAgyHistory([
      { type: "USER_INPUT", created_at: ts(0), content: "x" },
      { type: "PLANNER_RESPONSE", step_index: 1, created_at: ts(1), tool_calls: [{ name: "run_command", args: { CommandLine: "false" } }] },
      { type: "GENERIC", created_at: ts(2), status: "ERROR", error: "exit 1", content: "" },
    ]).snapshot();
    expect(ofKind(rows, "toolCall")[0]).toMatchObject({ status: "error", error: { message: "exit 1" } });
  });

  it("上传图片说明从正文里去掉；文件已不存在时留文字占位", () => {
    const content = `<USER_REQUEST>\n看图${uploadedImagesNote(["/nonexistent/hcode-test.png"])}\n</USER_REQUEST>`;
    const rows = projectAgyHistory([{ type: "USER_INPUT", created_at: ts(0), content }]).snapshot();
    const [input] = ofKind(rows, "userInput");
    expect(input?.text).toBe("看图\n[图片 /nonexistent/hcode-test.png]");
    expect(input?.attachments).toBeUndefined();
  });

  it("每条 USER_INPUT 开启新的一轮", () => {
    const rows = projectAgyHistory([
      { type: "USER_INPUT", created_at: ts(0), content: "a" },
      { type: "PLANNER_RESPONSE", created_at: ts(1), content: "A" },
      { type: "USER_INPUT", created_at: ts(10), content: "b" },
      { type: "CHECKPOINT", created_at: ts(11) },
    ]).snapshot();
    expect(ofKind(rows, "turnHeader").map((row) => [row.startedAt, row.endedAt])).toEqual([
      [T0, T0 + 1000],
      [T0 + 10_000, T0 + 11_000],
    ]);
    expect(ofKind(rows, "timelineMarker")).toHaveLength(1);
  });
});

describe("Antigravity 实时流", () => {
  it("step_update 的增量拼接、DONE 收尾，工具状态随事件更新", () => {
    const projector = new AgyRowProjector();
    const mirror = new RowsMirror(projector);
    projector.beginLocalTurn("go", T0);
    projector.streamStep({ step_type: "agent_response", step_index: 1, thinking_delta: "想", state: "RUNNING" }, T0 + 1);
    projector.streamStep({ step_type: "agent_response", step_index: 1, text_delta: "好的", state: "RUNNING" }, T0 + 2);
    expect(ofKind(mirror.flush(), "assistantText")[0]).toMatchObject({ text: "好的", state: "streaming" });
    projector.streamStep({ step_type: "agent_response", step_index: 1, text_delta: "。\n\n", state: "DONE" }, T0 + 3);
    projector.streamStep(
      { step_type: "tool", step_index: 2, tool_info: { name: "run_command", parameters: { CommandLine: "ls" } }, state: "RUNNING" },
      T0 + 4,
    );
    projector.streamStep(
      {
        step_type: "tool",
        step_index: 2,
        tool_info: { name: "run_command", parameters: { CommandLine: "ls" }, output: "a" },
        state: "DONE",
      },
      T0 + 5,
    );
    projector.streamStep({ step_type: "tool", step_index: 3, tool_name: "write_to_file", state: "ERROR", error_message: "denied" }, T0 + 6);
    projector.notice("有操作被拒绝", T0 + 7);
    projector.closeTurn(T0 + 7);
    const rows = mirror.flush();

    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "assistantText", "toolCall", "toolCall", "assistantText"]);
    expect(ofKind(rows, "reasoning")[0]).toMatchObject({ text: "想", state: "complete", durationMs: 2 });
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "好的。", state: "complete" });
    const [bash, write] = ofKind(rows, "toolCall");
    expect(bash).toMatchObject({ toolName: "Bash", status: "success", output: { text: "a" }, endedAt: T0 + 5 });
    expect(write).toMatchObject({ toolName: "Write", status: "error", error: { message: "denied" } });
    expect(rows).toEqual(projector.snapshot());
  });
});
