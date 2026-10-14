// 当前源会话的调用记录和错误反馈；历史查询不调用模型或自动续跑。
import { useEffect, useMemo, useState } from 'react';
import { invocationBelongsToSource } from '@hcode/shared/agentInvocation';
import type { Conversation } from '../store/appStore';
import { hcode } from '../bridge';
import { subscribeAgentInvocations, useAgentInvocationStore } from './agentInvocationStore';
export function useAgentInvocations(conversation: Conversation) {
  const all = useAgentInvocationStore(state => state.calls);
  const [error, setError] = useState('');
  const calls = useMemo(() => Object.values(all).filter(call => invocationBelongsToSource(call, conversation)).sort((left, right) => right.createdAt - left.createdAt), [all, conversation.sessionKey, conversation.sessionId, conversation.agent, conversation.projectPath]);
  useEffect(subscribeAgentInvocations, []);
  useEffect(() => {
    if (!conversation.sessionKey && !conversation.sessionId) return;
    let current = true;
    setError('');
    void hcode.invoke('agentInvocation:list', conversation.sessionKey ?? crypto.randomUUID(), conversation.sessionId).then(
      records => { if (current) records.forEach(useAgentInvocationStore.getState().accept); },
      reason => { if (current) setError(`读取 AI 调用记录失败：${String(reason)}`); },
    );
    return () => { current = false; };
  }, [conversation.sessionKey, conversation.sessionId]);
  return { calls, error, running: calls.some(call => call.status === 'running' || call.status === 'stopping') };
}
