// 找到本机的 claude 可执行文件并读取版本。
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AgentStatus } from "../../../shared/types.js";

const execFileAsync = promisify(execFile);

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findClaudeExecutable(env: NodeJS.ProcessEnv, override?: string): string | null {
  if (override?.trim()) return isExecutable(override.trim()) ? override.trim() : null;
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "claude")),
    join(homedir(), ".local/bin/claude"),
    join(homedir(), ".claude/local/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  return candidates.find(isExecutable) ?? null;
}

export async function probeClaude(env: NodeJS.ProcessEnv, override?: string): Promise<AgentStatus> {
  const path = findClaudeExecutable(env, override);
  if (!path) {
    return { kind: "claude", found: false, error: "未找到 claude 命令" };
  }
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { env, timeout: 10_000 });
    const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
    return { kind: "claude", found: true, path, version };
  } catch (error) {
    return { kind: "claude", found: true, path, error: String(error) };
  }
}
