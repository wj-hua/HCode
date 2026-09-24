import { describe, expect, it } from "vitest";
import {
  CodexRowProjector,
  parseUnifiedDiff,
  projectCodexTurns,
  unwrapShellCommand,
  type CodexItem,
  type CodexTurn,
} from "../codex/codexProjector.js";
import { kinds, ofKind, RowsMirror } from "./helpers.js";

const S0 = 1_767_225_600; // codex 的时间戳单位是秒

function turn(items: CodexItem[], extra: Partial<CodexTurn> = {}): CodexTurn {
  return { id: "turn-a", items, status: "completed", startedAt: S0, completedAt: S0 + 4, durationMs: 4000, ...extra };
}

const userMessage = (text: string): CodexItem => ({ type: "userMessage", id: "u", content: [{ type: "text", text }] });

describe("unwrapShellCommand", () => {
  it.each([
    [`/bin/zsh -lc "printf 'hi' > a.txt"`, `printf 'hi' > a.txt`],
    [`/bin/bash -lc 'echo '\\''quoted'\\'''`, `echo 'quoted'`],
    [`/bin/sh -c "echo \\"\\$HOME\\""`, `echo "$HOME"`],
    [`/bin/zsh -lc ls`, `ls`],
    [`git status`, `git status`],
  ])("%s", (input, expected) => {
    expect(unwrapShellCommand(input)).toBe(expected);
  });
});

describe("parseUnifiedDiff", () => {
  it("解析多个 hunk 并统计增删行", () => {
    const diff = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10 +10,2 @@\n x\n+y\n";
    const parsed = parseUnifiedDiff(diff, "update");
    expect(parsed.additions).toBe(2);
    expect(parsed.deletions).toBe(1);
    expect(parsed.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" a", "-b", "+B", " c"] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" x", "+y"] },
    ]);
  });

  it("跳过 ---/+++ 文件头并兼容 CRLF", () => {
    const parsed = parseUnifiedDiff("--- a/f\r\n+++ b/f\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n", "update");
    expect(parsed).toMatchObject({ additions: 1, deletions: 1 });
    expect(parsed.hunks[0]?.lines).toEqual(["-a", "+b"]);
  });

  it("没有 @@ 时按新建 / 删除的全文处理", () => {
    expect(parseUnifiedDiff("l1\nl2\n", "add")).toEqual({
      additions: 2,
      deletions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+l1", "+l2"] }],
    });
    expect(parseUnifiedDiff("gone\n", "delete")).toEqual({
      additions: 0,
      deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-gone"] }],
    });
  });
});

describe("Codex 历史投影", () => {
  it("命令、读文件、改文件映射到 ZCode 工具族", () => {
    const rows = projectCodexTurns([
      turn([
        userMessage("修一下"),
        { type: "reasoning", id: "r1", summary: ["先读", "再改"] },
        {
          type: "commandExecution",
          id: "c1",
          command: `/bin/zsh -lc "cat src/a.ts"`,
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "const a = 1;",
          commandActions: [{ type: "read", path: "src/a.ts" }],
        },
        {
          type: "commandExecution",
          id: "c2",
          command: "/bin/zsh -lc 'pnpm test'",
          cwd: "/repo",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: "",
        },
        {
          type: "fileChange",
          id: "f1",
          status: "completed",
          changes: [{ path: "src/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n" }],
        },
        { type: "agentMessage", id: "m1", text: "改好了" },
      ]),
    ]).snapshot();

    expect(kinds(rows)).toEqual(["turnHeader", "userInput", "reasoning", "toolCall", "toolCall", "toolCall", "assistantText"]);
    expect(ofKind(rows, "turnHeader")[0]).toMatchObject({
      turnId: "turn-a",
      state: "completedSuccess",
      startedAt: S0 * 1000,
      activeMs: 4000,
    });
    expect(ofKind(rows, "reasoning")[0]?.text).toBe("先读\n\n再改");

    const [read, bash, patch] = ofKind(rows, "toolCall");
    expect(read).toMatchObject({ toolName: "Read", status: "success", input: { file_path: "src/a.ts", command: "cat src/a.ts" } });
    expect(bash).toMatchObject({
      toolName: "Bash",
      status: "error",
      input: { command: "pnpm test", cwd: "/repo" },
      error: { code: "exit_code", message: "退出码 1" },
    });
    expect(patch).toMatchObject({
      toolName: "ApplyPatch",
      status: "success",
      output: { text: "src/a.ts (+1 -1)", display: { kind: "file_diffs" } },
    });
  });

  it("MCP、搜索与计划类 item", () => {
    const rows = projectCodexTurns([
      turn([
        userMessage("查一下"),
        {
          type: "mcpToolCall",
          id: "mcp1",
          server: "docs",
          tool: "search",
          arguments: { q: "x" },
          status: "completed",
          result: { content: [{ type: "text", text: "hit" }] },
        },
        { type: "mcpToolCall", id: "mcp2", server: "docs", tool: "fetch", arguments: {}, status: "failed", error: { message: "denied" } },
        { type: "webSearch", id: "w1", query: "vitest" },
      ]),
    ]).snapshot();
    const [ok, failed, search] = ofKind(rows, "toolCall");
    expect(ok).toMatchObject({ toolName: "mcp__docs__search", status: "success", output: { text: "hit" } });
    expect(failed).toMatchObject({ toolName: "mcp__docs__fetch", status: "error", error: { message: "denied" } });
    expect(search).toMatchObject({ toolName: "WebSearch", input: { query: "vitest" } });
  });

  it("中断与失败的轮次", () => {
    const rows = projectCodexTurns([
      turn([userMessage("a"), { type: "agentMessage", id: "m1", text: "半截" }], { id: "t1", status: "interrupted" }),
      turn([userMessage("b")], { id: "t2", status: "failed", error: { message: "rate limited" } }),
    ]).snapshot();
    const headers = ofKind(rows, "turnHeader");
    expect(headers.map((header) => header.state)).toEqual(["completedInterrupted", "failed"]);
    expect(ofKind(rows, "assistantText").at(-1)).toMatchObject({ turnId: "t2", text: "rate limited", state: "failed" });
  });

  it("没有 userMessage 的轮次自动补一个轮次头", () => {
    const rows = projectCodexTurns([turn([{ type: "agentMessage", id: "m1", text: "自动继续" }])]).snapshot();
    expect(kinds(rows)).toEqual(["turnHeader", "assistantText"]);
  });
});

