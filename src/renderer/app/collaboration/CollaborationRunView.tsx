// 显示真实交付版本、独立审查与原生执行记录；不把模型通过显示成测试或代码应用成功。
import { codeCandidates, candidateSnapshot, deliveryCode } from "@hcode/shared/codeCandidates";
import { useState } from "react";
import type { CollaborationSnapshot, CollaborationTask, DeliverySnapshot } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { hcode } from "../bridge";
import { CollaborationControls } from "./CollaborationControls";
import { CodeCandidateView } from "./CodeCandidateView";
import { ExpertRunView } from "./ExpertRunView";
import { TaskTranscript } from "./TaskTranscript";

export const RUN_LABELS: Record<CollaborationSnapshot["status"], string> = { running: "协作进行中", stopping: "等待原生停止确认", paused: "已暂停，可人工接管", awaitingUser: "等待人工处理", completed: "交付已审查并汇总", failed: "协作失败", cancelled: "协作已停止", interrupted: "执行已中断" };
const STAGES: Record<CollaborationSnapshot["stage"], string> = { planning: "当前 AI 拆解与委派", awaitingWorkers: "执行、审查与修订", expertResearch: "专家独立研究", peerReview: "专家交叉审查", synthesis: "当前 AI 汇总", finished: "已结束" };
const DELIVERY_LABELS: Record<DeliverySnapshot["status"], string> = { queued: "排队", executing: "执行", reviewing: "审查", revising: "修订", accepted: "交付已接受", failed: "失败", awaitingUser: "待人工处理", cancelled: "已停止", interrupted: "已中断" };
const TASK_LABELS: Record<CollaborationTask["role"], string> = { planning: "委派", execution: "执行 / 修订", review: "独立审查", synthesis: "汇总" };
const OUTCOMES: Record<CollaborationTask["status"], string> = { running: "运行中", succeeded: "回合完成", failed: "失败", cancelled: "已停止", interrupted: "已中断" };

