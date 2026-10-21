// 展示主 AI 的实际提示词、子会话状态和原生进度；结束结果已由工具协议返回源回合。
import { useEffect, useState } from 'react';
import type { AgentInvocation } from '@hcode/shared/agentInvocation';
import type { ConversationRow } from '@hcode/shared/types';
import { AGENTS } from '@hcode/shared/agents';
import { Button } from '@/components/ui/button.js';
import { MessageResponse } from '@/components/ai-elements/message.js';
import { hcode } from '../bridge';
import { useAppStore } from '../store/appStore';
import { Timeline } from '../conversation/Timeline';
import { PermissionCard } from '../conversation/PermissionCard';
import { useAgentInvocationStore } from './agentInvocationStore';
const STATUS_LABELS: Record<AgentInvocation['status'], string> = { running: '正在调用', stopping: '等待原生停止确认', succeeded: '调用完成', failed: '调用失败', cancelled: '调用已取消', interrupted: '调用中断，需核对执行状态' };

function InvocationTranscript({ call }: { call: AgentInvocation }) {
  const live = useAgentInvocationStore(state => state.rows[call.sessionKey]);
  const permissions = useAppStore(state => state.permissions);
  const [history, setHistory] = useState<ConversationRow[]>();
  const [error, setError] = useState('');
  const running = call.status === 'running' || call.status === 'stopping';
  useEffect(() => {
    if (running || live || !call.nativeSessionId) return;
    let current = true;
    void hcode.invoke('sessions:load', { agent: call.input.agent, id: call.nativeSessionId, projectPath: call.source.projectPath }).then(result => { if (current) setHistory(result.rows); }, reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [call.id, call.nativeSessionId, running, live]);
  const pending = Object.values(permissions).filter(request => request.sessionKey === call.sessionKey);
  return <div className="min-w-0 max-w-full space-y-3">
    {pending.map(request => <PermissionCard key={request.interactionId} request={request} workspacePath={call.source.projectPath} />)}
    {error ? <p role="alert" className="text-destructive">读取子会话失败：{error}</p> : null}
    {live || history ? <Timeline rows={live ?? history!} workspacePath={call.source.projectPath} permissions={{}} running={running} canFork={false} canResend={false} highlightedRowId={null} /> : <p className="text-ui-sm text-foreground-subtle">{running ? '等待原生执行事件…' : '原生会话记录按需读取。'}</p>}
  </div>;
}
export function AgentInvocationView({ call }: { call: AgentInvocation }) {
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true); setError('');
    try { await hcode.invoke('agentInvocation:cancel', call.id); } catch (reason) { setError(String(reason)); } finally { setCancelling(false); }
  };
  const pending = useAppStore(state => Object.values(state.permissions).some(request => request.sessionKey === call.sessionKey));
  return <article aria-label={`${AGENTS[call.input.agent].name} 调用`} className="min-w-0 max-w-full space-y-3 rounded-lg border border-border p-3">
    <div aria-live="polite"><p className="font-medium">{AGENTS[call.input.agent].name} · {call.input.mode === 'execute' ? '执行' : '只读审核 / 研究'}</p><p className="mt-1 text-ui-sm">{STATUS_LABELS[call.status]}{pending ? ' · 等待你的审批' : ''}</p></div>
    {call.writeScope ? <div className="text-ui-sm"><p className="font-medium">并行任务：{call.writeScope.taskKey}</p><p className="text-foreground-subtle">仅通过宿主工具修改以下文件；子任务不运行构建或测试。</p><ul className="list-inside list-disc break-all">{call.writeScope.allowedPaths.map(path => <li key={path}>{path}</li>)}</ul></div> : null}
    {call.writeFeedback?.length ? <details open><summary className="cursor-pointer text-ui-sm">写入反馈 · 主 AI 需核对分工</summary>{call.writeFeedback.map((feedback, index) => <p key={index} className="mt-2 break-all text-ui-sm text-destructive">{feedback.path}：{feedback.error}<br />{feedback.guidance}</p>)}</details> : null}
    <details><summary className="cursor-pointer text-ui-sm">当前 AI 提供的提示词</summary><p className="mt-2 whitespace-pre-wrap break-words text-ui-sm">{call.input.prompt}</p></details>
    {call.input.model ? <p className="text-ui-sm text-foreground-subtle">模型：{call.input.model}</p> : null}
    {call.error || error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{call.error || error}</p> : null}
    {call.status === 'running' ? <Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在请求停止…' : '停止此调用'}</Button> : null}
    {call.output ? <MessageResponse>{call.output}</MessageResponse> : null}
    <details open={call.status === 'running' || call.status === 'stopping' || pending}><summary className="cursor-pointer text-ui-sm">原生调用进度与记录</summary><div className="mt-3"><InvocationTranscript call={call} /></div></details>
  </article>;
}
