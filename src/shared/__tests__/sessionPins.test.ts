import { describe, expect, it } from "vitest";
import { sessionPinKey, sortSessionsWithPins } from "../sessionPins.js";
import type { SessionSummary } from "../types.js";

function session(id: string, updatedAt: number, agent: SessionSummary["agent"] = "claude"): SessionSummary {
  return { id, agent, projectPath: "/project", title: id, createdAt: 1, updatedAt };
}

describe("项目内会话置顶排序", () => {
  it("较旧的置顶会话先显示，同组按时间排序，且不修改原列表", () => {
    const sessions = [session("new", 40), session("pinned-old", 10), session("old", 20), session("pinned-new", 30)];
    const original = [...sessions];
    const pins = [sessionPinKey(sessions[1]!), sessionPinKey(sessions[3]!)];
    expect(sortSessionsWithPins(sessions, pins).map((item) => item.id))
      .toEqual(["pinned-new", "pinned-old", "new", "old"]);
    expect(sessions).toEqual(original);
  });

  it("取消置顶后恢复按时间排序，失效的置顶记录不影响列表", () => {
    const sessions = [session("old", 10), session("new", 20)];
    expect(sortSessionsWithPins(sessions, ["claude:missing"]).map((item) => item.id)).toEqual(["new", "old"]);
    expect(sortSessionsWithPins(sessions, []).map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("不同 CLI 的相同会话 ID 互不影响", () => {
    const sessions = [session("same", 20, "codex"), session("same", 10, "claude")];
    expect(sortSessionsWithPins(sessions, ["claude:same"]).map((item) => item.agent)).toEqual(["claude", "codex"]);
  });
});
