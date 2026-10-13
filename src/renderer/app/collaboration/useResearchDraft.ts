// 草案动作及跨打开恢复；执行权、版本和预算由主进程验证，视图不推断成功。
import { useEffect, useRef, useState } from "react";
import type { ResearchDraft, ResearchDraftInput } from "@hcode/shared/researchDraft";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import type { Conversation } from "../store/appStore";
import { useAppStore } from "../store/appStore";
import { hcode } from "../bridge";
const STATUS_ORDER = { editing: 0, preparing: 1, ready: 2, blocked: 2, cancelled: 2, starting: 3, started: 4, abandoned: 4 } as const;

export function useResearchDraft(conversation: Conversation, input: Omit<ResearchDraftInput, "initiator">, started: (run: CollaborationSnapshot) => void) {
  const [draft, setDraft] = useState<ResearchDraft>();
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [objective, setObjective] = useState("");
  const latest = useRef<ResearchDraft | undefined>(undefined);
  const accept = (value: ResearchDraft) => {
    const previous = latest.current;
    if (previous?.id === value.id && (previous.revision > value.revision || previous.revision === value.revision && STATUS_ORDER[previous.status] > STATUS_ORDER[value.status] || JSON.stringify(previous) === JSON.stringify(value))) return;
    latest.current = value; setDraft(value); setObjective(value.params.objective);
  };
  useEffect(() => {
    let current = true;
    const dispose = hcode.on("collaboration:draftUpdated", value => {
      if (current && (value.params.initiator.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && value.params.initiator.resumeSessionId === conversation.sessionId))) accept(value);
    });
    if (conversation.sessionKey || conversation.sessionId) void hcode.invoke("collaboration:draftList", conversation.sessionKey, conversation.sessionId).then(values => {
      if (current && values[0] && values[0].status !== "abandoned" && values[0].status !== "started") accept(values[0]);
    }).catch(reason => { if (current) setError(`读取计划失败：${String(reason)}`); }).finally(() => { if (current) setLoading(false); });
    else setLoading(false);
    return () => { current = false; dispose(); };
  }, [conversation.sessionKey, conversation.sessionId]);

  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const source = () => {
    const current = useAppStore.getState().conversations[conversation.viewId];
    if (!current || current.runState === "running" || current.runState === "awaitingApproval" || current.queue.length) throw new Error("请先完成当前会话的活动回合和消息队列");
    const binding = latest.current?.params.initiator;
    const sameSource = binding && (binding.sessionKey === current.sessionKey || Boolean(current.sessionId && current.sessionId === binding.resumeSessionId));
    const sessionKey = sameSource ? binding.sessionKey : current.sessionKey ?? crypto.randomUUID();
    useAppStore.setState(state => ({ conversations: { ...state.conversations, [current.viewId]: { ...current, sessionKey } } }));
    return { agent: current.agent, projectPath: current.projectPath, permissionMode: current.permissionMode, sessionKey, ...(current.sessionId ? { resumeSessionId: current.sessionId } : {}), ...(current.model ? { model: current.model } : {}), ...(current.effort ? { effort: current.effort } : {}) };
  };
  const generate = () => act(async () => {
    const initiator = source();
    const goal = input.objective.trim() || objective.trim();
    if (!goal) throw new Error("请先填写任务目标");
    const request = { ...input, objective: goal };
    const editable = draft && !["abandoned", "started", "starting", "preparing"].includes(draft.status);
    const value = editable ? await hcode.invoke("collaboration:draftUpdate", draft.id, draft.revision, request) : await hcode.invoke("collaboration:draftCreate", { ...request, initiator });
    accept(value);
    accept(await hcode.invoke("collaboration:draftPrepare", value.id, value.revision));
  });
  const save = () => act(async () => {
    if (!draft) throw new Error("没有可编辑计划");
    accept(await hcode.invoke("collaboration:draftUpdate", draft.id, draft.revision, { ...input, objective }));
  });
  const confirm = () => act(async () => {
    if (!draft) throw new Error("没有待确认计划");
    const initiator = source();
    if (initiator.agent !== draft.params.initiator.agent || initiator.sessionKey !== draft.params.initiator.sessionKey || initiator.resumeSessionId && initiator.resumeSessionId !== draft.params.initiator.resumeSessionId || initiator.permissionMode !== draft.params.initiator.permissionMode || initiator.model !== draft.params.initiator.model) throw new Error("当前会话配置与计划已不同，请重新核对计划");
    started(await hcode.invoke("collaboration:draftConfirm", draft.id, draft.revision));
  });
  const abandon = () => act(async () => {
    if (!draft) throw new Error("没有待放弃计划");
    accept(await hcode.invoke("collaboration:draftAbandon", draft.id, draft.revision));
  });
  const cancel = async () => {
    if (!draft) return;
    try { await hcode.invoke("collaboration:draftCancel", draft.id); }
    catch (reason) { setError(String(reason)); }
  };
  const changed = Boolean(draft && (objective !== draft.params.objective || JSON.stringify(input.executor) !== JSON.stringify(draft.params.executor) || JSON.stringify(input.reviewer) !== JSON.stringify(draft.params.reviewer)));
  return { draft, busy, loading, error, objective, setObjective, changed, generate, save, confirm, abandon, cancel };
}
