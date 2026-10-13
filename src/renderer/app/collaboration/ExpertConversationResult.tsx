// 专家最终结果是主会话正文；复制保留全部结论，证据按钮打开本次协作的冻结引用。
import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { CollaborationPresentation } from '@hcode/shared/collaborationPresentation';
import { expertReferenceLabel } from '@hcode/shared/expertConversation';
import { Button } from '@/components/ui/button.js';
import { ExpertSummaryContent } from './ExpertSummaryContent';
import { useUiStore } from '../store/uiStore';

export function ExpertConversationResult({ entry, viewId }: { entry: CollaborationPresentation; viewId: string }) {
  const experts = entry.experts;
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const setSidePanel = useUiStore(state => state.setSidePanel);
  if (!experts?.summary) return null;
  const summary = experts.summary;
  const copy = async () => {
    const sections = [['经互审支持的共识', summary.consensus], ['未解决分歧', summary.disagreements], ['证据不足与未验证事项', summary.unverified]] as const;
    const text = [summary.summary, ...sections.map(([title, entries]) => `${title}\n${entries.map(item => `${item.statement}\n${item.sources.map(ref => expertReferenceLabel(experts, ref)).join('、')}`).join('\n\n') || '无'}`), `评审局限\n${summary.limitations.join('\n')}`, summary.failedExperts.length ? `未参与本轮互审：${summary.failedExperts.map(id => experts.labels[id]).join('、')}` : ''].filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(''); }
    catch (reason) { setCopyError(`复制失败：${String(reason)}`); }
  };
  return <article aria-label="专家评审完整结果" data-expert-result={entry.id} className="space-y-5 py-2">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"><h2 className="text-ui-base font-semibold">专家评审结果</h2>
      <div className="flex flex-wrap gap-1"><Button variant="ghost" size="sm" onClick={() => void copy()}>{copied ? <CheckIcon /> : <CopyIcon />}{copied ? '已复制' : '复制完整结果'}</Button>
      <Button variant="ghost" size="sm" onClick={() => setSidePanel({ type: 'collaboration', viewId, runId: entry.runId, intent: 'records' })}>专家报告与互审</Button></div></header>
    <ExpertSummaryContent summary={summary} label={id => experts.labels[id] ?? '未知专家'} reference={ref => expertReferenceLabel(experts, ref)} onReference={ref => setSidePanel({ type: 'collaboration', viewId, runId: entry.runId, intent: 'records', citation: { ...ref, label: expertReferenceLabel(experts, ref) } })} />
    {copyError ? <p role="alert" className="text-destructive">{copyError}</p> : null}
  </article>;
}
