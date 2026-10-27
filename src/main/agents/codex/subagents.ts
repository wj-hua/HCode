import type { NativeSubagent } from "../../../shared/types.js";
import { realpath } from "node:fs/promises";

interface Thread {
  id: string;
  cwd: string;
  parentThreadId?: string | null;
  agentNickname?: string | null;
  agentRole?: string | null;
  status?: { type?: string } | null;
}

interface Client {
  call<T>(method: string, params: unknown): Promise<T>;
}

/** 只返回能通过父子链验证属于当前会话的原生子线程。 */
export async function listCodexSubagents(client: Client, sessionId: string, projectPath: string): Promise<NativeSubagent[]> {
  const { thread: root } = await client.call<{ thread: Thread }>("thread/read", { threadId: sessionId, includeTurns: false });
  const sameDirectory = root.cwd === projectPath || await Promise.all([realpath(root.cwd), realpath(projectPath)])
    .then(([actual, requested]) => actual === requested).catch(() => false);
  if (root.id !== sessionId || !sameDirectory) throw new Error("Codex 会话与当前工作目录不匹配");
  const candidates: Thread[] = [];
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const response: { data: Thread[]; nextCursor: string | null } = await client.call("thread/list", {
        ancestorThreadId: sessionId, sourceKinds: ["subAgentThreadSpawn"], archived, limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      candidates.push(...response.data);
      cursor = response.nextCursor;
      if (!cursor) break;
      if (seen.has(cursor) || page === 99) throw new Error("Codex 子代理列表分页不完整");
      seen.add(cursor);
    }
  }
  const valid = new Set([sessionId]);
  const pending = [...candidates];
  const result: NativeSubagent[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const thread = pending[i]!;
      if (!thread.parentThreadId || !valid.has(thread.parentThreadId)) continue;
      pending.splice(i, 1);
      if (valid.has(thread.id)) continue;
      valid.add(thread.id);
      result.push({ id: thread.id, parentId: thread.parentThreadId,
        ...(thread.agentNickname ? { nickname: thread.agentNickname } : {}),
        ...(thread.agentRole ? { role: thread.agentRole } : {}),
        ...(thread.status?.type ? { status: thread.status.type } : {}),
      });
      changed = true;
    }
  }
  return result;
}
