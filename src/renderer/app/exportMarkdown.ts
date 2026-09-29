import { AGENTS } from "@hcode/shared/agents";
import type { ConversationRow, SessionSummary } from "@hcode/shared/types";
import { shortenHome } from "./format";

// 工具调用摘要优先取这些字段（各 CLI 的参数名不同）
const TOOL_SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description"];

function toolSummary(row: Extract<ConversationRow, { kind: "toolCall" }>): string {
  const input = row.input && typeof row.input === "object" ? (row.input as Record<string, unknown>) : {};
  const key = TOOL_SUMMARY_KEYS.find((name) => typeof input[name] === "string" && input[name]);
  const raw = key ? (input[key] as string) : row.inputText;
  const oneLine = raw.replace(/\s+/g, " ").replaceAll("`", "'").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

function rowToMarkdown(row: ConversationRow): string | null {
  switch (row.kind) {
    case "userInput": {
      const files = (row.attachments ?? []).map((file) => `- 📎 ${file.fileName}`).join("\n");
      const heading = row.origin === "realUser" ? "## 用户" : "## 系统消息";
      return [heading, row.text.trim(), files].filter(Boolean).join("\n\n");
    }
    case "assistantText":
      return row.text.trim() ? `## 助手\n\n${row.text.trim()}` : null;
    case "toolCall": {
      const summary = toolSummary(row);
      const failed = row.status === "error" ? ` ❌ ${row.error?.message ?? "失败"}` : "";
      return `- 🔧 \`${row.toolName}\`${summary ? ` \`${summary}\`` : ""}${failed}`;
    }
    case "subagent":
      return `- 🤖 子智能体 \`${row.subagentType}\`${row.summaryText ? `：${row.summaryText.replace(/\s+/g, " ")}` : ""}`;
    case "artifact":
      return `- 📄 产物：${row.displayName}`;
    default:
      return null;
  }
}

/** 把会话行转成 Markdown：用户消息与回复完整保留，工具调用只留一行摘要，思考过程与工具输出不导出。 */
export function conversationToMarkdown(session: SessionSummary, rows: readonly ConversationRow[]): string {
  const blocks: string[] = [
    `# ${session.title}`,
    `> ${AGENTS[session.agent].name} · ${shortenHome(session.projectPath)} · ${new Date(session.updatedAt).toLocaleString()}`,
  ];
  let previousWasTool = false;
  for (const row of rows) {
    const block = rowToMarkdown(row);
    if (!block) continue;
    const isTool = block.startsWith("- ");
    // 连续的工具摘要合成一个列表
    if (isTool && previousWasTool) blocks[blocks.length - 1] += `\n${block}`;
    else blocks.push(block);
    previousWasTool = isTool;
  }
  return `${blocks.join("\n\n")}\n`;
}

/** 会话标题转成可作文件名的字符串。 */
export function markdownFileName(title: string): string {
  const name = title.replace(/[\\/:*?"<>|\n\r]+/g, "-").trim().slice(0, 80);
  return `${name || "session"}.md`;
}
