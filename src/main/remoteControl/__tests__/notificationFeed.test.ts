import { expect, it, vi } from "vitest";
import type { ChatStateEvent, ConversationRow, PermissionRequestEvent } from "../../../shared/types.js";
import { NotificationFeed } from "../notificationFeed.js";

const state = (sessionKey: string, value: ChatStateEvent["state"], extra: Partial<ChatStateEvent> = {}): ChatStateEvent => ({
  sessionKey, agent: "claude", projectPath: "/Users/me/Projects/GTools", state: value, permissionMode: "default", ...extra,
});

const permission = (sessionKey: string): PermissionRequestEvent => ({
  sessionKey, interactionId: "i1", toolUseId: "t1", toolName: "Bash", input: { command: "rm -rf secret" },
  title: "运行 rm -rf secret", canAllowForSession: false,
});

it("完成、错误和审批摘要包含单行有界的会话标题", async () => {
  const feed = new NotificationFeed(() => 1000, async () => "  修复通知\n跳转  ");
  await feed.observe("chat:state", state("s1", "running"));
  await feed.observe("permission:requested", permission("s1"));
  await feed.observe("chat:state", state("s1", "idle"));
  await feed.observe("chat:state", state("s2", "running"));
  await feed.observe("chat:state", state("s2", "error"));
  expect(feed.since(undefined, true).map(event => [event.type, event.title])).toEqual([
    ["approval", "修复通知 跳转"], ["done", "修复通知 跳转"], ["error", "修复通知 跳转"],
  ]);
  const long = new NotificationFeed(() => 1000, async () => "名".repeat(300));
  await long.observe("chat:state", state("s1", "running"));
  await long.observe("chat:state", state("s1", "idle"));
  expect(Array.from(long.since(undefined, true)[0]!.title!)).toHaveLength(120);
});

it("标题读取失败仍发项目摘要，并记录诊断", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const feed = new NotificationFeed(() => 1000, async () => { throw new Error("history unavailable"); });
    await feed.observe("chat:state", state("s1", "running"));
    await feed.observe("chat:state", state("s1", "idle"));
    expect(feed.since(undefined, true)[0]).toMatchObject({ type: "done", project: "GTools" });
    expect(feed.since(undefined, true)[0]).not.toHaveProperty("title");
    expect(warning).toHaveBeenCalledOnce();
  } finally { warning.mockRestore(); }
});

it("标题读取超时不阻塞后续事件，事件和补发顺序一致", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const feed = new NotificationFeed(() => 1000, async event => {
      if (event.sessionKey === "slow") return new Promise<string>(() => {});
      return "后续会话";
    });
    feed.observe("chat:state", state("slow", "running"));
    const first = feed.observe("chat:state", state("slow", "idle"));
    feed.observe("chat:state", state("next", "running"));
    const second = feed.observe("chat:state", state("next", "error"));
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    const events = feed.since(undefined, true);
    expect(events.map(event => event.sessionKey)).toEqual(["slow", "next"]);
    expect(events[0]).not.toHaveProperty("title");
    expect(events[1]!.title).toBe("后续会话");
    expect(feed.since(events[0]!.id)).toEqual([events[1]]);
    expect(warning).toHaveBeenCalledOnce();
  } finally {
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it("忙碌后回到空闲记为完成，忙碌后出错记为出错；只有空闲到空闲不产生事件", () => {
  const feed = new NotificationFeed(() => 1000);
  feed.observe("chat:state", state("s1", "idle"));
  feed.observe("chat:state", state("s1", "running"));
  feed.observe("chat:state", state("s1", "idle", { sessionId: "abc" }));
  feed.observe("chat:state", state("s2", "awaitingApproval"));
  feed.observe("chat:state", state("s2", "error", { error: "认证失败：token=secret" }));
  const events = feed.since(undefined, true);
  expect(events.map((event) => [event.type, event.sessionKey])).toEqual([["done", "s1"], ["error", "s2"]]);
  expect(events[0]).toMatchObject({ agent: "claude", project: "GTools", sessionId: "abc", at: 1000 });
});

it("完成事件带项目路径与本轮回复摘要，出错和审批不带回复内容", () => {
  const rows = [
    { rowId: 1, turnId: "t", createdAt: 1, createdAtSeq: 1, kind: "userInput", text: "查查看" },
    { rowId: 2, turnId: "t", createdAt: 1, createdAtSeq: 2, kind: "assistantText", text: "已修复：通知可直达会话。", state: "complete" },
  ] as ConversationRow[];
  const feed = new NotificationFeed(() => 1000, undefined, () => rows);
  feed.observe("chat:state", state("s1", "running"));
  feed.observe("permission:requested", permission("s1"));
  feed.observe("chat:state", state("s1", "idle", { sessionId: "abc" }));
  feed.observe("chat:state", state("s2", "running"));
  feed.observe("chat:state", state("s2", "error"));
  const [approval, done, error] = feed.since(undefined, true);
  expect(done).toMatchObject({ type: "done", sessionId: "abc", projectPath: "/Users/me/Projects/GTools", summary: "已修复：通知可直达会话。" });
  expect(approval).not.toHaveProperty("summary");
  expect(error).not.toHaveProperty("summary");
});

it("等待审批只带工具名，不带命令、标题等对话内容", () => {
  const feed = new NotificationFeed(() => 1000);
  feed.observe("chat:state", state("s1", "running", { projectPath: "/work/HCode" }));
  feed.observe("permission:requested", permission("s1"));
  const [event] = feed.since(undefined, true);
  expect(event).toMatchObject({ type: "approval", tool: "Bash", project: "HCode", sessionKey: "s1" });
  expect(JSON.stringify(event)).not.toContain("secret");
});

it("事件 id 带启动标识：同一次启动内按 Last-Event-ID 补发，换了启动标识则补发全部缓存", () => {
  const feed = new NotificationFeed(() => 1000);
  for (const key of ["a", "b", "c"]) {
    feed.observe("chat:state", state(key, "running"));
    feed.observe("chat:state", state(key, "idle"));
  }
  const [first, second, third] = feed.since(undefined, true);
  expect(feed.since(first!.id).map((event) => event.id)).toEqual([second!.id, third!.id]);
  expect(feed.since(third!.id)).toEqual([]);
  expect(feed.since("oldboot.99")).toHaveLength(3);
  expect(feed.since(undefined)).toEqual([]);
  expect(new Set([first!.id, second!.id, third!.id]).size).toBe(3);
});

it("只保留最近 50 条", () => {
  const feed = new NotificationFeed(() => 1000);
  for (let index = 0; index < 60; index++) {
    feed.observe("chat:state", state(`s${index}`, "running"));
    feed.observe("chat:state", state(`s${index}`, "idle"));
  }
  const events = feed.since(undefined, true);
  expect(events).toHaveLength(50);
  expect(events[0]!.sessionKey).toBe("s10");
});
