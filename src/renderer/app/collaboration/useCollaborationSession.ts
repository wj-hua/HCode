// 当前原生会话的记录订阅与能力查询；只读查询不启动模型，运行状态来自主进程快照。
import { useEffect, useMemo, useState } from "react";
import type { CollaborationCapabilities, CollaborationSnapshot } from "@hcode/shared/collaboration";
import type { Conversation } from "../store/appStore";
import { hcode } from "../bridge";
import { subscribeCollaboration, useCollaborationStore } from "./collaborationStore";

function belongsToConversation(run: CollaborationSnapshot, conversation: Conversation) {
  if (run.params.initiator.agent !== conversation.agent || run.params.initiator.projectPath !== conversation.projectPath) return false;
  return run.params.initiator.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && (run.params.initiator.resumeSessionId === conversation.sessionId || run.tasks.some((task) => task.role === "planning" && task.nativeSessionId === conversation.sessionId)));
}

export function useActiveCollaboration(conversation: Conversation) {
  return useCollaborationStore((state) => Object.values(state.runs).find((run) => ["running", "stopping"].includes(run.status) && belongsToConversation(run, conversation)));
}

export function useCollaborationSession(conversation: Conversation, open: boolean) {
  const [checkingCapabilities, setCheckingCapabilities] = useState(false);
  const [capabilities, setCapabilities] = useState<CollaborationCapabilities[]>();
  const [recordError, setRecordError] = useState("");
  const [capabilityError, setCapabilityError] = useState("");
  const allRuns = useCollaborationStore(state => state.runs);
  const runs = useMemo(() => Object.values(allRuns).filter(run => belongsToConversation(run, conversation)).sort((left, right) => right.createdAt - left.createdAt), [allRuns, conversation.sessionKey, conversation.sessionId, conversation.agent, conversation.projectPath]);
  const active = useActiveCollaboration(conversation);
  const sourceBusy = conversation.runState === "running" || conversation.runState === "awaitingApproval" || conversation.queue.length > 0;
  const sourceCapability = capabilities?.find(entry => entry.agent === conversation.agent);
  useEffect(subscribeCollaboration, []);
  useEffect(() => {
    if (!conversation.sessionKey && !conversation.sessionId) return;
    let current = true;
    setRecordError("");
    // 历史会话尚无活动 key；查询使用临时 UUID，凭原生 sessionId 找回之前的协作。
    void hcode.invoke("collaboration:list", conversation.sessionKey ?? crypto.randomUUID(), conversation.sessionId).then(
      (saved) => { if (current) saved.forEach(useCollaborationStore.getState().accept); },
      (reason) => { if (current) setRecordError(`读取协作记录失败：${String(reason)}`); },
    );
    return () => { current = false; };
  }, [conversation.sessionKey, conversation.sessionId, open]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCheckingCapabilities(true); setCapabilityError("");
    void hcode.invoke("collaboration:capabilities", { agent: conversation.agent, ...(conversation.sessionId ? { resumeSessionId: conversation.sessionId } : {}) }).then(
      (result) => { if (current) { setCapabilities(result); setCheckingCapabilities(false); } },
      (reason) => { if (current) { setCapabilityError(`检查协作能力失败：${String(reason)}`); setCapabilities(undefined); setCheckingCapabilities(false); } },
    );
    return () => { current = false; };
  }, [open, conversation.agent, conversation.sessionId]);

  return { runs, active, capabilities, checkingCapabilities, sourceCapability, sourceBusy, error: [recordError, capabilityError].filter(Boolean).join("\n") };
}
