// pi 接入：StepCode 基于 pi，RPC 协议与会话格式相同，直接复用 step/ 下的 StepAgent，这里只提供 pi 的差异。
// pi 没有工具审批（默认全部放行），只读模式用 `--tools` 只开放读取类工具；扩展弹出的 confirm / select 等对话框仍走审批卡片。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PermissionMode } from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import type { PiVariant } from "../step/piVariant.js";

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** pi 内置工具 → ZCode 工具名 + 输入。不认识的工具（扩展工具等）原样保留（走通用卡片）。 */
export function projectPiTool(name: string, args: JsonRecord): { toolName: string; input: JsonRecord } {
  switch (name) {
    case "read":
      return {
        toolName: "Read",
        input: {
          file_path: str(args.path) ?? "",
          ...(typeof args.offset === "number" ? { offset: args.offset } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        },
      };
    case "write":
      return { toolName: "Write", input: { file_path: str(args.path) ?? "", content: str(args.content) ?? "" } };
    case "edit": {
      // 一次调用可含多处替换，合并成一个 Edit 卡片，各处之间用 ⋯ 分隔
      const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [];
      const joined = (key: string) => edits.map((edit) => str(edit[key]) ?? "").join("\n⋯\n");
      return {
        toolName: "Edit",
        input: { file_path: str(args.path) ?? "", old_string: joined("oldText"), new_string: joined("newText") },
      };
    }
    case "bash":
      return {
        toolName: "Bash",
        input: {
          command: str(args.command) ?? "",
          // pi 的 timeout 单位是秒
          ...(typeof args.timeout === "number" ? { timeout: args.timeout * 1000 } : {}),
        },
      };
    case "grep":
      return {
        toolName: "Grep",
        input: {
          pattern: str(args.pattern) ?? "",
          ...(args.path ? { path: args.path } : {}),
          ...(args.glob ? { glob: args.glob } : {}),
        },
      };
    case "find":
      return { toolName: "Glob", input: { pattern: str(args.pattern) ?? "", ...(args.path ? { path: args.path } : {}) } };
    case "ls":
      return { toolName: "Glob", input: { pattern: "*", path: str(args.path) ?? "." } };
    default:
      return { toolName: name, input: args };
  }
}

/** settings.json 里的 sessionDir（只认绝对路径和 ~ 开头；相对路径按项目解析，无法用于全局列表）。 */
function settingsSessionDir(agentDir: string): string | undefined {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    const dir = isRecord(settings) ? str(settings.sessionDir) : undefined;
    if (!dir) return undefined;
    if (dir === "~" || dir.startsWith("~/")) return join(homedir(), dir.slice(1));
    return isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** 只读：只开放读取和搜索类的内置工具。 */
const READ_ONLY_TOOLS = "read,grep,find,ls";

export const PI_VARIANT: PiVariant = {
  kind: "pi",
  name: "pi",
  command: "pi",
  // 与 pi 自己的规则一致：PI_CODING_AGENT_SESSION_DIR > settings.json 的 sessionDir > PI_CODING_AGENT_DIR/sessions
  sessionsDir: (env) => {
    const agentDir = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
    return env.PI_CODING_AGENT_SESSION_DIR || settingsSessionDir(agentDir) || join(agentDir, "sessions");
  },
  launchArgs: (mode: PermissionMode) => (mode === "read-only" ? ["--tools", READ_ONLY_TOOLS] : []),
  projectTool: projectPiTool,
};
