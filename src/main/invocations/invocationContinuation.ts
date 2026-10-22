// 委派恢复策略：只续接当前来源的可信原生身份，保留历史回合和受限任务的权限边界。
import { invocationBelongsToSource, type AgentInvocation } from '../../shared/agentInvocation.js';
import type { ChatSendParams } from '../../shared/types.js';

export function sourceInvocations(records: AgentInvocation[], source: ChatSendParams) {
  return records.filter(call => invocationBelongsToSource(call, { ...source, sessionId: source.resumeSessionId }));
}

/** 查询与执行共用准入规则；进程外原生状态仍由 Codex 在发送前核验。 */
export function continuationBlockedReason(call: AgentInvocation, records: AgentInvocation[], busy: boolean): string | undefined {
  if (call.writeScope) return '文件范围受限任务不能通过普通 call_agent 续接，请用 call_agents 重新声明任务范围';
  if (!call.nativeSessionId) return '旧调用未保存原生会话 ID，无法可靠恢复；不能猜测身份或自动新开会话';
  if (busy) return '原生会话仍在运行或停止未确认，请等待真实终态后再续接';
  if (records.some(record => record.input.continueInvocationId === call.id)) return '已有后续调用，请查询最新调用再继续，不能重复恢复旧任务';
  if (call.status !== 'succeeded' && call.input.agent !== 'codex') return '当前只支持恢复中断的 Codex 调用，其他 AI 仅可续接成功调用';
  return undefined;
}

/** 只向主 AI 展示每条调用链的末端，避免旧中断记录在成功恢复后再次成为待办。 */
export function invocationContinuationList(records: AgentInvocation[], busy: (call: AgentInvocation) => boolean) {
  const continued = new Set(records.map(call => call.input.continueInvocationId).filter(Boolean));
  const latest = records.filter(call => !continued.has(call.id)).sort((left, right) => right.createdAt - left.createdAt);
  return { invocations: latest.map(call => {
    const active = busy(call);
    const blockedReason = continuationBlockedReason(call, records, active);
    const status = !active && (call.status === 'running' || call.status === 'stopping') ? 'interrupted' : call.status;
    return { invocationId: call.id, agent: call.input.agent, mode: call.input.mode, model: call.input.model,
      nativeSessionId: call.nativeSessionId, status, prompt: call.input.prompt, error: call.error,
      canContinue: !blockedReason, ...(blockedReason ? { blockedReason } : {}) };
  }) };
}
