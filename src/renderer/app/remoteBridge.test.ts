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
});

afterEach(() => {
  bridge.disconnect();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("远程网页连接恢复", () => {
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
    const listener = vi.fn();
    bridge.on("chat:state", listener);
    await bridge.connect();
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockResolvedValueOnce(response({ seq: 10, rows: [], state, permissions: [] }));
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    events.send("chat:state", state, 9);
    expect(listener).toHaveBeenCalledTimes(1);
    events.send("chat:state", state, 11);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("页面订阅晚于连接恢复时仍收到已完成的会话状态", async () => {
    const state = { sessionKey: "session", state: "idle", completedAt: 1234 };
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
    const listener = vi.fn();
    bridge.on("chat:state", listener);
    await bridge.connect();
    let complete!: (value: Response) => void;
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const events = Events.instances[0]!;
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    events.onerror!();
    fetchMock.mockResolvedValueOnce(response([state]));
    fetchMock.mockResolvedValueOnce(response({ seq: 20, rows: [], state, permissions: [] }));
    events.send("hello", {});
    await vi.advanceTimersByTimeAsync(0);
    complete(response({ seq: 10, rows: [], state, permissions: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
