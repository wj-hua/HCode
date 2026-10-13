import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStateEvent } from "../../../shared/types.js";
import { AgySession } from "../agy/agySession.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe("Antigravity 会话指标传递", () => {
  it("首次工具参数实时推送 TTFT，result 按本轮用量显示原生响应速度并清空下一轮", async () => {
    let at = 0;
    vi.spyOn(performance, "now").mockImplementation(() => at);
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    });
    const emit = (event: Record<string, unknown>) => stdout.emit("data", `${JSON.stringify(event)}\n`);
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => emit({ event: "init", conversation_id: "test" }));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const states: ChatStateEvent[] = [];
    const session = new AgySession({
      resolveLaunch: async () => ({ path: "agy", env: {}, cwd: "/test", args: [] }),
      emitRows: () => undefined,
      emitState: (event) => states.push(event),
      onSettled: () => undefined,
    }, { key: "metrics", projectPath: "/test", permissionMode: "on-request" });
    const step = (update: Record<string, unknown>) => emit({ event: "step_update", step_update: update });
    const result = (input: number, output: number, turns: number) => emit({ event: "result", result: {
      conversation_id: "test", response: "完成", status: "SUCCESS", num_turns: turns,
      usage: { input_tokens: input, cache_read_tokens: input * 2, output_tokens: output },
    } });
    try {
      await session.send("继续");
      at = 250;
      step({ step_type: "agent_response", step_index: 1, state: "DONE", duration_seconds: 2, usage: { output_tokens: 100 } });
      step({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_info: { name: "run_command", parameters: { CommandLine: "ls" } } });
      expect(states.at(-1)?.usage).toEqual({ ttftMs: 250 });
      at = 364800;
      step({ step_type: "tool", step_index: 2, state: "DONE", tool_info: { output: "结果" } });
      step({ step_type: "agent_response", step_index: 3, state: "DONE", text_delta: "完成", duration_seconds: 3, usage: { output_tokens: 150 } });
      result(1000, 250, 1);
      expect(states.at(-1)).toMatchObject({ state: "idle", usage: {
        inputTokens: 3000, outputTokens: 250, ttftMs: 250,
        outputTokensPerSecond: 50, outputSpeedBasis: "response", outputSpeedDurationMs: 5000,
      } });
      const count = states.length;
      result(1000, 250, 1);
      expect(states).toHaveLength(count);
      await session.send("下一轮");
      expect(states.at(-1)?.usage).toEqual({});
      at += 500;
      step({ step_type: "agent_response", step_index: 5, state: "DONE", text_delta: "新回复", duration_seconds: 4, usage: { output_tokens: 200 } });
      result(2000, 450, 2);
      expect(states.at(-1)?.usage).toMatchObject({ inputTokens: 3000, outputTokens: 200, ttftMs: 500, outputTokensPerSecond: 50 });
    } finally {
      session.close();
    }
  });
});
