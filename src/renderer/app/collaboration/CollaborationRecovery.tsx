// 全局损坏记录单列；恢复操作保留原日志备份，不触发任何模型回合。
import { useEffect, useState } from "react";
import type { RecoveryIssue } from "@hcode/shared/collaboration";
import { Button } from "@/components/ui/button.js";
import { hcode } from "../bridge";
import { useCollaborationStore } from "./collaborationStore";

export function CollaborationRecovery() {
  const [issues, setIssues] = useState<RecoveryIssue[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void hcode.invoke("collaboration:recoveryIssues").then((result) => { if (current) setIssues(result); }, (reason) => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, []);
  const repair = async (id: string) => {
    setBusy(true); setError("");
    try {
      useCollaborationStore.getState().accept(await hcode.invoke("collaboration:repair", id));
      setIssues(await hcode.invoke("collaboration:recoveryIssues"));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <>
    {issues.length ? <details open className="mb-3 rounded-lg border border-destructive p-3"><summary>协作记录恢复异常（全局）</summary>{issues.map((issue) => <div key={issue.runId} className="mt-3">
      <p className="break-all">{issue.runId}</p><p role="alert" className="whitespace-pre-wrap text-destructive">{issue.error}</p>
      {issue.canRepairTail ? <Button variant="outline" className="mt-2" disabled={busy} onClick={() => void repair(issue.runId)}>备份日志并截去半截尾行</Button> : <p>中间损坏或完整尾行需要人工核对，未自动修改。</p>}
    </div>)}</details> : null}
    {error ? <p role="alert" className="text-destructive">读取 / 恢复记录失败：{error}</p> : null}
  </>;
}
