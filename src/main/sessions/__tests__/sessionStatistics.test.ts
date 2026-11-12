import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStatisticsStore } from "../sessionStatistics.js";
import type { ChatUsage, SessionRef } from "../../../shared/types.js";

let directory: string;
const ref: SessionRef = { agent: "claude", projectPath: "/project", id: "native" };
const sample = (id: string, outputTokens = 100, duration = 1000): ChatUsage => ({
  turnStatistics: { id, toolCalls: 2, toolMs: 3000, incompleteTools: 0, responseMs: duration },
  inputTokens: 1000, outputTokens, ttftMs: 100,
  outputSpeedBasis: "activeTurn", outputSpeedDurationMs: duration, outputTokensPerSecond: outputTokens * 1000 / duration,
});
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "hcode-statistics-")); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("会话累计统计持久化", () => {
  it("首次无数据，不把正在运行的用量写入累计", () => {
    const store = new SessionStatisticsStore(directory);
    expect(store.usage(ref)).toBeUndefined();
    expect(store.record(ref, { inputTokens: 1, outputTokens: 2 })).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("重启恢复，重复事件和晚到的同轮用量修正不增加轮次", () => {
    const store = new SessionStatisticsStore(directory);
    store.record(ref, sample("one"));
    const restarted = new SessionStatisticsStore(directory);
    expect(restarted.record(ref, sample("one"))?.sessionStatistics?.turns).toBe(1);
    expect(restarted.record(ref, sample("one", 200))?.sessionStatistics).toMatchObject({ turns: 1, outputTokens: 200 });
    const usage = restarted.record(ref, sample("two", 300, 9000));
    expect(usage?.sessionStatistics).toMatchObject({ turns: 2, responseMs: 10000,
      toolCalls: 4, toolMs: 6000, ttftMs: 200, ttftTurns: 2, activeTurnTokens: 500, activeTurnMs: 10000 });
    expect(new SessionStatisticsStore(directory).usage(ref)).toEqual(usage);
    expect(usage?.turnStatistics).toBeUndefined();
    // 速度为 500 / 10 = 50，不是 (200 + 33.3) / 2。
    expect(usage!.sessionStatistics!.activeTurnTokens * 1000 / usage!.sessionStatistics!.activeTurnMs).toBe(50);
  });

  it("按 CLI、项目、原生 ID 隔离；删除后重开无统计", () => {
    const store = new SessionStatisticsStore(directory);
    store.record(ref, sample("one"));
    for (const other of [{ ...ref, agent: "codex" as const }, { ...ref, projectPath: "/other" }, { ...ref, id: "other" }]) {
      expect(store.usage(other)).toBeUndefined();
    }
    store.delete(ref);
    expect(store.usage(ref)).toBeUndefined();
    expect(new SessionStatisticsStore(directory).usage(ref)).toBeUndefined();
  });

  it("失败或缺计时样本只贡献已有数据，两种吞吐口径分开汇总", () => {
    const store = new SessionStatisticsStore(directory);
    store.record(ref, sample("active"));
    store.record(ref, { ...sample("response", 200, 2000), outputSpeedBasis: "response" });
    const usage = store.record(ref, { turnStatistics: { id: "interrupted", toolCalls: 0, toolMs: 0, incompleteTools: 1 } });
    expect(usage?.sessionStatistics).toMatchObject({ turns: 3, usageTurns: 2, responseTurns: 2,
      ttftTurns: 2, incompleteTools: 1, activeTurnTokens: 100, activeTurnMs: 1000,
      responseTokens: 200, responseSpeedMs: 2000 });
  });

  it("只持久化统计字段，不保存上下文或会话内容，拒绝畸形磁盘数据", () => {
    const store = new SessionStatisticsStore(directory);
    store.record(ref, { ...sample("one"), contextUsedTokens: 999 });
    const path = join(directory, readdirSync(directory)[0]!);
    expect(readFileSync(path, "utf8")).not.toContain("contextUsedTokens");
    writeFileSync(path, JSON.stringify({ version: 1, samples: [{ turnStatistics: { id: "bad", toolMs: -1 } }] }));
    expect(() => new SessionStatisticsStore(directory).usage(ref)).toThrow();
  });
});
