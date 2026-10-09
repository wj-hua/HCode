import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationWorkspace } from "../conversationWorkspace.js";
import { AppStore } from "../appStore.js";
import { buildProjects } from "../projects.js";
import type { SessionSummary } from "../../shared/types.js";

const temporaryDirectories: string[] = [];
async function createDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "hcode-conversation-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("非项目对话工作目录", () => {
  it("重复打开和重启使用相同目录，保留对话产生的文件", async () => {
    const dataDirectory = await createDataDirectory();
    const workspace = new ConversationWorkspace(dataDirectory);
    expect(await workspace.ensure()).toBe(workspace.path);
    await writeFile(join(workspace.path, "notes.txt"), "saved");
    expect(await new ConversationWorkspace(dataDirectory).ensure()).toBe(workspace.path);
    expect((await stat(join(workspace.path, "notes.txt"))).isFile()).toBe(true);
  });

  it("目录路径被文件占用时返回错误，不用其他项目目录兜底", async () => {
    const dataDirectory = await createDataDirectory();
    const workspace = new ConversationWorkspace(dataDirectory);
    await workspace.ensure();
    await rm(workspace.path, { recursive: true });
    await writeFile(workspace.path, "occupied");
    await expect(workspace.ensure()).rejects.toThrow();
  });

  it("各 CLI 的非项目会话归入对话，重启可恢复且不写入手动项目", async () => {
    const dataDirectory = await createDataDirectory();
    const workspace = new ConversationWorkspace(dataDirectory);
    await workspace.ensure();
    const store = new AppStore(dataDirectory);
    store.updateProjects((preferences) => ({ ...preferences, manual: ["/user/project"], ordered: true }));
    const sessions: SessionSummary[] = ["claude", "codex", "step", "agy", "pi"].map((agent, index) => ({
      id: `session-${agent}`, agent: agent as SessionSummary["agent"], projectPath: workspace.path,
      title: "对话", createdAt: 1, updatedAt: index + 2,
    }));
    const projects = buildProjects(sessions, new AppStore(dataDirectory), workspace.path);
    expect(projects.filter((project) => project.purpose !== "conversation").map((project) => project.path)).toEqual(["/user/project"]);
    expect(projects.find((project) => project.purpose === "conversation")).toMatchObject({
      path: workspace.path, name: "对话", sessionCount: 5, lastActiveAt: 6, exists: true,
    });
    expect(new AppStore(dataDirectory).projects.manual).toEqual(["/user/project"]);
  });
});
