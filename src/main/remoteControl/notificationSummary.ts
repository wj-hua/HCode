// 通知摘要（Mapper）：从会话实时行里取本轮最后一条 AI 回复，转成单行纯文本并截取开头几句，供推送正文使用。
// 只读最后一个用户输入之后的回复：没有回复的轮次（被中断、只有工具调用）返回 undefined，不能拿上一轮的旧回复冒充。
import type { ConversationRow } from "../../shared/types.js";

/** 推送正文在锁屏折叠态约显示 4 行，摘要留 3 行左右，展开后可看完整摘要。 */
export const SUMMARY_MAX_LENGTH = 100;
const SENTENCE_END = /[。！？!?；;]|\.(?=\s)/gu;
const ELLIPSIS = "…";

export function replySummary(rows: readonly ConversationRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.kind === "userInput") return undefined;
    if (row.kind !== "assistantText") continue;
    const text = plainText(row.text);
    if (text) return leadingSentences(text);
  }
  return undefined;
}

/** 代码块、表格和分隔线在通知里没有可读性，整段丢弃；其余 Markdown 只去掉标记保留文字。 */
function plainText(markdown: string): string {
  let inFence = false;
  const lines: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith("|") || /^([-*_])\1{2,}$/u.test(trimmed)) continue;
    lines.push(trimmed
      .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/u, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
      .replace(/(\*\*|__|`)/gu, ""));
  }
  return lines.join(" ").replace(/\s+/gu, " ").trim();
}

/** 按句子边界累加到上限；第一句本身超长时按码点截断并补省略号，避免切开代理对。 */
function leadingSentences(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= SUMMARY_MAX_LENGTH) return text;
  let end = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const boundary = Array.from(text.slice(0, match.index + match[0].length)).length;
    if (boundary > SUMMARY_MAX_LENGTH) break;
    end = boundary;
  }
  if (end > 0) return codePoints.slice(0, end).join("").trim();
  return codePoints.slice(0, SUMMARY_MAX_LENGTH - 1).join("").trimEnd() + ELLIPSIS;
}