export function CollaborationRunView({ run }: { run: CollaborationSnapshot }) {
  return run.experts ? <ExpertRunView run={run} /> : <DelegationRunView run={run} />;
}
function DelegationRunView({ run }: { run: CollaborationSnapshot }) {
  const [taskId, setTaskId] = useState<string>();
  const [report, setReport] = useState("");
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const candidates=codeCandidates(run);
  const selectedTask = run.tasks.find((task) => task.id === taskId);
  const readVersion = async (versionId: string) => {
    setReading(true); setError(""); setReport(""); setTaskId(undefined);
    try { setReport((await hcode.invoke("collaboration:artifact", run.id, versionId)).markdown); }
    catch (reason) { setError(String(reason)); }
    finally { setReading(false); }
  };
  return <div className="flex flex-col gap-4">
    <div aria-live="polite" className="rounded-lg border border-border bg-surface p-3">
      <p className="font-medium">{RUN_LABELS[run.status]} · {STAGES[run.stage]}</p>
      <p className="mt-1 whitespace-pre-wrap text-foreground-subtle">{run.params.objective}</p>
      <p className="mt-2 text-ui-sm text-foreground-subtle">{run.code ? run.code.adoption?.status === "applied" ? "隔离代码交付 · 所选候选已应用到原项目" : run.code.adoption && ["prepared", "applying", "needsRecovery"].includes(run.code.adoption.status) ? "代码采纳未完成 · 请核对恢复记录" : "隔离代码候选 · 实际检查与独立审查 · 待采纳，原项目未应用" : candidates.length ? `并行代码任务 · ${candidates.length} 个独立副本 · 逐任务验证、审查和采纳` : "只读报告 · 最多两次修订 · 没有运行测试"}</p>
    </div>
    <CollaborationControls run={run} />
    {run.code ? <CodeCandidateView run={run} /> : null}
    {run.error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{run.error}</p> : null}
    {run.persistenceError ? <p role="alert" className="text-destructive">记录保存失败：{run.persistenceError}。当前状态尚未持久化。</p> : null}
    {run.deliveries.length === 0 ? <p className="text-foreground-subtle">尚未创建子任务。</p> : run.deliveries.map((delivery) => <div key={delivery.id} className="rounded-lg border border-border p-3">
      <p className="font-medium">{DELIVERY_LABELS[delivery.status]} · {AGENTS[delivery.executor.agent].name}</p>
      <p className="mt-1 whitespace-pre-wrap">{delivery.objective}</p>
      <div className="mt-2 flex flex-wrap gap-2">{delivery.versions.map((version) => <Button key={version.id} variant="outline" disabled={reading} onClick={() => void readVersion(version.id)}>报告 v{version.version}</Button>)}</div>
      {delivery.code ? <div className="mt-3"><p className="text-ui-sm text-foreground-subtle">允许修改：{delivery.code.allowedPaths?.join('、')}</p><CodeCandidateView run={candidateSnapshot(run,{deliveryId:delivery.id,code:delivery.code})} deliveryId={delivery.id} /></div> : null}
      {delivery.error ? <p className="mt-2 whitespace-pre-wrap text-destructive">{delivery.error}</p> : null}
      {delivery.reviews.map((review) => <details key={`${review.versionId}-${review.reviewer?.sessionKey ?? delivery.reviews.indexOf(review)}`} className="mt-2" open={review.verdict !== "approved"}>
        <summary className="cursor-pointer">v{delivery.versions.find((version) => version.id === review.versionId)?.version} 审查：{review.verdict === "approved" ? "通过" : review.verdict === "changesRequested" ? "需要修订" : "无法判定"}</summary>
        <p className="mt-1 whitespace-pre-wrap text-foreground-subtle">{review.reviewer ? `审查者：${AGENTS[review.reviewer.agent].name}（独立会话） · ` : "旧记录未包含审查者身份 · "}{review.summary}</p>
        {review.issues.map((issue) => <div key={issue.id} className="mt-2 border-l-2 border-border pl-3">
          <p className="font-medium">{issue.id} · {issue.blocking ? "阻塞" : "建议"} · {issue.location}</p>
          <p className="whitespace-pre-wrap">{issue.reason}</p><p className="whitespace-pre-wrap text-foreground-subtle">证据：{issue.evidence}</p><p className="whitespace-pre-wrap">修订建议：{issue.suggestion}</p>
        </div>)}
      </details>)}
    </div>)}
    <div><p className="mb-2 font-medium">原生会话记录（含修订回合）</p><div className="flex flex-wrap gap-2">{run.tasks.map((task, index) => <Button key={task.id} variant={task.id === taskId ? "secondary" : "outline"} onClick={() => { setTaskId(task.id); setReport(""); }}>{index + 1}. {AGENTS[task.agent].name} · {run.approvedPlan && task.role === "planning" ? "计划生成" : TASK_LABELS[task.role]} · {OUTCOMES[task.status]}</Button>)}</div></div>
    {selectedTask ? <div className="rounded-lg border border-border p-3">{selectedTask.error ? <p className="mb-3 whitespace-pre-wrap text-destructive">{selectedTask.error}</p> : null}<TaskTranscript key={selectedTask.id} task={selectedTask} projectPath={selectedTask.deliveryId ? deliveryCode(run,run.deliveries.find(delivery=>delivery.id===selectedTask.deliveryId)!)?.workspace.path ?? run.params.initiator.projectPath : run.params.initiator.projectPath} /></div> : null}
    {reading ? <p role="status">正在读取报告…</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {report ? <div className="rounded-lg border border-border p-3"><MessageResponse>{report}</MessageResponse></div> : null}
    {run.summary ? <details open><summary className="cursor-pointer font-medium">当前 AI 的最终汇总{candidates.some(entry=>entry.code.adoption) ? "（采纳前）" : ""}</summary><div className="mt-3"><MessageResponse>{run.summary}</MessageResponse></div></details> : null}
  </div>;
}
