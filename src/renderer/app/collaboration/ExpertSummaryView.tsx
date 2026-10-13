// 侧栏汇总复用主会话的结论层级，并通过真实冻结版本读取证据。
import type { ExpertState, ExpertClaimRef } from '@hcode/shared/experts';
import { expertLabel } from './expertPresentation';
import { ExpertSummaryContent } from './ExpertSummaryContent';

export function ExpertSummaryView({ state, reading, openReport }: {
  state: ExpertState; reading: boolean;
  openReport(versionId: string, name: string, claimId?: string): Promise<void>;
}) {
  if (!state.summary) return null;
  const reference = (ref: ExpertClaimRef) => `${expertLabel(state, ref.expertId)} · v${state.participants.find(expert => expert.id === ref.expertId)!.versions.find(version => version.id === ref.versionId)!.version}`;
  return <details className="rounded-lg border border-border p-3">
    <summary className="cursor-pointer font-medium">汇总结论（主会话已完整展示）</summary>
    <div className="mt-4"><ExpertSummaryContent summary={state.summary} label={id => expertLabel(state, id)} reference={reference} reading={reading} onReference={ref => void openReport(ref.versionId, reference(ref), ref.claimId)} /></div>
  </details>;
}
