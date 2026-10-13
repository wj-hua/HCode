// 原会话专家草案的界面动作；未保存编辑和能力确认分开，版本及执行资格交给主进程。
import { useEffect, useRef } from "react";
import type { Conversation } from "../store/appStore";
import type { ExpertDraft, ExpertDraftInput, ExpertDraftEdit } from "@hcode/shared/expertDraft";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { hcode } from "../bridge";
import { bindDraftSource, assertDraftSource } from "./draftSource";
import { useDraftState } from "./useDraftState";
const PORT = { list: (key?: string, nativeId?: string) => hcode.invoke("collaboration:expertDraftList", key, nativeId), subscribe: (receive: (value: ExpertDraft) => void) => hcode.on("collaboration:expertDraftUpdated", receive) };
function editable(draft: ExpertDraft): ExpertDraftEdit {
  return { objective: draft.params.objective, experts: draft.params.experts, turnLimit: draft.params.turnLimit, acceptProfileLimitations: draft.params.acceptProfileLimitations };
}
export function useExpertDraft(conversation: Conversation, input: Omit<ExpertDraftInput, "initiator">, started: (run: CollaborationSnapshot, input: string) => void) {
  const { draft, edit, busy, loading, error, latest, accept, act, changed, setEdit, setError } = useDraftState(conversation, PORT, editable);
  const submittedInput = useRef(""), inputGoal = useRef(input.objective);
  useEffect(() => {
    if (inputGoal.current === input.objective) return;
    inputGoal.current = input.objective;
    if (input.objective.trim()) setEdit(current => current ? { ...current, objective: input.objective, acceptProfileLimitations: false } : current);
  }, [input.objective]);
  const source = () => bindDraftSource(conversation.viewId, latest.current?.params.initiator);
  const generate = () => act(async () => {
    const initiator = source(), goal = edit?.objective.trim() || input.objective.trim();
    if (!goal) throw new Error("请先在当前输入框填写评审目标");
    const existing = draft && ["editing", "ready", "blocked", "cancelled"].includes(draft.status);
    const value = existing ? await hcode.invoke("collaboration:expertDraftUpdate", draft.id, draft.revision, { ...editable(draft), objective: goal, acceptProfileLimitations: false }) : await hcode.invoke("collaboration:expertDraftCreate", { ...input, objective: goal, initiator });
    accept(value); submittedInput.current = goal;
    accept(await hcode.invoke("collaboration:expertDraftPrepare", value.id, value.revision));
  });
  const update = (value: ExpertDraftEdit) => setEdit({ ...value, acceptProfileLimitations: false });
  const save = () => act(async () => {
    if (!draft || !edit) throw new Error("没有可保存的专家计划");
    accept(await hcode.invoke("collaboration:expertDraftUpdate", draft.id, draft.revision, edit));
  });
  const acknowledge = (accepted: boolean) => act(async () => {
    if (!draft || changed) throw new Error("请先保存分工，再核对能力限制");
    accept(await hcode.invoke("collaboration:expertDraftUpdate", draft.id, draft.revision, { ...editable(draft), acceptProfileLimitations: accepted }));
  });
  const confirm = () => act(async () => {
    if (!draft || changed) throw new Error("请先保存并核对专家计划");
    assertDraftSource(source(), draft.params.initiator);
    started(await hcode.invoke("collaboration:expertDraftConfirm", draft.id, draft.revision), submittedInput.current);
  });
  const abandon = () => act(async () => {
    if (!draft) throw new Error("没有可放弃的专家计划");
    accept(await hcode.invoke("collaboration:expertDraftAbandon", draft.id, draft.revision));
  });
  const cancel = async () => {
    if (!draft) return;
    try { await hcode.invoke("collaboration:expertDraftCancel", draft.id); } catch (reason) { setError(String(reason)); }
  };
  return { draft, edit, busy, loading, error, changed, update, generate, save, acknowledge, confirm, abandon, cancel };
}
