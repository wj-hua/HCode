import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConversationRow, SessionSearchResult, SessionSummary } from "../shared/types.js";
import type { AgentRegistry } from "./agents/registry.js";

const MAX_RESULTS = 240;
const MAX_PER_SESSION = 3;
const CODEX_SESSIONS_DIR = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
const CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
const AGY_BRAIN_DIR = join(homedir(), ".gemini/antigravity-cli/brain");

/** 用查询中最长的连续片段预筛文件；完整短语仍由历史投影确认。 */
function screenNeedle(query: string): string | null {
  const parts = query.match(/[^\s"\\]+/gu) ?? [];
  const longest = parts.sort((a, b) => b.length - a.length)[0];
  return longest && longest.length >= 2 ? longest.toLocaleLowerCase() : null;
}

async function collectSessionPaths(root: string, depth: number): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.filter((entry) => entry.isDirectory() && depth > 0)
    .map((entry) => collectSessionPaths(join(root, entry.name), depth - 1)));
  return [
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(root, entry.name)),
    ...nested.flat(),
  ];
}

async function filePaths(sessions: readonly SessionSummary[]): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const [claude, codex] = await Promise.all([
    sessions.some((session) => session.agent === "claude") ? collectSessionPaths(CLAUDE_PROJECTS_DIR, 1) : Promise.resolve([]),
    sessions.some((session) => session.agent === "codex") ? collectSessionPaths(CODEX_SESSIONS_DIR, 3) : Promise.resolve([]),
  ]);
  for (const path of claude) paths.set(`claude:${basename(path, ".jsonl")}`, path);
  for (const path of codex) {
    const id = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i.exec(path)?.[1];
    if (id) paths.set(`codex:${id}`, path);
  }
  return paths;
}

function fileNeedles(needle: string): string[] {
  const escaped = [...needle].map((char) =>
    /^[\x00-\x7f]$/u.test(char) ? char : char.split("").map((unit) =>
      `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  ).join("");
  return escaped === needle ? [needle] : [needle, escaped];
}

async function fileContains(path: string, needle: string, cancelled: () => boolean): Promise<boolean> {
  const needles = fileNeedles(needle);
  const overlap = Math.max(...needles.map((part) => part.length)) - 1;
  let tail = "";
  try {
    const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 128 * 1024 });
    for await (const chunk of stream) {
      if (cancelled()) return false;
      const text = tail + String(chunk).toLocaleLowerCase();
      if (needles.some((part) => text.includes(part))) return true;
      tail = text.slice(-overlap);
    }
    return false;
  } catch {
    // 文件暂时不可读时交给 CLI 的历史读取器处理。
    return true;
  }
}

function pathForSession(session: SessionSummary, paths: Map<string, string>, agents: AgentRegistry): string | undefined {
  if (session.agent === "agy") return join(AGY_BRAIN_DIR, session.id, ".system_generated/logs/transcript_full.jsonl");
  return agents.get(session.agent).sessionFilePath?.(session.id) ?? paths.get(`${session.agent}:${session.id}`);
}

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 65);
  const end = Math.min(text.length, index + length + 95);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

function rowText(row: ConversationRow): { text: string; kind: SessionSearchResult["kind"] }[] {
  switch (row.kind) {
    case "userInput": return [
      { text: row.text, kind: "user" },
      ...(row.attachments ?? []).map((attachment) => ({ text: attachment.fileName, kind: "user" as const })),
    ];
    case "assistantText": return [{ text: row.text, kind: "assistant" }];
    case "reasoning": return [{ text: row.text, kind: "reasoning" }];
    case "toolCall": return [
      { text: row.toolName, kind: "tool" },
      { text: row.inputText, kind: "tool" },
      { text: row.output?.text ?? "", kind: "tool" },
    ];
    default: return [];
  }
}

export function findSessionMatches(session: SessionSummary, rows: readonly ConversationRow[], query: string): SessionSearchResult[] {
  const needle = query.toLocaleLowerCase();
  const matches: SessionSearchResult[] = [];
  const titleIndex = session.title.toLocaleLowerCase().indexOf(needle);
  if (titleIndex >= 0) matches.push({ session, rowId: null, snippet: session.title, kind: "title" });
  for (const row of rows) {
    for (const { text, kind } of rowText(row)) {
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      matches.push({ session, rowId: row.rowId, snippet: snippet(text, index, query.length), kind });
      if (matches.length >= MAX_PER_SESSION) return matches;
      break;
    }
  }
  return matches;
}

/** 复用各 CLI 的历史读取与投影，确保结果能定位到界面实际显示的行。 */
export async function searchSessions(agents: AgentRegistry, query: string, cancelled: () => boolean = () => false): Promise<SessionSearchResult[]> {
  const normalized = query.trim().slice(0, 200);
  if (!normalized) return [];
  const sessions = await agents.allSessions();
  if (cancelled()) return [];
  const needle = screenNeedle(normalized);
  const paths = needle ? await filePaths(sessions) : new Map<string, string>();
  if (cancelled()) return [];
  const bySession: SessionSearchResult[][] = new Array(sessions.length);
  let next = 0;
  let matchCount = 0;
  await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, async () => {
    while (!cancelled() && next < sessions.length && matchCount < MAX_RESULTS) {
      const index = next++;
      const session = sessions[index]!;
      try {
        const path = pathForSession(session, paths, agents);
        if (path && needle && !session.title.toLocaleLowerCase().includes(normalized.toLocaleLowerCase()) &&
          !(await fileContains(path, needle, cancelled))) continue;
        if (cancelled()) break;
        const { rows } = await agents.get(session.agent).loadSession(session.id, session.projectPath);
        bySession[index] = findSessionMatches(session, rows, normalized);
      } catch {
        // 正在删除或写入中的历史会话不妨碍搜索其他会话，标题仍可搜索。
        bySession[index] = findSessionMatches(session, [], normalized);
      }
      matchCount += bySession[index]?.length ?? 0;
    }
  }));
  return bySession.flat().slice(0, MAX_RESULTS);
}
