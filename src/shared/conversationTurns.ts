// 会话行的回合语义：主进程分叉与渲染进程消息操作共用，保证双方对“第几条用户消息”的计数一致。
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "./types.js";

/** 开启一个回合的用户消息。回合中途插话（guided）留在原回合内，不能作为分叉 / 回退的锚点。 */
export function isTurnStartInput(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput" && row.guided !== true;
}
