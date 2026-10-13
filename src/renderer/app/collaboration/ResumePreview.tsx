// 选择阶段仅预览；用户明确开始后宿主复核身份、证据、活动回合、采纳状态和累计预算。
import { COLLABORATION_LIMITS, type CollaborationSnapshot } from '@hcode/shared/collaboration';
import type { RecoveryOption } from '@hcode/shared/collaborationRecovery';
import { Button } from '@/components/ui/button.js';
import { useEffect, useRef } from 'react';
import { useCollaborationAction } from './useCollaborationAction';

export function ResumePreview({ run, option, start, cancel }: { run: CollaborationSnapshot; option: RecoveryOption; start(): Promise<unknown>; cancel(): void }) {
  const { busy, error, feedback, act } = useCollaborationAction();
  const preview = useRef<HTMLElement>(null);
  useEffect(() => { preview.current?.focus(); preview.current?.scrollIntoView({ block: 'nearest' }); }, []);
  return <section ref={preview} tabIndex={-1} aria-label="续跑预览" className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 focus-visible:ring-2 focus-visible:ring-ring">
    <p className="font-medium">准备{option.label} · {option.target}</p>
    <p className="text-ui-sm">{option.stages}</p>
    <p className="text-ui-sm text-foreground-subtle">已用 {run.tasks.length} / {run.experts?.turnLimit ?? COLLABORATION_LIMITS.maxTurns} 回合，本次至少需要 {option.minTurns} 回合。纠正和修订也计入原预算；不足时停止。</p>
    <p className="text-ui-sm text-foreground-subtle">仅使用已保存资料。开始时重新核对源码和报告；旧版本与审查意见保留。{run.status === 'interrupted' ? '重启后的原生状态未知，本次为你明确选择的续跑。' : ''}</p>
    {option.blocked ? <p role="status">{option.blocked}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button className="active:brightness-90" disabled={busy || Boolean(option.blocked) || Boolean(feedback)} onClick={() => void act(start, '续跑已启动，请查看任务进度。')}>{busy ? '正在核对并启动…' : '开始此续跑'}</Button>
      <Button variant="ghost" disabled={busy} onClick={cancel}>返回选择</Button>
    </div>
    {feedback ? <p role="status">{feedback}</p> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p> : null}
  </section>;
}
