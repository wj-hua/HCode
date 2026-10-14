// 展示经主进程校验 hash/schema 的冻结报告；结论定位到真实 claimId，原始 JSON 可展开。
import { joinFilePath, getPathLeaf } from "@/lib/path.js";
import { useEffect, useRef } from 'react';
import type { CollaborationReport } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
import { useFilePreview } from '../conversation/FilePreviewContext';

export function FrozenReportView({ artifact, claimId, workspacePath }: { artifact: { text: string; report: CollaborationReport }; claimId?: string; workspacePath?: string }) {
  const selected = useRef<HTMLElement>(null);
  const preview = useFilePreview();
  // 长结论可能超过可视区域；从标题开始阅读，避免居中后把证据标题滚出弹窗。
  useEffect(() => { if (claimId) { selected.current?.focus(); selected.current?.scrollIntoView({ block: 'start' }); } }, [artifact, claimId]);
  return <div className="mt-3 space-y-4">
    <p className="whitespace-pre-wrap">{artifact.report.summary}</p>
    {artifact.report.findings.map(finding => <section key={finding.id} ref={finding.id === claimId ? selected : undefined} tabIndex={finding.id === claimId ? -1 : undefined} className={`rounded-md p-2 ${finding.id === claimId ? 'bg-selected ring-1 ring-ring' : ''}`}>
      <h3 className="font-medium">{finding.title}</h3><p className="mt-2 whitespace-pre-wrap">{finding.detail}</p>
      {finding.evidence.map((evidence, index) => <div key={index} className="mt-2 border-l-2 border-border pl-3">
        <Button variant="link" className="h-auto max-w-full whitespace-normal px-0 text-left" disabled={!preview} onClick={() => { if (workspacePath) preview?.onOpenCodeViewer({ type: "file", title: getPathLeaf(evidence.path), path: joinFilePath(workspacePath, evidence.path) }); else preview?.onOpenFilePath(evidence.path); }}>{evidence.path}:{evidence.startLine}–{evidence.endLine}</Button>
        <blockquote className="mt-1 whitespace-pre-wrap text-foreground-subtle">{evidence.quote}</blockquote>
      </div>)}
    </section>)}
    {artifact.report.limitations.length ? <section><h3 className="font-medium">验证局限</h3><ul className="mt-2 list-disc pl-5">{artifact.report.limitations.map((limit, index) => <li key={index}>{limit}</li>)}</ul></section> : null}
    <details><summary className="cursor-pointer text-ui-sm text-foreground-subtle">原始 JSON 与结论标识</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all text-ui-sm">{artifact.text}</pre></details>
  </div>;
}
