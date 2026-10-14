// 专家团队常驻可见；只折叠单个专家的详细记录，不折叠整个团队入口。
import type { ExpertState } from '@hcode/shared/experts';
import { ExpertParticipantView } from './ExpertParticipantView';

export function ExpertParticipantsSection({ state, reading, openReport }: {
  state: ExpertState;
  reading: boolean;
  openReport(versionId: string, name: string): Promise<void>;
}) {
  return <section aria-label="专家报告与互审" className="space-y-3">
    <h2 className="font-semibold">专家报告与互审<span className="ml-2 text-ui-sm font-normal text-foreground-subtle">{state.participants.length} 位专家</span></h2>
    <div className="divide-y divide-border rounded-lg border border-border">
      {state.participants.map(expert => <ExpertParticipantView key={expert.id} expert={expert} state={state} reading={reading} openReport={openReport} />)}
    </div>
  </section>;
}
