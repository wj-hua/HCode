// 子任务沿用原生时间线；活动回合展示流式行，历史回合从所属 Provider 读取。
import { useEffect, useState } from "react";
import type { CollaborationTask } from "@hcode/shared/collaboration";
import type { ConversationRow } from "@hcode/shared/types";
import { hcode } from "../bridge";
import { Timeline } from "../conversation/Timeline";
import { useCollaborationStore } from "./collaborationStore";

export function TaskTranscript({ task, projectPath }: { task: CollaborationTask; projectPath: string }) {
  const live = useCollaborationStore((state) => state.rows[task.sessionKey]);
  const [history, setHistory] = useState<ConversationRow[] | undefined>();
  const [error, setError] = useState("");
  useEffect(() => {
    setHistory(undefined); setError("");
    if (!task.nativeSessionId || task.status === "running") return;
    let active = true;
    void hcode.invoke("sessions:load", { agent: task.agent, id: task.nativeSessionId, projectPath }).then(
      (result) => { if (active) setHistory(result.rows); },
      (reason) => { if (active) setError(String(reason)); },
    );
    return () => { active = false; };
  }, [task.sessionKey, task.nativeSessionId, task.status, projectPath]);
  const rows = task.status === "running" ? live : history ?? live;
  if (error) return <p role="alert" className="text-destructive">读取执行记录失败：{error}</p>;
  if (!rows) return <p className="text-foreground-subtle">{task.status === "running" ? "等待原生执行事件…" : task.nativeSessionId ? "正在读取原生记录…" : "未建立原生会话；请查看任务错误。"}</p>;
  if (!rows.length) return <p className="text-foreground-subtle">原生会话尚无消息记录。</p>;
  return <Timeline rows={rows} workspacePath={projectPath} permissions={{}} running={task.status === "running"} canFork={false} canResend={false} highlightedRowId={null} />;
}