describe("Codex 实时流", () => {
  it("本地气泡跳过服务端回显，正文按增量拼接", () => {
    const projector = new CodexRowProjector();
    const mirror = new RowsMirror(projector);
    const at = S0 * 1000;
    projector.beginLocalTurn("hello", at);
    projector.itemStarted(userMessage("hello"), at + 1);
    projector.itemStarted({ type: "reasoning", id: "r1" }, at + 2);
    projector.appendText("r1", "想", "\n\n");
    projector.appendText("r1", "法", "\n\n");
    projector.itemStarted({ type: "agentMessage", id: "m1", text: "" }, at + 3);
    projector.appendText("m1", "Hi");
    mirror.flush();
    projector.appendText("m1", " there");
    expect(ofKind(mirror.flush(), "assistantText")[0]).toMatchObject({ text: "Hi there", state: "streaming" });
    projector.itemCompleted({ type: "reasoning", id: "r1", summary: [] }, at + 10);
    projector.itemCompleted({ type: "agentMessage", id: "m1", text: "Hi there!" }, at + 11);
    projector.finishTurn({ status: "completed", durationMs: 11 }, at + 11);
    const rows = mirror.flush();

    expect(ofKind(rows, "userInput")).toHaveLength(1);
    // 推理增量之间加分隔符；完成时 summary 为空则保留流式内容
    expect(ofKind(rows, "reasoning")[0]).toMatchObject({ text: "想\n\n法", state: "complete", durationMs: 8 });
    expect(ofKind(rows, "assistantText")[0]).toMatchObject({ text: "Hi there!", state: "complete" });
    expect(rows).toEqual(projector.snapshot());
  });

  it("命令实时输出整段替换，完成后审批拒绝的保持已取消", () => {
    const projector = new CodexRowProjector();
    const mirror = new RowsMirror(projector);
    const at = S0 * 1000;
    projector.beginLocalTurn("run", at);
    const command: CodexItem = { type: "commandExecution", id: "c1", command: "ls", status: "inProgress" };
    projector.itemStarted(command, at + 1);
    projector.appendToolOutput("c1", "a\n");
    projector.appendToolOutput("c1", "b\n");
    expect(ofKind(mirror.flush(), "toolCall")[0]).toMatchObject({ status: "running", output: { text: "a\nb\n" } });

    projector.itemStarted({ type: "commandExecution", id: "c2", command: "rm x", status: "inProgress" }, at + 2);
    projector.setToolPendingApproval("c2", "Bash", {}, "ix", at + 2);
    projector.resolveToolApproval("c2", false);
    projector.itemCompleted({ type: "commandExecution", id: "c2", command: "rm x", status: "declined" }, at + 3);
    projector.itemCompleted({ ...command, status: "completed", exitCode: 0, aggregatedOutput: "a\nb\n" }, at + 4);
    const rows = mirror.flush();
    expect(ofKind(rows, "toolCall").map((row) => row.status)).toEqual(["success", "cancelled"]);
    expect(projector.itemInput("c1")).toEqual({ command: "ls" });
    expect(rows).toEqual(projector.snapshot());
  });

  it("计划更新：每轮一张 TodoWrite 卡片原地更新", () => {
    const projector = new CodexRowProjector();
    const at = S0 * 1000;
    projector.beginLocalTurn("plan", at);
    projector.updatePlan([{ step: "读代码", status: "inProgress" }, { step: "改代码", status: "pending" }], at + 1);
    projector.updatePlan([{ step: "读代码", status: "completed" }, { step: "改代码", status: "inProgress" }], at + 2);
    const todos = ofKind(projector.snapshot(), "toolCall");
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({
      toolName: "TodoWrite",
      input: {
        todos: [
          { content: "读代码", status: "completed" },
          { content: "改代码", status: "in_progress" },
        ],
      },
    });
  });
});
