// 专家定向补资料与续研；选择只生成预览，不自动重做已完成研究。
import { useState } from 'react';
import type { CollaborationSnapshot } from '@hcode/shared/collaboration';
import { recoveryOptions, recoveryTarget } from '@hcode/shared/collaborationRecovery';
import type { ExpertResumeParams } from '@hcode/shared/experts';
import { Button } from '@/components/ui/button.js';
import { hcode } from '../bridge';
import { bindCollaborationSource } from './sourceConversation';
import { SupplementContext } from './SupplementContext';
import { ResumePreview } from './ResumePreview';

export function ExpertRecoveryControls({ run }: { run: CollaborationSnapshot }) {
  const [selectedId, setSelectedId] = useState<string>();
  if (['running', 'stopping', 'cancelled'].includes(run.status)) return null;
  const options = recoveryOptions(run);
  const selected = options.find(option => option.id === selectedId);
  return <details open={run.status !== 'completed'} className="rounded-lg border border-border p-3">
    <summary className="cursor-pointer font-medium">专家补资料与续跑</summary>
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-ui-sm text-foreground-subtle">先给指定专家保存资料，再选择阶段并明确开始。旧报告和意见保留；其他专家不重新研究，团队会重新互审和汇总。</p>
      {run.experts!.participants.map(expert => <section key={expert.id} className="rounded-lg border border-border p-3">
        <p className="text-ui-sm font-medium">{recoveryTarget(run, expert.id)}</p>
        {expert.error ? <p className="mt-1 whitespace-pre-wrap text-ui-sm text-destructive">{expert.error}</p> : null}
        <SupplementContext runId={run.id} targetId={expert.id} target={recoveryTarget(run, expert.id)} />
        <Button className="mt-3" variant="outline" onClick={() => setSelectedId(expert.id)}>选择此专家重新研究</Button>
      </section>)}
      <div className="flex flex-wrap gap-2">{options.filter(option => !('expertId' in option.params)).map(option => <Button key={option.id} variant="outline" onClick={() => setSelectedId(option.id)}>选择{option.label}</Button>)}</div>
      {selected ? <ResumePreview key={selected.id} run={run} option={selected} cancel={() => setSelectedId(undefined)} start={async () => { bindCollaborationSource(run); await hcode.invoke('collaboration:resumeExperts', run.id, selected.params as ExpertResumeParams); }} /> : null}
    </div>
  </details>;
}
