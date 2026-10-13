// 接管、澄清与续跑的用户入口；状态以宿主记录为准，保存资料不启动模型。
import { useState } from 'react';
import { usagePresentation } from '@hcode/shared/collaborationPresentation';
import { recoveryOptions, recoveryTarget } from '@hcode/shared/collaborationRecovery';
import { COLLABORATION_LIMITS, type CollaborationSnapshot, type TaskMessage } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
import { bindCollaborationSource } from './sourceConversation';
import { takeoverPresentation } from './openPresentation';
import { useCollaborationAction } from './useCollaborationAction';
import { SupplementContext } from './SupplementContext';
import { ResumePreview } from './ResumePreview';
import { hcode } from '../bridge';

function ContextReply({ run, question, saved }: { run: CollaborationSnapshot; question: TaskMessage; saved(message: string): void }) {
  const [text, setText] = useState('');
  const { busy, error, act } = useCollaborationAction();
  const target = recoveryTarget(run, question.deliveryId);
  const reply = async () => {
    if (await act(() => hcode.invoke('collaboration:reply', run.id, question.id, text.trim()), '')) saved(`回复已保存，接收目标：${target}；若任务正在等待人工处理，请选择此任务的续跑操作。`);
  };
  return <form onSubmit={event => { event.preventDefault(); void reply(); }} className="rounded-lg border border-border p-3">
    <p className="font-medium">{question.requiresUser ? '需要你的决定' : '执行者请求上下文'}</p>
    <p className="mt-1 text-ui-sm text-foreground-subtle">提问者与接收目标：{target}</p>
    <p className="mt-1 whitespace-pre-wrap">{question.text}</p>
    <label className="mt-2 flex flex-col gap-1">回复<textarea required maxLength={COLLABORATION_LIMITS.maxContextLength} value={text} onChange={event => setText(event.target.value)} rows={2} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
    <Button type="submit" variant="outline" className="mt-2 active:brightness-90" disabled={busy || !text.trim()}>{busy ? '正在保存…' : '仅保存回复'}</Button>
    {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
  </form>;
}

export function CollaborationControls({ run }: { run: CollaborationSnapshot }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [replyFeedback, setReplyFeedback] = useState('');
  const { busy, error, feedback, act } = useCollaborationAction();
  const active = run.status === 'running' || run.status === 'stopping';
  const pending = (run.messages ?? []).filter(entry => entry.type === 'clarification' && !run.messages?.some(reply => reply.replyTo === entry.id));
  const options = run.experts ? [] : recoveryOptions(run);
  const selected = options.find(option => option.id === selectedId);
  const usage = usagePresentation(run.tasks);
  const takeover = async () => {
    await takeoverPresentation(run);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus());
  };
  return <div className="flex flex-col gap-3">
    <details><summary className="cursor-pointer text-ui-sm text-foreground-subtle">回合与用量 · {run.tasks.length} 个回合</summary><p className="mt-2 text-ui-sm text-foreground-subtle">已用 {run.tasks.length} / {run.experts?.turnLimit ?? COLLABORATION_LIMITS.maxTurns} 回合 · 最多 {COLLABORATION_LIMITS.maxConcurrentWorkers} 个执行 / 审查回合并发。{usage.knownTurns ? `已知输入 ${usage.inputTokens}，输出 ${usage.outputTokens} Token；` : '未提供可信 Token 用量；'}{usage.unknownTurns} 个回合用量未知。额度不足会明确失败，不自动换模型。</p></details>
    <details open={active || pending.length > 0 || ['awaitingUser', 'failed', 'interrupted', 'paused'].includes(run.status) ? true : undefined}>
      <summary className="cursor-pointer text-ui-sm">{active ? '协作控制' : '补充与继续'}</summary>
      <div className="mt-3 flex flex-col gap-3">
        {active ? <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || run.status === 'stopping'} onClick={() => void act(() => hcode.invoke('collaboration:pause', run.id), '已请求暂停；收到原生确认后才可接管。')}>请求暂停</Button>
          <Button variant="destructive" disabled={busy || run.stopIntent === 'cancel'} onClick={() => void act(() => hcode.invoke('collaboration:cancel', run.id), '已请求停止；等待原生确认。停止后不能续跑本次协作。')}>停止本次协作</Button>
          {run.status === 'stopping' && run.stage === 'finished' ? <Button variant="outline" disabled={busy} onClick={() => void act(() => hcode.invoke('collaboration:get', run.id), '已核对停止状态；是否可接管仍以宿主确认状态为准。')}>核对停止状态</Button> : null}
          <p role="status" className="text-ui-sm">{run.status === 'stopping' ? '等待原生确认，当前仍不能接管或发送普通消息。' : '协作占用原会话；在这里补资料或请求暂停，不向普通聊天插入消息。'}</p>
        </div> : null}
        {run.status === 'paused' ? <div className="flex flex-col gap-2"><p role="status">原生回合已确认暂停。接管前会再次核对源会话是否已恢复。</p><Button className="self-start" variant="outline" disabled={busy} onClick={() => void act(takeover, '已返回原会话，可人工继续。')}>接管原会话</Button></div> : null}
        {run.status === 'interrupted' ? <p role="status" className="text-ui-sm">执行状态未知，未自动恢复，也未确认安全接管。请查看停止原因，选择具体任务核对后续跑；代码候选停止未确认时仍禁止操作。</p> : null}
        {run.status !== 'cancelled' && run.status !== 'stopping' ? pending.map(question => <ContextReply key={question.id} run={run} question={question} saved={setReplyFeedback} />) : null}
        {replyFeedback ? <p role="status" className="text-ui-sm">{replyFeedback}</p> : null}
        {run.deliveries.map(delivery => <section key={delivery.id} className="rounded-lg border border-border p-3">
          <p className="text-ui-sm font-medium">{recoveryTarget(run, delivery.id)}</p>
          {active && ['queued', 'executing', 'reviewing', 'revising'].includes(delivery.status) ? <Button className="mt-2" variant="outline" disabled={busy || run.status === 'stopping'} onClick={() => void act(() => hcode.invoke('collaboration:cancelDelivery', run.id, delivery.id), '已请求停止此任务，等待其原生终态；其他任务保留。')}>停止此任务</Button> : null}
          {options.some(option => 'deliveryId' in option.params && option.params.deliveryId === delivery.id) ? <>
            <SupplementContext runId={run.id} targetId={delivery.id} target={recoveryTarget(run, delivery.id)} />
            <div className="mt-3 flex flex-wrap gap-2">{options.filter(option => 'deliveryId' in option.params && option.params.deliveryId === delivery.id).map(option => <Button key={option.id} variant="outline" onClick={() => setSelectedId(option.id)}>选择{option.label}</Button>)}</div>
          </> : null}
        </section>)}
        {selected ? <ResumePreview key={selected.id} run={run} option={selected} cancel={() => setSelectedId(undefined)} start={async () => { bindCollaborationSource(run); await hcode.invoke('collaboration:resume', run.id, selected.params as import('@hcode/shared/collaboration').CollaborationResumeParams); }} /> : null}
        {run.messages?.length ? <details><summary className="cursor-pointer">资料与回复记录（{run.messages.length}）</summary>{run.messages.map(message => <p key={message.id} className="mt-2 whitespace-pre-wrap"><span className="font-medium">{recoveryTarget(run, message.deliveryId)} · {message.sender === 'worker' ? '执行者提问' : message.sender === 'user' ? '用户' : '发起 AI'}：</span>{message.text}</p>)}</details> : null}
      </div>
    </details>
    {busy ? <p role="status">正在处理，请等待状态确认…</p> : null}
    {feedback ? <p role="status" className="text-ui-sm">{feedback}</p> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p> : null}
  </div>;
}
