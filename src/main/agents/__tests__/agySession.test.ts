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

  it("按最新步骤而非整轮累计量计算上下文容量，跨轮保留并在切模型或压缩时同步", async () => {
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stdin: { write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
    });
    const emit = (event: Record<string, unknown>) => stdout.emit("data", `${JSON.stringify(event)}\n`);
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => emit({ event: "init", conversation_id: "ctx-test", init: { model: "gemini-4-hydrogen-high" } }));
      return child as unknown as ReturnType<typeof spawn>;
    });
    const states: ChatStateEvent[] = [];
    const session = new AgySession({
      resolveLaunch: async () => ({ path: "agy", env: {}, cwd: "/test", args: [] }),
      emitRows: () => undefined,
      emitState: (event) => states.push(event),
      onSettled: () => undefined,
    }, { key: "ctx", projectPath: "/test", sessionId: "ctx-test", permissionMode: "default" });

    try {
      session.seedHistory([
        { type: "PLANNER_RESPONSE", step_index: 1, status: "DONE", model: "gemini-4-hydrogen-high", input_tokens: 80_000, cache_read_tokens: 20_000, output_tokens: 1_000 },
        { type: "CHECKPOINT", step_index: 2, status: "DONE" },
        { type: "PLANNER_RESPONSE", step_index: 3, status: "DONE", model: "gemini-4-hydrogen-high", input_tokens: 5_000, cache_read_tokens: 15_000, output_tokens: 480 },
      ]);
      session.emitState();
      expect(states.at(-1)?.usage).toMatchObject({
        contextUsedTokens: 20_480,
        contextWindowTokens: 1_048_576,
      });

      await session.send("继续");
      expect(states.at(-1)?.usage).toMatchObject({
        contextUsedTokens: 20_480,
        contextWindowTokens: 1_048_576,
      });

      emit({ event: "step_update", step_update: { step_type: "agent_response", step_index: 5, state: "DONE", duration_seconds: 1, usage: { input_tokens: 4_000, cache_read_tokens: 20_480, output_tokens: 520 } } });
      emit({ event: "step_update", step_update: { step_type: "agent_response", step_index: 7, state: "DONE", duration_seconds: 2, usage: { input_tokens: 6_000, cache_read_tokens: 25_000, output_tokens: 1_000 } } });
      emit({ event: "result", result: { conversation_id: "ctx-test", response: "完成", status: "SUCCESS", num_turns: 2, usage: { input_tokens: 95_000, cache_read_tokens: 80_480, output_tokens: 3_000 } } });
      // 多步回合取最后一步的上下文占用（32,000），而非多步计费累计和
      expect(states.at(-1)?.usage).toMatchObject({
        contextUsedTokens: 32_000,
        contextWindowTokens: 1_048_576,
      });

      await session.setModel("claude-sonnet-4-6");
      expect(states.at(-1)?.usage).toMatchObject({
        contextUsedTokens: 32_000,
        contextWindowTokens: 250_000,
        contextUsedPercent: 12.8,
      });

      await session.send("触发压缩");
      emit({ event: "step_update", step_update: { step_type: "checkpoint", step_index: 9, state: "DONE" } });
      expect(states.at(-1)?.usage?.contextUsedTokens).toBeUndefined();
    } finally {
      session.close();
    }
  });
});
