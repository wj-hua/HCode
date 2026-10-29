import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRemoteBridge, RemoteUnauthorizedError } from "./remoteBridge";

class Events extends EventTarget {
  static CLOSED = 2;
  static instances: Events[] = [];
  readyState = 1;
  onerror: (() => void) | null = null;
  close = vi.fn(() => { this.readyState = Events.CLOSED; });
  constructor(readonly url: string) {
    super();
    Events.instances.push(this);
  }
  send(type: string, data: unknown, id = 0) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) }));
  }
}

const response = (result: unknown = []) => Response.json({ ok: true, result });
let fetchMock: ReturnType<typeof vi.fn>;
let bridge: ReturnType<typeof createRemoteBridge>;

beforeEach(() => {
  vi.useFakeTimers();
  Events.instances = [];
  fetchMock = vi.fn().mockImplementation(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Events);
  bridge = createRemoteBridge();
  bridge.setViewedSessions(["session", "slow", "quick"]);
});

afterEach(() => {
  bridge.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("远程网页连接恢复", () => {
  it("普通打开走分页，搜索等完整读取保留全量接口", async () => {
    const ref = { agent: "codex" as const, id: "history", projectPath: "/project" };
    await bridge.invoke("sessions:load", ref);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).channel).toBe("sessions:page");
    await bridge.invoke("sessions:load", ref, { complete: true });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).channel).toBe("sessions:load");
  });

  it("未查看会话的审批在页面晚订阅时仍可恢复", async () => {
    bridge.setViewedSessions([]);
    routeInvoke({ "chat:live": () => response([{ sessionKey: "other" }]) });
    await bridge.connect();
    const permission = { sessionKey: "other", interactionId: "approval" };
    Events.instances[0]!.send("hello", { permissions: [permission] });
    await vi.advanceTimersByTimeAsync(0);
    const listener = vi.fn();
    bridge.on("permission:requested", listener);
    expect(listener).toHaveBeenCalledWith(permission);
  });
  it("通过宿主浏览项目目录", async () => {
    const listing = { path: "/home", parent: "/", directories: [] };
    fetchMock.mockResolvedValueOnce(response(listing));
    await expect(bridge.invoke("projects:browseDirectories", "/home", true)).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenCalledWith("api/invoke", expect.objectContaining({ body: JSON.stringify({ channel: "projects:browseDirectories", args: ["/home", true] }) }));
  });
  it("通过宿主读取项目分支", async () => {
    fetchMock.mockResolvedValueOnce(response({ current: "main", branches: ["main"] }));
    await expect(bridge.invoke("git:branches", "/project")).resolves.toEqual({ current: "main", branches: ["main"] });
    expect(fetchMock).toHaveBeenCalledWith("api/invoke", expect.objectContaining({ body: JSON.stringify({ channel: "git:branches", args: ["/project"] }) }));
  });
  it("首次连接失败后可以重试，认证失败仍返回登录状态", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(bridge.connect()).rejects.toThrow("503");
    expect(Events.instances).toHaveLength(0);
    await bridge.connect();
    expect(Events.instances).toHaveLength(1);
    bridge.disconnect();
    fetchMock.mockResolvedValueOnce(Response.json({ ok: false }, { status: 401 }));
    await expect(bridge.connect()).rejects.toBeInstanceOf(RemoteUnauthorizedError);
  });

  it("已取消的首次请求即使稍后返回，也不会遗留事件连接", async () => {
    let complete!: (value: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const pending = bridge.connect(controller.signal);
    controller.abort();
    complete(response());
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(Events.instances).toHaveLength(0);
  });

  it("断线通知界面，停止连接后取消待执行的自动重连", async () => {
    const changes = vi.fn();
    bridge.onConnectionChange(changes);
    await bridge.connect();
    const events = Events.instances[0]!;
    events.send("hello", { seq: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toHaveBeenLastCalledWith("connected");
    events.readyState = Events.CLOSED;
    events.onerror!();
    expect(changes).toHaveBeenLastCalledWith("disconnected");
    bridge.disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Events.instances).toHaveLength(1);
  });

  it("浏览器停止自动重连后主动重新打开事件流", async () => {
    await bridge.connect();
    const events = Events.instances[0]!;
    events.readyState = Events.CLOSED;
    events.onerror!();
    await vi.advanceTimersByTimeAsync(3000);
    expect(Events.instances).toHaveLength(2);
    expect(events.close).toHaveBeenCalled();
  });

  it("快照恢复失败后继续重试，不停留在已连接的假状态", async () => {
    const changes = vi.fn();
    bridge.onConnectionChange(changes);
    await bridge.connect();
    fetchMock.mockRejectedValueOnce(new Error("network interrupted"));
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toHaveBeenLastCalledWith("disconnected");
    await vi.advanceTimersByTimeAsync(3000);
    expect(Events.instances).toHaveLength(2);
  });

  it("重连后用快照恢复状态，并丢弃快照之前的重复事件", async () => {
    const state = { sessionKey: "session" };
    const rows = vi.fn();
    bridge.on("chat:rows", rows);
    await bridge.connect();
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockResolvedValueOnce(response({ seq: 10, rows: [], state, permissions: [] }));
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toHaveBeenCalledTimes(1);
    events.send("chat:rows", { sessionKey: "session", ops: [] }, 9);
    expect(rows).toHaveBeenCalledTimes(1);
    events.send("chat:rows", { sessionKey: "session", ops: [] }, 11);
    expect(rows).toHaveBeenCalledTimes(2);
  });

  it("页面订阅晚于连接恢复时仍收到已完成的会话状态", async () => {
    const state = { sessionKey: "session", state: "idle" };
    await bridge.connect();
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockResolvedValueOnce(response({ seq: 10, rows: [], state, permissions: [] }));
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    const listener = vi.fn();
    bridge.on("chat:state", listener);
    expect(listener).toHaveBeenCalledWith(state);
  });

  it("同一事件流再次恢复后，迟到的旧快照不会覆盖新快照", async () => {
    const state = { sessionKey: "session" };
    const rows = vi.fn();
    bridge.on("chat:rows", rows);
    await bridge.connect();
    let complete!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    events.onerror!();
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockResolvedValueOnce(response({ seq: 20, rows: [{ id: "new" }], state, permissions: [] }));
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    complete(response({ seq: 10, rows: [{ id: "old" }], state, permissions: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenLastCalledWith({ sessionKey: "session", ops: [{ op: "reset", rows: [{ id: "new" }] }] });
  });
});

/** 按通道响应 invoke，便于模拟某个会话的快照单独失败。 */
function routeInvoke(routes: Record<string, (args: unknown[]) => Response | Promise<Response>>) {
  fetchMock.mockImplementation(async (_path: string, init: RequestInit) => {
    const { channel, args } = JSON.parse(String(init.body)) as { channel: string; args: unknown[] };
    return routes[channel]?.(args) ?? response();
  });
}

describe("慢速网络下的会话同步", () => {
  const slow = { sessionKey: "slow" };
  const quick = { sessionKey: "quick" };

  it("只下载正在查看的会话快照，其他会话保留运行状态", async () => {
    bridge.setViewedSessions(["slow"]);
    const snapshot = vi.fn(([key]) => response({ seq: 3, rows: [], state: { sessionKey: key }, permissions: [] }));
    routeInvoke({ "chat:live": () => response([slow, quick]), "chat:snapshot": snapshot });
    const states = vi.fn();
    bridge.on("chat:state", states);
    await bridge.connect();
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith(["slow"]);
    expect(states).toHaveBeenCalledWith(quick);
  });

  it("切换查看的会话会真正取消旧快照下载", async () => {
    bridge.setViewedSessions(["slow"]);
    let oldSignal!: AbortSignal;
    fetchMock.mockImplementation(async (_path, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.channel === "chat:live") return response([slow, quick]);
      if (request.args[0] === "slow") { oldSignal = init.signal!; return new Promise<Response>(() => {}); }
      return response({ seq: 4, rows: [], state: quick, permissions: [] });
    });
    await bridge.connect();
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    bridge.setViewedSessions(["quick"]);
    expect(oldSignal.aborted).toBe(true);
    expect(Events.instances[0]!.close).toHaveBeenCalled();
  });

  it("单个会话快照失败时保持事件流，只退避重试该会话", async () => {
    let slowFailures = 1;
    routeInvoke({
      "chat:live": () => response([slow, quick]),
      "chat:snapshot": ([key]) => {
        if (key === "slow" && slowFailures-- > 0) throw new Error("timeout");
        return response({ seq: 5, rows: [{ id: `${String(key)}-row` }], state: { sessionKey: key }, permissions: [] });
      },
    });
    const changes = vi.fn();
    const rows = vi.fn();
    bridge.onConnectionChange(changes);
    bridge.on("chat:rows", rows);
    await bridge.connect();
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(rows).toHaveBeenCalledWith({ sessionKey: "quick", ops: [{ op: "reset", rows: [{ id: "quick-row" }] }] });
    expect(changes).toHaveBeenLastCalledWith("syncing");
    await vi.advanceTimersByTimeAsync(3000);
    expect(rows).toHaveBeenCalledWith({ sessionKey: "slow", ops: [{ op: "reset", rows: [{ id: "slow-row" }] }] });
    expect(changes).toHaveBeenLastCalledWith("connected");
    expect(Events.instances).toHaveLength(1);
    expect(Events.instances[0]!.close).not.toHaveBeenCalled();
  });

  it("等待快照期间收到的会话事件，快照到达后只补发更新的部分", async () => {
    let complete!: (value: Response) => void;
    routeInvoke({
      "chat:live": () => response([slow]),
      "chat:snapshot": () => new Promise<Response>((resolve) => { complete = resolve; }),
    });
    const rows = vi.fn();
    bridge.on("chat:rows", rows);
    await bridge.connect();
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    events.send("chat:rows", { sessionKey: "slow", ops: [{ op: "included" }] }, 7);
    events.send("chat:rows", { sessionKey: "slow", ops: [{ op: "later" }] }, 8);
    expect(rows).not.toHaveBeenCalled();
    complete(response({ seq: 7, rows: [], state: slow, permissions: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(rows.mock.calls.map(([event]) => event.ops[0].op)).toEqual(["reset", "later"]);
  });

  it("活动会话的运行状态先于快照更新", async () => {
    routeInvoke({
      "chat:live": () => response([{ sessionKey: "slow", state: "running" }]),
      "chat:snapshot": () => new Promise<Response>(() => {}),
    });
    const states = vi.fn();
    bridge.on("chat:state", states);
    await bridge.connect();
    Events.instances[0]!.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toHaveBeenCalledWith({ sessionKey: "slow", state: "running" });
  });

  it("断线期间已处理的审批在会话快照到达后关闭", async () => {
    const permission = { sessionKey: "slow", interactionId: "approval" };
    routeInvoke({
      "chat:live": () => response([slow]),
      "chat:snapshot": () => response({ seq: 3, rows: [], state: slow, permissions: [] }),
    });
    const resolved = vi.fn();
    bridge.on("permission:resolved", resolved);
    await bridge.connect();
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    events.send("permission:requested", permission, 4);
    events.onerror!();
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toHaveBeenCalledWith({ sessionKey: "slow", interactionId: "approval" });
  });
});
