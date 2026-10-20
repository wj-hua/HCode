// 真实 SDK + 临时 JSONL 验证历史索引，覆盖大首条消息导致的 cwd 缺失。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];
const OVERSIZED_PROMPT = "会话正文".repeat(30_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hcode-claude-history-")));
  temporaryDirectories.push(root);
  const project = join(root, "GTools");
  const config = join(root, "claude");
  const directory = join(config, "projects", project.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const transcript = join(directory, `${id}.jsonl`);
  const records = [
    { type: "user", uuid: randomUUID(), parentUuid: null, isSidechain: false, sessionId: id,
      message: { role: "user", content: [{ type: "text", text: OVERSIZED_PROMPT }] },
      cwd: project, timestamp: "2026-10-19T12:00:00Z" },
    { type: "assistant", uuid: randomUUID(), sessionId: id, message: { role: "assistant", content: [{ type: "text", text: "原始回复" }] }, timestamp: "2026-10-19T12:01:00Z" },
    { type: "custom-title", sessionId: id, customTitle: "GTools 多端工具整合" },
  ];
  await writeFile(transcript, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  vi.stubEnv("CLAUDE_CONFIG_DIR", config);
  vi.resetModules();
  return { project, id, transcript };
}

describe("Claude 历史索引", () => {
  it("重启索引后，大首条消息的会话仍归属原项目且正文可读，原文件不变", async () => {
    const { project, id, transcript } = await fixture();
    const original = await readFile(transcript);
    const { ClaudeHistory } = await import("../claude/claudeHistory.js");
    const history = new ClaudeHistory(() => {}, () => [project]);
    expect(await history.all()).toContainEqual(expect.objectContaining({ id, projectPath: project, title: "GTools 多端工具整合" }));
    const loaded = await history.load(id, project);
    expect(loaded.rows).toContainEqual(expect.objectContaining({ kind: "assistantText", text: "原始回复" }));
    expect(await readFile(transcript)).toEqual(original);
  });

  it("新增项目后刷新已缓存的空列表，重复项目和重读不会重复会话", async () => {
    const { project, id } = await fixture();
    const { ClaudeHistory } = await import("../claude/claudeHistory.js");
    const projects: string[] = [];
    const history = new ClaudeHistory(() => {}, () => projects);
    expect(await history.all()).toEqual([]);
    projects.push(project, project);
    expect((await history.all()).map(session => session.id)).toEqual([id]);
    history.invalidate();
    expect((await history.list(project)).map(session => session.id)).toEqual([id]);
  });
});
