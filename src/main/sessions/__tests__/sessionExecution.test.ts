// 公开执行入口覆盖早到结果、发送失败与串回合；外部 CLI 以边界传输替代。
import { describe, expect, it, vi } from "vitest";
import type { ChatSendParams } from "../../../shared/types.js";
import { SessionExecutionService } from "../sessionExecutionService.js";

const params: ChatSendParams = { agent: "codex", sessionKey: "session", projectPath: "/project", permissionMode: "read-only", text: "research" };

describe("会话执行入口", () => {
  it("send 尚未返回时的真实失败不会被 idle 覆盖成成功", async () => {
    const service = new SessionExecutionService({ prepare: async (input) => input, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {},
      send: async (input) => { service.acceptOutcome({ sessionKey: input.sessionKey, agent: input.agent, executionTurnId: input.executionTurnId!, outcome: "failed", text: "", error: "quota" }); return { sessionKey: input.sessionKey }; },
    });
    const result = await service.execute(params, { root: "/project" }, new AbortController().signal);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("quota");
  });

  it("发送失败释放会话，可以再次尝试且不遗留等待", async () => {
    const service = new SessionExecutionService({ prepare: async () => { throw new Error("invalid attachment"); }, send: async () => ({ sessionKey: "session" }), interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {} });
    await expect(service.execute(params, { root: "/project" }, new AbortController().signal)).rejects.toThrow("invalid attachment");
    await expect(service.execute(params, { root: "/project" }, new AbortController().signal)).rejects.toThrow("invalid attachment");
  });
});

it("取消未获原生确认时保留锁，迟到可信终态才解锁", async () => {
  vi.useFakeTimers();
  let turnId = "";
  const abort = new AbortController();
  const service = new SessionExecutionService({ prepare: async (input) => input, send: async (input) => { turnId = input.executionTurnId!; return { sessionKey: input.sessionKey }; }, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {} });
  try {
    const result = service.execute(params, { root: "/project" }, abort.signal);
    const rejection = expect(result).rejects.toThrow("未收到原生中断确认");
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    await expect(service.send(params)).rejects.toThrow("中断未确认");
    service.acceptOutcome({ sessionKey: params.sessionKey, agent: "codex", executionTurnId: turnId, outcome: "cancelled", text: "" });
    expect(await service.send(params)).toEqual({ sessionKey: params.sessionKey });
  } finally { vi.useRealTimers(); }
});

it("窗口重开使用新 key，原生会话仍共享协作占用与普通回合锁", async () => {
  let turnId = "";
  const service = new SessionExecutionService({ prepare: async (input) => input, send: async (input) => { turnId = input.executionTurnId!; return { sessionKey: input.sessionKey }; }, interrupt: async () => {}, failedToSend: () => {}, finishedSending: () => {} });
  const nativeId = "native-source";
  const alias = { ...params, sessionKey: "new-window-key", resumeSessionId: nativeId };
  service.reserve(params.sessionKey, "run", `codex:${nativeId}`);
  await expect(service.send(alias)).rejects.toThrow("协作");
  service.release(params.sessionKey, "run");
  await service.send(alias);
  expect(() => service.reserve(params.sessionKey, "run", `codex:${nativeId}`)).toThrow("活动");
  service.acceptOutcome({ sessionKey: alias.sessionKey, agent: "codex", executionTurnId: turnId, outcome: "succeeded", text: "" });
  expect(() => service.reserve(params.sessionKey, "run", `codex:${nativeId}`)).not.toThrow();
});
