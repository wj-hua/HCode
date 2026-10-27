import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReverseTunnel } from "../tunnel.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), networkInterfaces: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:os", () => ({ networkInterfaces: mocks.networkInterfaces }));

const config = { sshHost: "test-host", remoteBind: "localhost:12345", localPort: 12346 };
type Child = EventEmitter & { stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
let children: Child[];
let tunnel: ReverseTunnel;

beforeEach(() => {
  vi.useFakeTimers();
  mocks.spawn.mockReset();
  mocks.networkInterfaces.mockReturnValue({});
  children = [];
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn(() => true) });
    children.push(child);
    return child as unknown as ChildProcess;
  });
  tunnel = new ReverseTunnel(() => ({}), () => {});
});

afterEach(() => {
  tunnel.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("反向隧道恢复", () => {
  it("切换配置时等待旧进程关闭，随后使用最新端口", () => {
    tunnel.start(config);
    tunnel.start({ ...config, localPort: 12347 });
    tunnel.start({ ...config, localPort: 12348 });
    expect(children).toHaveLength(1);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    children[0]!.emit("close", 0);
    expect(children).toHaveLength(2);
    expect(mocks.spawn.mock.calls[1]![1]).toContain("localhost:12345:127.0.0.1:12348");
  });

  it("连续网络通知合并，关闭服务后不再重连", () => {
    tunnel.start(config);
    tunnel.reconnect();
    vi.advanceTimersByTime(1000);
    tunnel.reconnect();
    vi.advanceTimersByTime(1000);
    expect(children[0]!.kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    tunnel.stop();
    children[0]!.emit("close", 0);
    vi.advanceTimersByTime(60_000);
    expect(children).toHaveLength(1);
    expect(tunnel.getStatus().state).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("网络地址变化后自动重建连接", () => {
    tunnel.start(config);
    children[0]!.stderr.write("remote forward success\n");
    mocks.networkInterfaces.mockReturnValue({ en0: [{ internal: false, family: "IPv4", address: "192.0.2.1" }] });
    vi.advanceTimersByTime(4000);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
    children[0]!.emit("close", 0);
    expect(children).toHaveLength(2);
  });

  it("旧进程拒绝退出时强制结束，仍等待关闭通知才重连", () => {
    tunnel.start(config);
    tunnel.reconnect();
    vi.advanceTimersByTime(4000);
    expect(children[0]!.kill).toHaveBeenLastCalledWith("SIGKILL");
    expect(children).toHaveLength(1);
    children[0]!.emit("close", null);
    expect(children).toHaveLength(2);
  });

  it("认证或转发阶段卡住时结束进程并退避重试", () => {
    tunnel.start(config);
    vi.advanceTimersByTime(22_000);
    expect(children[0]!.kill).toHaveBeenLastCalledWith("SIGKILL");
    children[0]!.emit("close", null);
    expect(tunnel.getStatus().error).toContain("超时");
    vi.advanceTimersByTime(999);
    expect(children).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(children).toHaveLength(2);
  });

  it("远端端口占用时持续每两秒重试", () => {
    tunnel.start(config);
    for (let i = 0; i < 6; i++) {
      children[i]!.stderr.write("remote port forwarding failed\n");
      children[i]!.emit("close", 255);
      expect(tunnel.getStatus().error).toContain("2 秒后重试");
      vi.advanceTimersByTime(2000);
    }
    expect(children).toHaveLength(7);
  });

  it("识别分段成功日志，并忽略旧进程的迟到事件", () => {
    tunnel.start(config);
    children[0]!.stderr.write("remote forward suc");
    children[0]!.stderr.write("cess\n");
    expect(tunnel.getStatus().state).toBe("connected");
    tunnel.start({ ...config, localPort: 12347 });
    children[0]!.emit("close", 0);
    children[0]!.stderr.write("remote forward success\n");
    children[0]!.emit("error", new Error("late error"));
    expect(tunnel.getStatus().state).toBe("connecting");
    expect(children).toHaveLength(2);
  });

  it("启动失败的 error 和 close 只安排一次重试", () => {
    tunnel.start(config);
    children[0]!.emit("error", new Error("spawn failed"));
    children[0]!.emit("close", -1);
    vi.advanceTimersByTime(2000);
    expect(children).toHaveLength(2);
  });
});
