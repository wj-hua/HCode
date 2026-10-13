// 展示宿主发现的完整复制清单和有限检查，分页只影响显示，不裁剪确认范围。
import { useEffect, useState } from 'react';
import type { CodeDraft, CodeDraftEdit } from '@hcode/shared/codeDraft';
import { codeDraftRemainingTurns } from '@hcode/shared/codeDraft';
import { COLLABORATION_LIMITS } from '@hcode/shared/collaboration';
import { Button } from '@/components/ui/button.js';
const COPY_PAGE_SIZE = 40;
const BYTES_PER_MIB = 1024 ** 2;
export function CodeDraftScope({ draft, edit, disabled, onChange }: { draft: CodeDraft; edit: CodeDraftEdit; disabled: boolean; onChange(value: CodeDraftEdit): void }) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [draft.id, draft.admission?.hash]);
  if (!draft.admission) return <p role="status">尚未取得项目复制与验证清单。</p>;
  const admission = draft.admission;
  return <fieldset disabled={disabled} className="flex flex-col gap-3"><legend className="mb-2 font-medium">副本与必需验证</legend>
    <p className="text-ui-sm">完整复制 {admission.fileCount.toLocaleString()} 个文件 · {(admission.bytes / BYTES_PER_MIB).toFixed(1)} MiB，含未提交、未跟踪及 ignored 依赖，不含 .git。每项任务独立复制同一基线。</p>
    <p className="text-ui-sm text-foreground-subtle">仅在候选副本写入，网络关闭，不安装依赖；检查由宿主运行。原项目在你逐项采纳前不写入。累计 {COLLABORATION_LIMITS.maxTurns} 回合，已用 {draft.turns.length}，执行、审查和汇总还需至少 {codeDraftRemainingTurns(edit.tasks.length)}；修订和格式纠正同样占用预算。</p>
    <details><summary className="cursor-pointer text-ui-sm">完整复制清单（{draft.copyPaths.length} 个文件）</summary><ul className="mt-2 max-h-48 overflow-auto text-ui-sm">{draft.copyPaths.slice(page * COPY_PAGE_SIZE, (page + 1) * COPY_PAGE_SIZE).map(path => <li key={path} className="break-all">{path}</li>)}</ul><div className="mt-2 flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page + 1} / {Math.max(1, Math.ceil(draft.copyPaths.length / COPY_PAGE_SIZE))} 页</span><Button type="button" variant="outline" size="sm" disabled={(page + 1) * COPY_PAGE_SIZE >= draft.copyPaths.length} onClick={() => setPage(page + 1)}>下一页</Button></div></details>
    {admission.gitStatus ? <details><summary className="cursor-pointer text-ui-sm">未提交的项目上下文</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-ui-sm">{admission.gitStatus}</pre></details> : null}
    {admission.checks.map(check => <label key={check.id} className="flex items-start gap-2"><input type="checkbox" checked={edit.checks.includes(check.id)} onChange={event => onChange({ ...edit, checks: event.target.checked ? [...edit.checks, check.id] : edit.checks.filter(id => id !== check.id) })} /><span className="min-w-0 break-all">{check.id}<span className="block text-ui-sm text-foreground-subtle">{check.executable} {check.args.join(' ')}<br />{check.description}</span></span></label>)}
  </fieldset>;
}
