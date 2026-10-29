import { describe, expect, it, vi } from "vitest";
import type { AgentKind, ChatStateEvent, SessionSummary } from "../../../shared/types.js";
import { AgentRegistry } from "../registry.js";
import type { AgentProvider, AgentSendParams } from "../types.js";

function fixture(agent: AgentKind = "codex") {
  const history: SessionSummary[] = [];
  const changed = vi.fn();
  const send = vi.fn(async (params: AgentSendParams) => ({ sessionKey: params.sessionKey }));
  const providers = Object.fromEntries((["claude", "codex", "agy"] as const).map(kind => [kind, {
    kind, listSessions: async () => history.filter(session => session.agent === kind), send,
  }])) as unknown as Record<AgentKind, AgentProvider>;
  const registry = new AgentRegistry(providers, changed);
  const params: AgentSendParams = { agent, sessionKey: "new-view", projectPath: "/project", text: "\n 修复登录\n详细要求", permissionMode: "default" };
  const state: ChatStateEvent = { ...params, sessionId: "new-native", state: "running" };
  return { registry, history, changed, send, params, state };
}

describe("跨端新会话列表", () => {
  it.each<AgentKind>(["claude", "codex", "agy"])("%s 通知优先使用当前列表标题，未收录时使用新会话占位", async agent => {
    const { registry, history, params, state } = fixture(agent);
    await registry.send(params);
    expect(await registry.sessionTitle({ ...state, sessionId: undefined })).toBe("修复登录");
    registry.observeState(state);
    expect(await registry.sessionTitle(state)).toBe("修复登录");
    history.push({ id: state.sessionId!, agent, projectPath: params.projectPath, title: "正式标题", createdAt: 1, updatedAt: 2 });
    expect(await registry.sessionTitle(state)).toBe("正式标题");
    history[0]!.title = "重命名后的标题";
    expect(await registry.sessionTitle(state)).toBe("重命名后的标题");
    expect(await registry.sessionTitle({ ...state, projectPath: "/other" })).toBeUndefined();
    expect(await registry.sessionTitle({ ...state, sessionId: "different" })).toBeUndefined();
  });

  it.each<AgentKind>(["claude", "codex", "agy"])("%s 历史仍为空时，原生 ID 在发送返回前到达也立即可列出", async agent => {
    const { registry, changed, send, params, state } = fixture(agent);
    send.mockImplementation(async () => {
      registry.observeState({ ...state, sessionId: undefined });
      expect(changed).not.toHaveBeenCalled();
      registry.observeState(state);
      return { sessionKey: params.sessionKey };
    });
    await registry.send(params);
    const sessions = await registry.allSessions();
    expect(sessions).toEqual([expect.objectContaining({ id: state.sessionId, agent, projectPath: params.projectPath, title: "修复登录" })]);
    registry.observeState(state);
    expect(changed).toHaveBeenCalledExactlyOnceWith([params.projectPath]);
    registry.observeState({ ...state, state: "idle" });
    expect(await registry.allSessions()).toEqual(sessions);
  });

  it("历史收录后使用正式标题且不重复，归档后占位不会再次出现", async () => {
    const { registry, history, params, state } = fixture();
    await registry.send(params);
    registry.observeState(state);
    history.push({ id: state.sessionId!, agent: params.agent, projectPath: params.projectPath, title: "正式标题", createdAt: 1, updatedAt: 2 });
    expect(await registry.allSessions()).toEqual(history);
    history.length = 0;
    registry.observeState({ ...state, state: "idle" });
    expect(await registry.allSessions()).toEqual([]);
  });

  it("删除尚未进入历史的会话后，迟到的状态不能将它补回", async () => {
    const { registry, params, state } = fixture();
    await registry.send(params);
    registry.observeState(state);
    registry.forgetSession({ agent: params.agent, projectPath: params.projectPath, id: state.sessionId! });
    registry.observeState({ ...state, state: "idle" });
    expect(await registry.allSessions()).toEqual([]);
  });

  it("不同 CLI 或项目的同名 ID 不会覆盖占位或提前确认历史已收录", async () => {
    const { registry, history, changed, params, state } = fixture();
    await registry.send(params);
    registry.observeState({ ...state, agent: "claude" });
    registry.observeState({ ...state, projectPath: "/other" });
    expect(changed).not.toHaveBeenCalled();
    expect(await registry.allSessions()).toEqual([]);
    registry.observeState(state);
    history.push({ id: state.sessionId!, agent: "claude", projectPath: params.projectPath, title: "其他 CLI", createdAt: 1, updatedAt: 2 });
    expect(await registry.allSessions()).toHaveLength(2);
  });

  it.each<Partial<AgentSendParams>>([
    { research: { root: "/project" } },
    { onNativeSession: async () => {} },
    { resumeSessionId: "saved-native" },
  ])("内部执行和历史续聊不作为新会话补入：%j", async extra => {
    const { registry, changed, params, state } = fixture();
    await registry.send({ ...params, ...extra });
    registry.observeState(state);
    expect(changed).not.toHaveBeenCalled();
    expect(await registry.allSessions()).toEqual([]);
  });

  it("发送失败且未建立原生身份时清除占位，重试使用新的首条消息", async () => {
    const { registry, send, params, state } = fixture();
    send.mockRejectedValueOnce(new Error("启动失败"));
    await expect(registry.send(params)).rejects.toThrow("启动失败");
    registry.observeState(state);
    expect(await registry.allSessions()).toEqual([]);
    await registry.send({ ...params, text: "重试消息" });
    registry.observeState(state);
    expect(await registry.allSessions()).toEqual([expect.objectContaining({ title: "重试消息" })]);
  });
});

it("手动刷新明确要求所有 provider 重建索引，错误不伪装为空列表", async () => {
  const provider = { listSessions: vi.fn().mockRejectedValue(new Error("index unavailable")) };
  const registry = new AgentRegistry({ codex: provider } as unknown as Record<AgentKind, AgentProvider>, vi.fn());
  await expect(registry.allSessions(true)).rejects.toThrow("index unavailable");
  expect(provider.listSessions).toHaveBeenCalledWith(true);
});
