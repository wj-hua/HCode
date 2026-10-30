// 通过公开 store 动作验证插话：只替换 Electron IPC 与界面通知边界，未投递的内容必须回到队列。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type ChatSteerResult } from "@hcode/shared/types";

const { invoke, notify } = vi.hoisted(() => ({ invoke: vi.fn(), notify: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: vi.fn() } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: notify }));
import { useAppStore, type Conversation } from "./appStore";

const VIEW = "view";

function runningConversation(extra: Partial<Conversation> = {}): Conversation {
  return {
    viewId: VIEW, agent: "claude", projectPath: "/project", sessionId: "native", sessionKey: "live", rows: [], loading: false,
    runState: "running", permissionMode: "default", model: "", effort: "", codexSpeed: "", queue: [], ...extra,
  };
}

function deferredSteer() {
  let settle!: (result: ChatSteerResult) => void;
  invoke.mockImplementation((channel: string) => {
    if (channel === "chat:steer") return new Promise<ChatSteerResult>((resolve) => { settle = resolve; });
    if (channel === "chat:send") return Promise.resolve({ sessionKey: "live" });
    throw new Error(`未配置的 IPC: ${channel}`);
  });
  return (result: ChatSteerResult) => settle(result);
}

const conversation = () => useAppStore.getState().conversations[VIEW]!;

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  invoke.mockReset();
  notify.mockReset();
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, notifyOnFinish: false }, conversations: { [VIEW]: runningConversation() }, activeViewId: VIEW });
});

describe("回合中插话", () => {
  it("等待投递期间显示在插话列表，投递后移除且不进入队列", async () => {
    const settle = deferredSteer();
    useAppStore.getState().steer("只跑第一条", [], []);
    expect(invoke).toHaveBeenCalledWith("chat:steer", { sessionKey: "live", text: "只跑第一条" });
    expect(conversation().steering?.map((item) => item.text)).toEqual(["只跑第一条"]);
    settle({ delivered: true });
    await vi.waitFor(() => expect(conversation().steering).toEqual([]));
    expect(conversation().queue).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("未投递时提示原因并放回队列；用户已停止时保持暂停，不自动发送", async () => {
    const settle = deferredSteer();
    useAppStore.getState().steer("顺便改文案", [], []);
    useAppStore.setState({ conversations: { [VIEW]: { ...conversation(), runState: "idle", queuePaused: "stopped" } } });
    settle({ delivered: false, reason: "已停止，插话未送达" });
    await vi.waitFor(() => expect(conversation().queue.map((item) => item.text)).toEqual(["顺便改文案"]));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("已停止，插话未送达"), expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("chat:send", expect.anything());
  });

  it("回合恰好结束导致未投递时，会话已空闲就立即作为新消息发送", async () => {
    const settle = deferredSteer();
    useAppStore.getState().steer("再加一个测试", [], []);
    useAppStore.setState({ conversations: { [VIEW]: { ...conversation(), runState: "idle" } } });
    settle({ delivered: false, reason: "当前没有进行中的回合" });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("chat:send", expect.objectContaining({ sessionKey: "live", text: "再加一个测试" })));
    expect(conversation().queue).toEqual([]);
  });

  it("斜杠命令、对比组和不支持插话的 CLI 直接排队，不请求插话", () => {
    deferredSteer();
    useAppStore.getState().steer("/compact", [], []);
    useAppStore.setState({ conversations: { [VIEW]: { ...runningConversation({ agent: "agy" }), queue: conversation().queue } } });
    useAppStore.getState().steer("换个思路", [], []);
    useAppStore.setState({ conversations: { [VIEW]: { ...runningConversation({ compareId: "group" }), queue: conversation().queue } } });
    useAppStore.getState().steer("对比组里的消息", [], []);
    expect(conversation().queue.map((item) => item.text)).toEqual(["/compact", "换个思路", "对比组里的消息"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("排队消息可以立即插话，并从队列中取出", () => {
    deferredSteer();
    useAppStore.setState({ conversations: { [VIEW]: runningConversation({ agent: "codex", queue: [{ id: "q1", text: "先处理报错", images: [], files: [] }] }) } });
    useAppStore.getState().steerQueued("q1");
    expect(conversation().queue).toEqual([]);
    expect(conversation().steering?.map((item) => item.id)).toEqual(["q1"]);
    expect(invoke).toHaveBeenCalledWith("chat:steer", { sessionKey: "live", text: "先处理报错" });
  });
});
