// 启动前展示实际复制范围与检查脚本；用户确认构成宿主检查计划，不接受模型 shell。
import { useEffect, useState } from 'react';
import type { CodeAdmission, CodeStartOptions, ValidationCheckId } from '@hcode/shared/codeDelivery';
import { hcode } from '../bridge';
export function CodeValidationPlan({ path, onChange }: { path: string; onChange(value: CodeStartOptions | undefined): void }) {
  const [admission, setAdmission] = useState<CodeAdmission>();
  const [checks, setChecks] = useState<ValidationCheckId[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true; onChange(undefined);
    void hcode.invoke('collaboration:codeAdmission', path).then((value) => { if (active) { setAdmission(value); setChecks(value.checks.map((entry) => entry.id)); } }, (reason) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [path]);
  const update = (selected: ValidationCheckId[], accepted: boolean) => { setChecks(selected); setConfirmed(accepted); onChange(admission && selected.length && accepted ? { admissionHash: admission.hash, checks: selected } : undefined); };
  if (error) return <p role="alert" className="whitespace-pre-wrap text-destructive">工作区准入失败：{error}</p>;
  if (!admission) return <p role="status">正在核对项目文件、依赖链接和检查脚本…</p>;
  return <fieldset className="flex flex-col gap-2 rounded-md border border-border p-3">
    <legend className="px-1 font-medium">确认独立副本与验证计划</legend>
    <p className="text-ui-sm text-foreground-subtle">完整复制当前文件（含未提交、未跟踪及 ignored 依赖，不含 .git）：{admission.fileCount.toLocaleString()} 个文件 · {(admission.bytes / 1024 ** 2).toFixed(1)} MiB。网络关闭、无凭证环境；缺依赖时阻止交付。检查产生文件变化会使当前版本证据失效。</p>
    {admission.gitStatus ? <details><summary className="cursor-pointer">当前未提交上下文</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-ui-sm">{admission.gitStatus}</pre></details> : <p className="text-ui-sm">Git 工作区干净</p>}
    {admission.checks.map((check) => <label key={check.id} className="flex items-start gap-2"><input type="checkbox" checked={checks.includes(check.id)} onChange={(event) => update(event.target.checked ? [...checks, check.id] : checks.filter((id) => id !== check.id), false)} /><span className="min-w-0 break-all">{check.executable} {check.args.join(' ')}<span className="block text-ui-sm text-foreground-subtle">{check.description}</span></span></label>)}
    <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => update(checks, event.target.checked)} /><span>确认复制以上上下文，并自动运行勾选的检查。原项目保持不变，最终变更待采纳。</span></label>
  </fieldset>;
}
