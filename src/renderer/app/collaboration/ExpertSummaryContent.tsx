// 主会话和证据侧栏共用完整结论层级；引用始终定位到冻结报告与具体结论。
import type { ExpertConclusion, ExpertSummary, ExpertClaimRef } from '@hcode/shared/experts';
import { Button } from '@/components/ui/button.js';

interface Props {
  summary: ExpertSummary;
  label(id: string): string;
  reference(ref: ExpertClaimRef): string;
  onReference(ref: ExpertClaimRef): void;
  reading?: boolean;
}
function ConclusionSection({ title, entries, reference, onReference, reading }: Pick<Props, 'reference' | 'onReference' | 'reading'> & { title: string; entries: ExpertConclusion[] }) {
  return <section className="space-y-3">
    <h3 className="font-semibold">{title}<span className="ml-2 text-ui-sm font-normal text-foreground-subtle">{entries.length} 项</span></h3>
    {entries.length ? <ol className="list-decimal space-y-4 pl-5">{entries.map((entry, index) => <li key={index} className="pl-1">
      <p className="whitespace-pre-wrap break-words">{entry.statement}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">{entry.sources.map((ref, refIndex) => <Button key={refIndex} variant="link" className="h-auto min-h-7 max-w-full whitespace-normal px-0 py-1 text-left text-ui-sm" disabled={reading} onClick={() => onReference(ref)}>{reference(ref)}</Button>)}</div>
    </li>)}</ol> : <p className="text-ui-sm text-foreground-subtle">无</p>}
  </section>;
}
export function ExpertSummaryContent({ summary, label, ...citations }: Props) {
  return <div className="expert-summary space-y-6">
    <section className="space-y-2"><h3 className="font-semibold">评审结论</h3><p className="whitespace-pre-wrap break-words">{summary.summary}</p></section>
    <ConclusionSection title="经互审支持的共识" entries={summary.consensus} {...citations} />
    <ConclusionSection title="未解决分歧" entries={summary.disagreements} {...citations} />
    <ConclusionSection title="证据不足与未验证事项" entries={summary.unverified} {...citations} />
    <section className="space-y-2"><h3 className="font-semibold">评审局限</h3><ul className="list-disc space-y-2 pl-5">{summary.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></section>
    {summary.failedExperts.length ? <p>未参与本轮互审：{summary.failedExperts.map(label).join('、')}</p> : null}
  </div>;
}
