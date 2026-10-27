import type { NativeSubagent, SessionSummary } from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import type { AgyStep } from "./agyProjector.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 运行中事件包含原生子会话身份；DONE 指派发工具结束，不推断子代理终态。 */
export function agyLiveSubagents(parentId: string, update: JsonRecord): NativeSubagent[] {
  if (update.step_type !== "subagent" || update.tool_name !== "invoke_subagent" || !isRecord(update.subagent_info)) return [];
  const entries = Array.isArray(update.subagent_info.subagents) ? update.subagent_info.subagents : [];
  return entries.filter(isRecord).flatMap(entry => {
    if (typeof entry.conversation_id !== "string" || !ID.test(entry.conversation_id) || entry.conversation_id === parentId) return [];
    return [{ id: entry.conversation_id, parentId,
      ...(typeof entry.role === "string" && entry.role ? { role: entry.role } : {}),
      ...(typeof entry.type_name === "string" && entry.type_name ? { nickname: entry.type_name } : {}),
    }];
  });
}

/** 历史中 invoke_subagent 的 GENERIC 结果保存了子会话 ID。 */
export function agyHistorySubagents(parentId: string, steps: readonly AgyStep[]): NativeSubagent[] {
  const pending: Array<{ name: string; role?: string; nickname?: string }> = [];
  const found = new Map<string, NativeSubagent>();
  for (const step of steps) {
    if (step.type === "PLANNER_RESPONSE") {
      pending.length = 0;
      for (const call of Array.isArray(step.tool_calls) ? step.tool_calls : []) {
        if (!isRecord(call)) continue;
        const args = isRecord(call.args) ? call.args : {};
        pending.push({ name: typeof call.name === "string" ? call.name : "",
          ...(typeof args.Role === "string" ? { role: args.Role } : {}),
          ...(typeof args.TypeName === "string" ? { nickname: args.TypeName } : {}),
        });
      }
    } else if (step.type === "GENERIC") {
      const call = pending.shift();
      if (call?.name !== "invoke_subagent" || step.status !== "DONE" || typeof step.content !== "string") continue;
      const marker = "Created the following subagent";
      const position = step.content.indexOf(marker);
      if (position < 0) continue;
      const body = step.content.slice(position + marker.length);
      for (const match of body.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]+)"/gi)) {
        const id = match[1]!;
        if (!ID.test(id) || id === parentId) continue;
        found.set(id, { id, parentId, ...(call.role ? { role: call.role } : {}), ...(call.nickname ? { nickname: call.nickname } : {}) });
      }
    }
  }
  return [...found.values()];
}

export function isAgyConversationId(id: string): boolean { return ID.test(id); }

/** 仅过滤有明确父子关联的会话，不能靠缺标题或消息内容猜测。 */
export function filterAgySubagentSessions(sessions: SessionSummary[], childIds: ReadonlySet<string>): SessionSummary[] {
  return sessions.filter(session => !childIds.has(session.id));
}
