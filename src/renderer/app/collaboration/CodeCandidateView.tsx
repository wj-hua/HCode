// 展示精确版本的实际检查和冻结差异；接管使旧通过结论失效，丢弃只删除可写副本。
import { useEffect, useState } from 'react';
import type { CollaborationSnapshot } from '@hcode/shared/collaboration';
import type { CandidatePreview } from '@hcode/shared/codeDelivery';
import { Button } from '@/components/ui/button.js';
import { hcode } from '../bridge';
import { CodeAdoptionView } from './CodeAdoptionView';
import { adoptionBlocksEdits } from '@hcode/shared/codeAdoption';
const PHASE_LABELS = { execution: "实现 / 修订", validation: "运行检查", review: "独立审查", candidate: "待采纳", manual: "人工接管", discarded: "已丢弃" } as const;
const CHANGE_LABELS = { added: "新增", modified: "修改", deleted: "删除" } as const;

export function CodeCandidateView({ run }: { run: CollaborationSnapshot }) {
  const [preview, setPreview] = useState<CandidatePreview>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  useEffect(() => { setPreview(undefined); setError(''); }, [run.id]);
  const code = run.code;
  if (!code) return null;
  const working = ['running', 'stopping'].includes(run.status), discarded = code.workspace.state === 'discarded';
  const phaseLabel = code.adoption?.status === 'applied' ? '已采纳' : code.adoption && ['prepared', 'applying', 'needsRecovery'].includes(code.adoption.status) ? '采纳需恢复' : PHASE_LABELS[code.phase];
  const act = async (action: 'manual' | 'discard') => {
    setBusy(true); setError('');
    try { const path = await hcode.invoke('collaboration:candidateAction', run.id, action); if (action === 'manual') await hcode.invoke('app:openPath', path); setDiscardConfirm(false); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const read = async (id: string) => {
    setBusy(true); setError('');
    try { setPreview(await hcode.invoke('collaboration:candidatePreview', run.id, id)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-3 rounded-lg border border-border p-3" aria-label="隔离代码候选">
    <p className="font-medium">{discarded ? '候选已丢弃，冻结历史保留' : code.adoption?.status === 'applied' ? '候选已应用到原项目' : run.status === 'completed' ? '验证与审查通过 · 待采纳候选' : '隔离代码候选'} · {phaseLabel}</p>
    <p className="text-ui-sm text-foreground-subtle">{code.adoption?.status === 'applied' ? '原项目已应用所选版本。' : code.adoption && ['prepared', 'applying', 'needsRecovery'].includes(code.adoption.status) ? '原项目可能有未完成改动，请恢复。' : '原项目未应用。'}当前阶段：{phaseLabel} · 副本路径：<span className="break-all select-text">{code.workspace.path}</span></p>
    <div className="flex flex-wrap gap-2">{code.versions.map((version) => <Button key={version.id} variant="outline" disabled={busy} onClick={() => void read(version.id)}>候选 v{version.version} · {version.changes.length} 个文件差异</Button>)}</div>
    {code.validations.map((check, index) => <details key={`${check.versionId}-${check.checkId}-${index}`} open={check.status !== 'passed'}>
      <summary className="cursor-pointer">v{code.versions.find((version) => version.id === check.versionId)?.version} · {check.checkId} · {check.status === 'passed' ? '通过' : check.status === 'failed' ? '失败' : '已中断'} · 退出码 {check.exitCode ?? '无'}</summary>
      <p className="break-all text-ui-sm text-foreground-subtle">{check.command} · hash {check.versionHash}</p>
      <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-ui-sm">{check.stdout}{check.stderr}</pre>{check.logTruncated ? <p>日志达到大小上限，已明确截断。</p> : null}
    </details>)}
    {preview ? <div className="flex flex-col gap-2"><p className="font-medium">冻结候选 v{preview.version.version}</p>{preview.changes.map((change) => <details key={change.path}><summary className="cursor-pointer break-all">{change.path} · {CHANGE_LABELS[preview.version.changes.find((entry) => entry.path === change.path)!.kind]}{change.binary ? ' · 二进制 / 链接（显示 hash 与权限）' : ''}</summary><details className="text-ui-sm text-foreground-subtle"><summary>文件 hash 与权限记录</summary><p className="break-all">基线：{preview.version.changes.find((entry) => entry.path === change.path)?.beforeHash ?? "无"}</p><p className="break-all">候选：{preview.version.changes.find((entry) => entry.path === change.path)?.afterHash ?? "无"}</p><p>权限：{preview.version.changes.find((entry) => entry.path === change.path)?.beforeMode?.toString(8) ?? "无"} → {preview.version.changes.find((entry) => entry.path === change.path)?.afterMode?.toString(8) ?? "无"}</p></details>{!change.binary ? <div className="grid grid-cols-1 gap-2 md:grid-cols-2"><div><p>基线</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-ui-sm">{change.before ?? '文件不存在'}</pre></div><div><p>候选</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-ui-sm">{change.after ?? '文件已删除'}</pre></div></div> : null}</details>)}</div> : null}
    {!discarded ? <CodeAdoptionView run={run} versionId={preview?.version.id} /> : null}
    {!discarded && !adoptionBlocksEdits(code.adoption) ? <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || working || code.stopUnconfirmed} onClick={() => void act('manual')}>接管副本（旧审查失效）</Button><Button variant="outline" disabled={busy || working || code.stopUnconfirmed} onClick={() => setDiscardConfirm(true)}>丢弃可写副本</Button>{discardConfirm ? <><span>保留冻结历史，删除副本内未冻结的人工改动。</span><Button variant="destructive" disabled={busy} onClick={() => void act('discard')}>确认丢弃</Button><Button variant="outline" onClick={() => setDiscardConfirm(false)}>返回</Button></> : null}</div> : null}
    {working ? <p className="text-ui-sm text-foreground-subtle">先暂停，收到停止确认并释放租约后才能接管。</p> : null}
    {code.stopUnconfirmed ? <p role="alert">原生停止未确认，工作区仍锁定，不能接管或续跑。</p> : null}
    {error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{error}</p> : null}
  </section>;
}
