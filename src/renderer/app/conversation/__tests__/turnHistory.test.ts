import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitTurnDiff, GitTurnRecord } from "@hcode/shared/types";
import { discardTurnHistory, loadTurnHistory, MAX_TURN_RECORDS, recordFromDiff, saveTurnHistory, turnDiffPatch } from "../turnHistory";

const session = { agent: "claude" as const, projectPath: "/project", sessionId: "session-1" };
const storage = new Map<string, string>();
const diff = (id: string, recordedAt: number): GitTurnDiff => ({
  id, recordedAt, root: "/project", head: "a".repeat(40), prompt: "修改登录页",
  files: [{ path: "login.ts", status: "modified", additions: 2, deletions: 1, patch: "private file contents", beforeHash: "before", afterHash: "after", revertUnavailable: "runtime only" }],
});
const record = (id: string, recordedAt: number) => recordFromDiff(diff(id, recordedAt))!;

beforeEach(() => {
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("重新读取恢复文件清单和统计，存储中没有 patch、正文或可写快照", () => {
  const saved = record("turn-1", 1);
  saveTurnHistory(session, [saved]);
  expect(loadTurnHistory({ ...session })).toEqual([saved]);
  const raw = [...storage.values()][0]!;
  expect(raw).not.toContain("patch");
  expect(raw).not.toContain("private file contents");
  expect(raw).not.toContain("revertUnavailable");
  expect(recordFromDiff(diff("turn-1", 1))?.files[0]).toMatchObject({ path: "login.ts", additions: 2, deletions: 1 });
});

it("按 CLI、项目和会话隔离记录，没有会话 id 时不写入临时 key", () => {
  saveTurnHistory(session, [record("turn-1", 1)]);
  expect(loadTurnHistory({ ...session, agent: "codex" })).toEqual([]);
  expect(loadTurnHistory({ ...session, projectPath: "/other" })).toEqual([]);
  expect(loadTurnHistory({ ...session, sessionId: "session-2" })).toEqual([]);
  saveTurnHistory({ ...session, sessionId: undefined }, [record("draft-turn", 2)]);
  expect(storage.size).toBe(1);
});

it("只保留最近 20 轮，提交或撤销后的刷新保留该轮结束时的历史统计", () => {
  const records = Array.from({ length: MAX_TURN_RECORDS + 5 }, (_, index) => record(`turn-${index}`, index + 1));
  saveTurnHistory(session, records.reverse());
  const loaded = loadTurnHistory(session);
  expect(loaded).toHaveLength(MAX_TURN_RECORDS);
  expect(loaded[0]?.id).toBe("turn-5");
  const updated = { ...diff("turn-24", 25), files: [] };
  const patch = turnDiffPatch({ currentTurnId: "turn-24", turnHistory: loaded }, { diff: updated });
  expect(patch).not.toHaveProperty("turnHistory");
  expect(loaded.at(-1)?.files).toHaveLength(1);
  expect(patch.turnDiff).toBe(updated);
});

it("上一轮结果晚到仍入历史，但不会覆盖运行中的当前轮", () => {
  const collecting = turnDiffPatch({ turnHistory: [], currentTurnId: undefined }, { diff: null, turnId: "new" });
  expect(collecting).toMatchObject({ currentTurnId: "new", turnDiff: null });
  const late = turnDiffPatch({ turnHistory: [], currentTurnId: "new" }, { diff: diff("old", 1) });
  expect(late).not.toHaveProperty("turnDiff");
  expect(late.turnHistory?.[0]?.id).toBe("old");
  const finished = turnDiffPatch({ turnHistory: late.turnHistory!, currentTurnId: "new" }, { diff: diff("new", 2) });
  expect(finished.turnHistory?.map((item) => item.id)).toEqual(["old", "new"]);
  expect(finished.turnDiff?.id).toBe("new");
  saveTurnHistory(session, finished.turnHistory!);
  expect(loadTurnHistory(session)).toHaveLength(2);
});

it("损坏存储、无效统计和读取错误不妨碍打开会话", () => {
  saveTurnHistory(session, [record("turn-1", 1)]);
  const key = [...storage.keys()][0]!;
  storage.set(key, "invalid JSON");
  expect(loadTurnHistory(session)).toEqual([]);
  storage.set(key, JSON.stringify([null, { ...record("turn-1", 1), files: [{ path: "x", additions: -1 }] }]));
  expect(loadTurnHistory(session)).toEqual([]);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("quota"); } });
  expect(loadTurnHistory(session)).toEqual([]);
  expect(() => saveTurnHistory(session, [record("turn-1", 1)])).not.toThrow();
  expect(recordFromDiff({ files: [], error: "Git failed" })).toBeNull();
});

it("关闭或删除清掉目标会话，其他会话的记录仍保留", () => {
  const other = { ...session, sessionId: "other-session" };
  saveTurnHistory(session, [record("turn-1", 1)]);
  saveTurnHistory(other, [record("turn-2", 2)]);
  discardTurnHistory(session);
  expect(loadTurnHistory(session)).toEqual([]);
  expect(loadTurnHistory(other)).toHaveLength(1);
});

it("保存时只写摘要，即使调用方误带入正文也会剔除", () => {
  const value = { ...record("turn-1", 1), extra: "private", files: diff("turn-1", 1).files };
  saveTurnHistory(session, [value as GitTurnRecord]);
  expect([...storage.values()][0]).not.toContain("private");
  expect(loadTurnHistory(session)[0]?.files[0]).not.toHaveProperty("patch");
});
