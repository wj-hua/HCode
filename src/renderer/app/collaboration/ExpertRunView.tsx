// 专家报告、互审和主持汇总分层展示；每个汇总引用可打开对应冻结版本核对。
import { useEffect, useRef, useState } from "react";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { hcode } from "../bridge";
import { CollaborationControls } from "./CollaborationControls";
import { ExpertRecoveryControls } from "./ExpertRecoveryControls";
import { hasRepeatedExpertBackend } from "./expertPresentation";
import { ExpertParticipantView } from "./ExpertParticipantView";
import { ExpertSummaryView } from "./ExpertSummaryView";
import { TaskTranscript } from "./TaskTranscript";
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
      <p className="mt-1 whitespace-pre-wrap">{run.params.objective}</p>
      <p className="mt-2 text-ui-sm text-foreground-subtle">
        首轮独立报告 →{" "}
        {state.participants.some(expert=>expert.profile) ? "相关角色交叉审查" : state.activeIds.length === 2 ? "双方互审" : "三方环形互审"} →{" "}
        {AGENTS[run.params.initiator.agent].name}{" "}
        原会话汇总。只读源码，未联网、未运行测试。
      </p>
      {state.partialAuthorized ? (
        <p className="mt-2 text-ui-sm">
          用户已选择排除失败专家，以下为部分参与结果。
        </p>
      ) : null}
    </div>
  );
}
export function ExpertRunView({ run }: { run: CollaborationSnapshot }) {
  const [report, setReport] = useState(""),
    [reportLabel, setReportLabel] = useState(""),
    [reading, setReading] = useState(false),
    [error, setError] = useState(""),
    [taskId, setTaskId] = useState<string>();
  const reportView = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!report) return;
    reportView.current?.focus();
    reportView.current?.scrollIntoView({ block: "start" });
  }, [report]);
  const state = run.experts!,
    task = run.tasks.find((entry) => entry.id === taskId);
  const openReport = async (versionId: string, name: string) => {
    setReading(true);
    setError("");
    setReport("");
    setReportLabel(name);
    try {
      setReport(
        (await hcode.invoke("collaboration:artifact", run.id, versionId))
          .markdown,
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setReading(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <ExpertRunHeader run={run} />
      {hasRepeatedExpertBackend(state.participants) ? (
        <p className="text-ui-sm">
          部分专家使用相同后端和模型，代表不同角色视角，不能算独立模型来源。
        </p>
      ) : null}
      <CollaborationControls run={run} />
      <ExpertRecoveryControls run={run} />
      {run.error ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {run.error}
        </p>
      ) : null}
      {run.persistenceError ? (
        <p role="alert" className="text-destructive">
          记录保存失败：{run.persistenceError}
        </p>
      ) : null}
      {state.participants.map((expert) => (
        <ExpertParticipantView
          key={expert.id}
          expert={expert}
          state={state}
          reading={reading}
          openReport={openReport}
        />
      ))}
      <ExpertSummaryView
        state={state}
        reading={reading}
        openReport={openReport}
      />
      {reading ? <p role="status">正在读取冻结报告…</p> : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {report ? (
        <details
          ref={reportView}
          tabIndex={-1}
          open
          className="rounded-lg border border-border p-3"
        >
          <summary className="cursor-pointer font-medium">
            {reportLabel}
          </summary>
          <MessageResponse>{report}</MessageResponse>
        </details>
      ) : null}
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
                    ? "主持"
                    : "汇总"}{" "}
              · {entry.status}
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
