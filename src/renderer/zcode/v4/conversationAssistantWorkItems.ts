// 移植自 ZCode packages/ui/src/v4/conversationAssistantWorkItems.ts：
// 把相邻的思考 / 查阅 / 执行 / 修改行合成一个摘要组（“已查阅 2 项，已执行 1 命令”）。
// HCode 不渲染 ZCode 的会话工具与 subagent 配对，相关分支已去掉。
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import * as workflowToolNames from "@/lib/workflowToolNames.js";
import { isZCodeCuaToolName } from "@/lib/cuaPermissionAction.js";
import { joinFilePath } from "@/lib/path.js";
import { readRawToolCallFileSummaries } from "@/ToolCallBlocks/fileSummaries.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { AssistantWorkRow } from "@/v4/conversationTurnFlowItems.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

export type AssistantSummaryCategory = "explore" | "run" | "change";

export function getAssistantSummaryToolCategory(
  row: AssistantWorkRow,
): AssistantSummaryCategory | null {
  if (row.kind !== "toolCall" || row.status === "pendingApproval") return null;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  // 复用专用 renderer 的名字判定，避免 snake_case workflow 被通用 list/search 归类吞掉。
  if (Object.values(workflowToolNames).some((matches) => matches(tool))) return null;
  const family = resolveToolCallIdentity(tool).family;
  if (["file-read", "search", "web-fetch", "explore"].includes(family)) return "explore";
  if (
    family === "shell" ||
    family === "node-repl" ||
    [tool.toolName, tool.kind].some(isZCodeCuaToolName)
  )
    return "run";
  if (family === "file-write") return "change";
  return null;
}

/** 正文与未归类工具是边界；不重新拼接真实工具关系。 */
export function groupConsecutiveAssistantSummaries(rows: readonly AssistantWorkRow[]) {
  const groups: AssistantWorkRow[][] = [];
  let current: AssistantWorkRow[] | undefined;
  for (const row of rows) {
    if (row.kind !== "reasoning" && getAssistantSummaryToolCategory(row) === null) {
      groups.push([row]);
      current = undefined;
      continue;
    }
    if (!current) {
      current = [];
      groups.push(current);
    }
    current.push(row);
  }
  return groups;
}

const fileSummariesByRow = new WeakMap<
  ToolCallRow,
  ReturnType<typeof readRawToolCallFileSummaries>
>();
function fileSummaries(row: ToolCallRow) {
  const cached = fileSummariesByRow.get(row);
  if (cached) return cached;
  const tool = toolCallRowToLegacyNode(row).toolCall;
  const summaries = readRawToolCallFileSummaries(tool.raw, tool);
  fileSummariesByRow.set(row, summaries);
  return summaries;
}

// 路径别名曾被当作不同文件；计数使用词法去重键，不依赖宿主文件系统。
function summaryFilePath(path: string, workspacePath?: string): string {
  const joined = (workspacePath ? joinFilePath(workspacePath, path) : path).replace(/\\/g, "/");
  const root = joined.startsWith("//")
    ? (joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? "//")
    : (joined.match(/^[A-Za-z]:\//)?.[0] ?? (joined.startsWith("/") ? "/" : ""));
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !root) parts.push(part);
  }
  return root + (root && !root.endsWith("/") && parts.length ? "/" : "") + parts.join("/");
}

export function formatAssistantSummaryStatistics(
  rows: readonly AssistantWorkRow[],
  intl: IntlInstance,
  workspacePath?: string,
  completed = false,
): string {
  let explore = 0,
    run = 0,
    unresolved = 0;
  const files = new Set<string>();
  for (const row of rows) {
    const category = getAssistantSummaryToolCategory(row);
    if (category === "explore") explore++;
    if (category === "run") run++;
    if (category === "change" && row.kind === "toolCall") {
      const paths = fileSummaries(row)
        .map((file) => file.path)
        .filter(Boolean);
      if (!paths.length) unresolved++;
      for (const path of paths) files.add(summaryFilePath(path, workspacePath));
    }
  }
  const parts = (
    [
      ["explore", explore],
      ["run", run],
      ["change", files.size],
      ["unresolved", unresolved],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([category, count]) =>
      intl.formatMessage(
        {
          id: `chat.summaryGroup.${category}.${completed ? "completed." : ""}${count === 1 ? "one" : "other"}`,
        },
        { count },
      ),
    );
  return (
    parts.join(intl.formatMessage({ id: "chat.summaryGroup.separator" })) ||
    intl.formatMessage({ id: "chat.summaryGroup.reasoning" })
  );
}

/** 组头代表图标的类别：修改 > 执行 > 查阅；纯思考组返回 null。 */
export function getAssistantSummaryIconCategory(
  rows: readonly AssistantWorkRow[],
): AssistantSummaryCategory | null {
  const categories = new Set(rows.map(getAssistantSummaryToolCategory));
  return (["change", "run", "explore"] as const).find((category) => categories.has(category)) ?? null;
}
