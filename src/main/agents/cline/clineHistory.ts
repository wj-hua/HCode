import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "../../../shared/types.js";
import { isRecord, parseTime, type JsonRecord } from "../rowProjectorBase.js";
import { clineUserText } from "./clineProjector.js";

export function clineDataDir(env: Record<string, string>): string {
  return env.CLINE_DATA_DIR?.trim() || join(env.CLINE_DIR?.trim() || join(env.HOME || homedir(), ".cline"), "data");
}

export function clineMessagesPath(id: string, env: Record<string, string>): string {
  if (!id || id === "." || id === ".." || /[/\\]/.test(id)) throw new Error("Cline 会话 ID 无效");
  const sessions = env.CLINE_SESSION_DATA_DIR?.trim() || join(clineDataDir(env), "sessions");
  return join(sessions, id, `${id}.messages.json`);
}

export function clineSummary(value: unknown): SessionSummary | null {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.cwd !== "string" || !value.cwd || value.isSubagent === true || value.parentSessionId) return null;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const title = typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : typeof value.prompt === "string" ? clineUserText(value.prompt) : "";
  return {
    agent: "cline", id: value.sessionId, projectPath: value.cwd,
    title: title.trim().split("\n")[0]?.slice(0, 80) || "未命名会话",
    createdAt: parseTime(value.startedAt, 0), updatedAt: parseTime(value.updatedAt, parseTime(value.startedAt, 0)),
  };
}

export async function readClineMessages(row: JsonRecord): Promise<unknown[]> {
  if (typeof row.messagesPath !== "string" || !row.messagesPath) throw new Error("Cline 会话没有本地消息文件");
  const value: unknown = JSON.parse(await readFile(row.messagesPath, "utf8"));
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error("Cline 会话消息格式无法识别");
  return value.messages;
}
