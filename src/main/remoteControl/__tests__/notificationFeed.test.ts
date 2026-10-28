import { expect, it } from "vitest";
import type { ChatStateEvent, PermissionRequestEvent } from "../../../shared/types.js";
import { NotificationFeed } from "../notificationFeed.js";

const state = (sessionKey: string, value: ChatStateEvent["state"], extra: Partial<ChatStateEvent> = {}): ChatStateEvent => ({
  sessionKey, agent: "claude", projectPath: "/Users/me/Projects/GTools", state: value, permissionMode: "default", ...extra,
});

const permission = (sessionKey: string): PermissionRequestEvent => ({
  sessionKey, interactionId: "i1", toolUseId: "t1", toolName: "Bash", input: { command: "rm -rf secret" },
  title: "运行 rm -rf secret", canAllowForSession: false,
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
