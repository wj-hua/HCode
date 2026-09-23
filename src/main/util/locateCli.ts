// 找到 CLI 可执行文件并读取版本（claude / codex 等共用）。
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { AgentKind, AgentStatus } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  override?: string,
  extraCandidates: string[] = [],
): string | null {
  if (override?.trim()) return isExecutable(override.trim()) ? override.trim() : null;
  const candidates = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command)),
    join(homedir(), ".local/bin", command),
    ...extraCandidates,
    join("/opt/homebrew/bin", command),
    join("/usr/local/bin", command),
  ];
  return candidates.find(isExecutable) ?? null;
}

export async function probeCli(
  kind: AgentKind,
  command: string,
  env: NodeJS.ProcessEnv,
  override?: string,
  extraCandidates: string[] = [],
): Promise<AgentStatus> {
  const path = findExecutable(command, env, override, extraCandidates);
  if (!path) return { kind, found: false, error: `未找到 ${command} 命令` };
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { env, timeout: 15_000 });
    const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
    return { kind, found: true, path, version };
  } catch (error) {
    return { kind, found: true, path, error: String(error) };
  }
}
