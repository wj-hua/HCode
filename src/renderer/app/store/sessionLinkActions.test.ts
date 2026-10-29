// 通知深链：参数校验与会话定位；主进程会话列表位于外部边界。
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionSummary } from "@hcode/shared/types";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke } }));
import { openSessionLink, parseSessionLink } from "./sessionLinkActions";

const summary = (id: string, agent: SessionSummary["agent"]) => ({ id, agent, projectPath: "/work/HCode", title: id, createdAt: 1, updatedAt: 1 });
const state = { openSession: vi.fn(async () => {}), toggleProject: vi.fn() };

beforeEach(() => vi.clearAllMocks());

it("解析通知链接，缺字段或未知 CLI 时忽略", () => {
  const project = encodeURIComponent("/Users/me/项目 A");
  expect(parseSessionLink(`?agent=codex&session=abc&project=${project}`)).toEqual({ agent: "codex", sessionId: "abc", projectPath: "/Users/me/项目 A" });
  expect(parseSessionLink("?agent=codex&session=abc")).toBeNull();
  expect(parseSessionLink("?agent=toString&session=abc&project=/p")).toBeNull();
  expect(parseSessionLink("")).toBeNull();
});

it("按 CLI 与会话 id 打开项目内的会话并展开该项目", async () => {
  invoke.mockResolvedValue([summary("abc", "claude"), summary("abc", "codex")]);
  await openSessionLink(() => state, { agent: "codex", sessionId: "abc", projectPath: "/work/HCode" });
  expect(invoke).toHaveBeenCalledWith("sessions:list", "/work/HCode");
  expect(state.toggleProject).toHaveBeenCalledWith("/work/HCode", true);
  expect(state.openSession).toHaveBeenCalledWith(summary("abc", "codex"));
});

it("会话已不存在时抛出明确错误，不打开任何会话", async () => {
  invoke.mockResolvedValue([summary("other", "codex")]);
  await expect(openSessionLink(() => state, { agent: "codex", sessionId: "abc", projectPath: "/work/HCode" })).rejects.toThrow("不存在");
  expect(state.openSession).not.toHaveBeenCalled();
});
