// Claude Code 会话历史：列表与内容都通过官方 SDK 读取 ~/.claude/projects。
import { readdir, readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getSessionMessages,
  listSessions,
  renameSession,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionLoadResult, SessionSummary } from "../../../shared/types.js";
import { projectHistory, type ClaudeRecord } from "./rowProjector.js";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const CLAUDE_LIVE_SESSIONS_DIR = join(CLAUDE_DIR, "sessions");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** ~/.claude/sessions/<pid>.json 记录了正在运行的 claude 进程；只统计终端里的交互式进程。 */
async function readTerminalSessionIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  let files: string[] = [];
  try {
    files = (await readdir(CLAUDE_LIVE_SESSIONS_DIR)).filter((name) => name.endsWith(".json"));
  } catch {
    return ids;
  }
  await Promise.all(
    files.map(async (name) => {
      try {
        const info = JSON.parse(await readFile(join(CLAUDE_LIVE_SESSIONS_DIR, name), "utf8")) as {
          pid?: number;
          sessionId?: string;
          entrypoint?: string;
        };
        if (info.sessionId && info.pid && info.entrypoint === "cli" && isAlive(info.pid)) {
          ids.add(info.sessionId);
        }
      } catch {
        // 进程退出时文件可能正在被删除
      }
    }),
  );
  return ids;
}

function toSummary(info: SDKSessionInfo): SessionSummary | null {
  if (!info.cwd) return null;
  const title = (info.customTitle || info.summary || info.firstPrompt || "未命名会话").trim();
  return {
    id: info.sessionId,
    agent: "claude",
    projectPath: info.cwd,
    title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
    createdAt: info.createdAt ?? info.lastModified,
    updatedAt: info.lastModified,
    ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}),
  };
}

export class ClaudeHistory {
  private cache: SessionSummary[] | null = null;
  private loading: Promise<SessionSummary[]> | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly onChanged: (projectPaths: string[]) => void) {}

  async all(): Promise<SessionSummary[]> {
    if (this.cache) return this.cache;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = Promise.all([listSessions(), readTerminalSessionIds()])
        .then(([list, terminalIds]) =>
          list
            .map(toSummary)
            .filter((item): item is SessionSummary => item !== null)
            .map((item) => (terminalIds.has(item.id) ? { ...item, activeInTerminal: true } : item)),
        )
        .then((list) => {
          const sorted = list.sort((a, b) => b.updatedAt - a.updatedAt);
          if (generation === this.generation) this.cache = sorted;
          return sorted;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  async list(projectPath: string): Promise<SessionSummary[]> {
    return (await this.all()).filter((item) => item.projectPath === projectPath);
  }

  async find(sessionId: string): Promise<SessionSummary | null> {
    return (await this.all()).find((item) => item.id === sessionId) ?? null;
  }

  async loadRecords(sessionId: string, projectPath: string): Promise<ClaudeRecord[]> {
    const messages = await getSessionMessages(sessionId, {
      dir: projectPath,
      includeSystemMessages: true,
    });
    return messages as unknown as ClaudeRecord[];
  }

  async load(sessionId: string, projectPath: string): Promise<SessionLoadResult> {
    const records = await this.loadRecords(sessionId, projectPath);
    return {
      summary: await this.find(sessionId),
      rows: projectHistory(records).snapshot(),
    };
  }

  async rename(sessionId: string, projectPath: string, title: string): Promise<void> {
    await renameSession(sessionId, title, { dir: projectPath });
    this.invalidate([projectPath]);
  }

  invalidate(projectPaths: string[] = []) {
    this.generation++;
    this.cache = null;
    this.loading = null;
    this.onChanged(projectPaths);
  }

  /** 监听 ~/.claude/projects，终端里新建或更新的会话会自动刷新到列表。 */
  startWatching() {
    if (this.watcher) return;
    try {
      this.watcher = watch(CLAUDE_PROJECTS_DIR, { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith(".jsonl")) return;
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.invalidate(), 500);
      });
    } catch {
      // 目录不存在（从未用过 claude）时忽略
    }
  }

  stopWatching() {
    this.watcher?.close();
    this.watcher = null;
  }
}
