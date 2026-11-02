// Codex 异步回复是普通用户消息中的原生信封，依靠 item id 与题序关联，历史和实时共用。
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "./types.js";

export type AsyncQuestion = NonNullable<AssistantTextRow["asyncQuestions"]>[number];
interface AsyncReply { questionItemId: string; question: string; answer: string }
const OPEN = "<send_user_message_question_reply>";
const CLOSE = "</send_user_message_question_reply>";

/** 坏题跳过但保留原始题号，否则答案会关联到另一题。 */
export function readAsyncQuestions(itemId: string, questions: unknown): AsyncQuestion[] {
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question: unknown, index) => {
    if (!question || typeof question !== "object" || !("title" in question) ||
      typeof question.title !== "string" || !question.title.trim()) return [];
    const options = "options" in question && Array.isArray(question.options)
      ? question.options.filter((option): option is string => typeof option === "string" && Boolean(option.trim())) : [];
    return [{ id: JSON.stringify(["request_user_input_async", itemId, index]), title: question.title, options }];
  });
}

export function encodeAsyncReply(question: AsyncQuestion, answer: string): string {
  return [OPEN, JSON.stringify([{ questionItemId: question.id, question: question.title, answer }]), CLOSE].join("\n");
}

/** 仅识别完整 Codex 回复。用户粘贴不完整的 JSON 时仍按原消息展示。 */
export function readAsyncReply(text: string): AsyncReply[] {
  const body = text.trim();
  if (!body.startsWith(OPEN) || !body.endsWith(CLOSE)) return [];
  let decoded: unknown;
  try { decoded = JSON.parse(body.slice(OPEN.length, -CLOSE.length)); }
  catch (error) { if (error instanceof SyntaxError) return []; throw error; }
  const replies = Array.isArray(decoded) ? decoded : [decoded];
  return replies.every(reply => reply && typeof reply.questionItemId === "string" &&
    typeof reply.question === "string" && typeof reply.answer === "string") ? replies : [];
}

/** 独立的新任务取代旧问题；当前任务中的普通插话不代表作答。已答题按原生 ID 扣除。 */
export function pendingAsyncQuestions(rows: readonly ConversationRow[]): AsyncQuestion[] {
  const pending = new Map<string, AsyncQuestion>();
  for (const row of rows) {
    if (row.kind === "assistantText") {
      for (const question of row.asyncQuestions ?? []) pending.set(question.id, question);
    } else if (row.kind === "userInput") {
      const replies = readAsyncReply(row.text);
      if (!replies.length && !row.guided) pending.clear();
      for (const reply of replies) pending.delete(reply.questionItemId);
    }
  }
  return [...pending.values()];
}
