// 各 CLI 的静态描述：名称、权限模式、内置模型选项。主进程与渲染进程共用。
import type { AgentKind, ModelOption, PermissionMode, QuotaSource } from "./types.js";

export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  description: string;
  /** 渲染进程据此选图标 */
  icon: "shield" | "edit" | "plan" | "readonly" | "danger";
  dangerous?: boolean;
}

export interface AgentDescriptor {
  kind: AgentKind;
  name: string;
  command: string;
  permissionModes: PermissionModeOption[];
  /** 内置模型选项；codex / step / agy / pi 还会在运行时拉取完整列表。 */
  models: ModelOption[];
}

export const AGENTS: Record<AgentKind, AgentDescriptor> = {
  claude: {
    kind: "claude",
    name: "Claude Code",
    command: "claude",
    permissionModes: [
      { mode: "default", label: "逐条审批", description: "修改文件、执行命令前都会询问你", icon: "shield" },
      { mode: "acceptEdits", label: "自动接受编辑", description: "文件修改自动通过，命令仍需审批", icon: "edit" },
      { mode: "plan", label: "计划模式", description: "只读分析并给出计划，批准后才执行", icon: "plan" },
      {
        mode: "bypassPermissions",
        label: "完全放行",
        description: "不再询问任何操作（谨慎使用）",
        icon: "danger",
        dangerous: true,
      },
    ],
    models: [
      { value: "", label: "默认模型" },
      { value: "opus", label: "Opus" },
      { value: "sonnet", label: "Sonnet" },
      { value: "haiku", label: "Haiku" },
    ],
  },
  codex: {
    kind: "codex",
    name: "Codex",
    command: "codex",
    permissionModes: [
      {
        mode: "on-request",
        label: "自动（工作区）",
        description: "可读写当前项目并执行命令，越界时才询问",
        icon: "edit",
      },
      { mode: "untrusted", label: "逐条审批", description: "除安全的只读命令外，执行前都会询问你", icon: "shield" },
      { mode: "read-only", label: "只读", description: "只能读取文件，修改和执行都需要审批", icon: "readonly" },
      {
        mode: "full-access",
        label: "完全放行",
        description: "不受沙箱限制，也不再询问（谨慎使用）",
        icon: "danger",
        dangerous: true,
      },
    ],
    models: [{ value: "", label: "默认模型" }],
  },
  step: {
    kind: "step",
    name: "StepCode",
    command: "step",
    // 对应 step 的权限预设（--approval-mode confirm / strict / auto）
    permissionModes: [
      { mode: "ask", label: "逐条审批", description: "只读工具直接运行，改文件、执行命令前询问你", icon: "shield" },
      { mode: "read-only", label: "只读", description: "只允许读取和搜索类工具", icon: "readonly" },
      {
        mode: "bypass",
        label: "自动执行",
        description: "普通操作不再询问，危险命令仍会询问（谨慎使用）",
        icon: "danger",
        dangerous: true,
      },
    ],
    models: [{ value: "", label: "默认模型" }],
  },
  agy: {
    kind: "agy",
    name: "Antigravity",
    command: "agy",
    // agy 无头模式（-p）不能交互审批：需要确认的操作会被自动拒绝，所以只提供启动参数能表达的几档
    permissionModes: [
      {
        mode: "default",
        label: "按 agy 设置",
        description: "遵循 agy 的权限规则，需要确认的操作会被自动拒绝",
        icon: "shield",
      },
      {
        mode: "accept-edits",
        label: "自动接受编辑",
        description: "文件修改自动通过，其他操作仍按 agy 的权限规则",
        icon: "edit",
      },
      {
        mode: "bypass",
        label: "完全放行",
        description: "不再询问任何操作（谨慎使用）",
        icon: "danger",
        dangerous: true,
      },
    ],
    models: [{ value: "", label: "默认模型" }],
  },
  pi: {
    kind: "pi",
    name: "pi",
    command: "pi",
    // pi 没有工具审批：默认直接执行所有工具；只读模式用 --tools 只开放读取类工具
    permissionModes: [
      {
        mode: "default",
        label: "直接执行",
        description: "pi 不做工具审批，改文件、执行命令都不会询问（谨慎使用）",
        icon: "danger",
        dangerous: true,
      },
      { mode: "read-only", label: "只读", description: "只开放读取、搜索和列目录工具", icon: "readonly" },
    ],
    models: [{ value: "", label: "默认模型" }],
  },
};

export const AGENT_KINDS: AgentKind[] = ["claude", "codex", "step", "agy", "pi"];

/** 额度面板里的排列顺序。 */
export const QUOTA_SOURCES: QuotaSource[] = [...AGENT_KINDS, "glm"];

export function quotaSourceName(source: QuotaSource): string {
  return source === "glm" ? "GLM Coding Plan" : AGENTS[source].name;
}
