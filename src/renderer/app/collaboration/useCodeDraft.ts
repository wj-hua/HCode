// 原会话代码草案的界面动作；未保存编辑和能力确认分开，版本及执行资格交给主进程。
import { useEffect, useRef } from "react";
import type { Conversation } from "../store/appStore";
import type { CodeDraft, CodeDraftInput, CodeDraftEdit } from "@hcode/shared/codeDraft";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { hcode } from "../bridge";
import { bindDraftSource, assertDraftSource } from "./draftSource";
import { useDraftState } from "./useDraftState";
const PORT = { list: (key?: string, nativeId?: string) => hcode.invoke("collaboration:codeDraftList", key, nativeId), subscribe: (receive: (value: CodeDraft) => void) => hcode.on("collaboration:codeDraftUpdated", receive) };
function editable(draft: CodeDraft): CodeDraftEdit {
  return { objective: draft.params.objective, tasks: draft.params.tasks, reviewer: draft.params.reviewer, checks: draft.params.checks, acceptWorkspace: draft.params.acceptWorkspace };
}
export function useCodeDraft(conversation: Conversation, input: Omit<CodeDraftInput, "initiator">, started: (run: CollaborationSnapshot, input: string) => void) {
  const { draft, edit, busy, loading, error, latest, accept, act, changed, setEdit, setError } = useDraftState(conversation, PORT, editable);
  const submittedInput = useRef(""), inputGoal = useRef(input.objective);
  useEffect(() => {
    if (inputGoal.current === input.objective) return;
    inputGoal.current = input.objective;
    if (input.objective.trim()) setEdit(current => current ? { ...current, objective: input.objective, acceptWorkspace: false } : current);
  }, [input.objective]);
  const source = () => bindDraftSource(conversation.viewId, latest.current?.params.initiator);
  const generate = () => act(async () => {
    const initiator = source(), goal = edit?.objective.trim() || input.objective.trim();
    if (!goal) throw new Error("请先在当前输入框填写代码交付目标");
    const existing = draft && ["editing", "ready", "blocked", "cancelled"].includes(draft.status);
    const value = existing ? await hcode.invoke("collaboration:codeDraftUpdate", draft.id, draft.revision, { ...editable(draft), objective: goal, acceptWorkspace: false }) : await hcode.invoke("collaboration:codeDraftCreate", { ...input, objective: goal, initiator });
    accept(value); submittedInput.current = goal;
    accept(await hcode.invoke("collaboration:codeDraftPrepare", value.id, value.revision));
  });
  const update = (value: CodeDraftEdit) => setEdit({ ...value, acceptWorkspace: false });
  const save = () => act(async () => {
    if (!draft || !edit) throw new Error("没有可保存的代码计划");
    accept(await hcode.invoke("collaboration:codeDraftUpdate", draft.id, draft.revision, edit));
  });
  const acknowledge = (accepted: boolean) => act(async () => {
    if (!draft || changed) throw new Error("请先保存分工，再核对复制范围与检查");
    accept(await hcode.invoke("collaboration:codeDraftUpdate", draft.id, draft.revision, { ...editable(draft), acceptWorkspace: accepted }));
  });
  const confirm = () => act(async () => {
    if (!draft || changed) throw new Error("请先保存并核对代码计划");
    assertDraftSource(source(), draft.params.initiator);
    started(await hcode.invoke("collaboration:codeDraftConfirm", draft.id, draft.revision), submittedInput.current);
  });
  const abandon = () => act(async () => {
    if (!draft) throw new Error("没有可放弃的代码计划");
    accept(await hcode.invoke("collaboration:codeDraftAbandon", draft.id, draft.revision));
  });
  const cancel = async () => {
    if (!draft) return;
    try { await hcode.invoke("collaboration:codeDraftCancel", draft.id); } catch (reason) { setError(String(reason)); }
  };
  return { draft, edit, busy, loading, error, changed, update, generate, save, acknowledge, confirm, abandon, cancel };
}
