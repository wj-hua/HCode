// 专家报告、互审和主持汇总分层展示；每个汇总引用可打开对应冻结版本核对。
import { useUiStore } from "../store/uiStore";
import { ExpertReportPreview } from "./ExpertReportPreview";
import { useExpertReport } from "./useExpertReport";
import { TASK_RESULT_LABELS } from "@hcode/shared/collaborationPresentation";
import { useRef, useState } from "react";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { CollaborationControls } from "./CollaborationControls";
import { ExpertRecoveryControls } from "./ExpertRecoveryControls";
import { hasRepeatedExpertBackend } from "./expertPresentation";
import { ExpertParticipantsSection } from "./ExpertParticipantsSection";
import { ExpertSummaryView } from "./ExpertSummaryView";
import { TaskTranscript } from "./TaskTranscript";
import { TaskObjective } from "./TaskObjective";
const RUN_STATUSES = {
  running: "运行中",
  stopping: "等待停止确认",
  paused: "已暂停",
  awaitingUser: "等待人工处理",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  interrupted: "已中断",
};
const STAGES = {
  planning: "当前会话确认目标",
  expertResearch: "专家独立研究",
  peerReview: "专家交叉审查",
  synthesis: "当前会话汇总",
  finished: "专家流程已结束",
  awaitingWorkers: "等待专家",
};
function ExpertRunHeader({ run }: { run: CollaborationSnapshot }) {
  const state = run.experts!;
  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-border bg-surface p-3"
    >
      <p className="font-medium">
        {run.status === "completed"
          ? "专家互审与汇总已完成"
          : STAGES[run.stage]}{" "}
        · {RUN_STATUSES[run.status]}
      </p>
      <p className="mt-1 text-ui-sm text-foreground-subtle">{run.status === 'completed' ? '本次评审：源码只读核对，未联网、未运行测试' : '只读研究 · 未联网 · 未运行测试'}</p>
      {run.status === 'completed' ? <p className="mt-2 text-ui-sm">评审已结束，原会话可按最新请求继续；报告保留为参考。</p> : null}
      <details className="mt-2 text-ui-sm">
        <summary className="cursor-pointer text-foreground-subtle">评审目标与流程</summary>
        <TaskObjective objective={run.params.objective} />
      <p className="mt-2 text-ui-sm text-foreground-subtle">
        首轮独立报告 →{" "}
        {state.participants.some(expert=>expert.profile) ? "相关角色交叉审查" : state.activeIds.length === 2 ? "双方互审" : "三方环形互审"} →{" "}
        {AGENTS[run.params.initiator.agent].name}{" "}
        原会话汇总。
      </p>
      </details>
      {state.partialAuthorized ? (
        <p className="mt-2 text-ui-sm">
          用户已选择排除失败专家，以下为部分参与结果。
        </p>
      ) : null}
    </div>
  );
}
export function ExpertRunView({ run }: { run: CollaborationSnapshot }) {
  const [taskId, setTaskId] = useState<string>();
  const panel = useUiStore(state => state.sidePanel);
  const citation = panel?.type === "collaboration" && panel.runId === run.id ? panel.citation : undefined;
  const { report, claimId, reportLabel, reading, error, openReport, clearReport } = useExpertReport(run.id, citation);
  const returnFocus = useRef<HTMLElement | null>(null);
  /** 在加载状态禁用入口前记住触发控件，弹窗关闭时精确返回原位置。 */
  const openPreview = (versionId: string, name: string, claim?: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return openReport(versionId, name, claim);
  };
  const state = run.experts!,
    task = run.tasks.find((entry) => entry.id === taskId);
  return (
    <div className="flex flex-col gap-4">
      <ExpertRunHeader run={run} />
      {hasRepeatedExpertBackend(state.participants) ? (
        <p className="text-ui-sm">
          部分专家使用相同后端和模型，代表不同角色视角，不能算独立模型来源。
        </p>
      ) : null}
      <ExpertParticipantsSection state={state} reading={reading} openReport={openPreview} />
      <CollaborationControls run={run} />
      <ExpertRecoveryControls run={run} />
      {run.error ? <p role="alert" className="whitespace-pre-wrap text-destructive">{run.error}</p> : null}
      {run.persistenceError ? <p role="alert" className="text-destructive">记录保存失败：{run.persistenceError}</p> : null}
      <ExpertSummaryView state={state} reading={reading} openReport={openPreview} />
      <ExpertReportPreview report={report} claimId={claimId} reportLabel={reportLabel} reading={reading} error={error} returnFocus={returnFocus} onClose={clearReport} />
      <details>
        <summary className="cursor-pointer font-medium">
          原生回合记录（{run.tasks.length}）
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {run.tasks.map((entry, index) => (
            <Button
              key={entry.id}
              variant="outline"
              onClick={() => setTaskId(entry.id)}
            >
              {index + 1}. {AGENTS[entry.agent].name} ·{" "}
              {entry.role === "execution"
                ? "研究"
                : entry.role === "review"
                  ? "互审"
                  : entry.role === "planning"
                    ? run.approvedPlan ? "团队推荐" : "主持"
                    : "汇总"}{" "}
              · {TASK_RESULT_LABELS[entry.status]}
            </Button>
          ))}
        </div>
        {task ? (
          <TaskTranscript
            key={task.id}
            task={task}
            projectPath={run.params.initiator.projectPath}
          />
        ) : null}
      </details>
    </div>
  );
}
