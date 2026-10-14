// 调用记录按时间倒序传入；优先展示活动调用，已结束的旧调用按需展开。
import { useState } from 'react';
import type { AgentInvocation } from '@hcode/shared/agentInvocation';
import { AgentInvocationView } from './AgentInvocationView';

function InvocationHistory({ calls }: { calls: AgentInvocation[] }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-ui-sm text-foreground-subtle">历史调用（{calls.length}）</summary>
    {open ? <div className="mt-3 space-y-3">{calls.map(call => <div key={call.id}>
      <p className="mb-2 text-ui-xs text-foreground-subtle">{new Date(call.createdAt).toLocaleString()}</p>
      <AgentInvocationView call={call} />
    </div>)}</div> : null}
  </details>;
}

export function AgentInvocationList({ calls }: { calls: AgentInvocation[] }) {
  if (!calls.length) return null;
  const active = calls.filter(call => call.status === 'running' || call.status === 'stopping');
  const current = active.length ? active : calls.slice(0, 1);
  const currentIds = new Set(current.map(call => call.id));
  const history = calls.filter(call => !currentIds.has(call.id));
  return <section aria-label="当前会话的 AI 工具调用" className="mb-4 space-y-3">
    <p className="font-medium">当前会话的 AI 调用</p>
    <p className="text-ui-sm text-foreground-subtle">调用目标和提示词由当前 AI 决定。工具等待真实结束后返回结果，当前 AI 可以继续下一步。</p>
    {current.map(call => <AgentInvocationView key={call.id} call={call} />)}
    {/* 新调用开始时重置历史展开，避免上一轮全文继续占据当前进度下方。 */}
    {history.length ? <InvocationHistory key={current.map(call => call.id).join(',')} calls={history} /> : null}
  </section>;
}
