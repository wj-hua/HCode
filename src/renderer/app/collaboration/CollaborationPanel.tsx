// 当前会话的协作入口；沿用已有会话身份，首次启动先绑定 key，防止原生行事件丢失。
import { DEFAULT_WRITE_TASKS, ParallelCodeSetup, writeTasksReady } from "./ParallelCodeSetup";
import { ResearchDraftPanel } from "./ResearchDraftPanel";
import type { CodeWriteTask } from "@hcode/shared/codeDelivery";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeStartOptions } from "@hcode/shared/codeDelivery";
import { CodeValidationPlan } from "./CodeValidationPlan";
import { ExpertSetup, DEFAULT_EXPERTS } from "./ExpertSetup";
import {EXPERT_LIMITS,expertMinimumTurns} from "@hcode/shared/experts";
import {useExpertProfiles} from "./useExpertProfiles";
import type { ExpertSelection } from "@hcode/shared/experts";
import { NetworkIcon } from "lucide-react";
import type { CollaborationCapabilities, CollaborationSnapshot, CollaborationWorkerAgent } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { hcode } from "../bridge";
import { useAppStore, type Conversation } from "../store/appStore";
import { subscribeCollaboration, useCollaborationStore } from "./collaborationStore";
import { CollaborationRecovery } from "./CollaborationRecovery";
import { CollaborationRunView, RUN_LABELS } from "./CollaborationRunView";

function belongsToConversation(run: CollaborationSnapshot, conversation: Conversation) {
  return run.params.initiator.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && (run.params.initiator.resumeSessionId === conversation.sessionId || run.tasks.some((task) => task.role === "planning" && task.nativeSessionId === conversation.sessionId)));
}

export function useActiveCollaboration(conversation: Conversation) {
  return useCollaborationStore((state) => Object.values(state.runs).find((run) => ["running", "stopping"].includes(run.status) && belongsToConversation(run, conversation)));
}

export function CollaborationPanel({ conversation }: { conversation: Conversation }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState<"research" | "code" | "experts">("research");
  const [experts, setExperts] = useState<ExpertSelection[]>(DEFAULT_EXPERTS);
  const [expertTurnLimit,setExpertTurnLimit]=useState<number>(EXPERT_LIMITS.defaultProfileTurns);
  const profiles=useExpertProfiles(conversation.projectPath,open&&mode==="experts");
  const [parallel,setParallel]=useState(false);
  const [writeTasks,setWriteTasks]=useState<CodeWriteTask[]>(DEFAULT_WRITE_TASKS);
  const [codeOptions, setCodeOptions] = useState<CodeStartOptions>();
  const [executor, setExecutor] = useState<CollaborationWorkerAgent>(conversation.agent === "codex" ? "claude" : "codex");
  const [executorModel, setExecutorModel] = useState("");
  const [reviewer, setReviewer] = useState<"default" | CollaborationWorkerAgent>("default");
  const [reviewerModel, setReviewerModel] = useState("");
  const [capabilities, setCapabilities] = useState<CollaborationCapabilities[]>();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const allRuns = useCollaborationStore((state) => state.runs);
  const runs = useMemo(() => Object.values(allRuns).filter((run) => belongsToConversation(run, conversation)).sort((left, right) => right.createdAt - left.createdAt), [allRuns, conversation.sessionKey, conversation.sessionId]);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  const active = useActiveCollaboration(conversation);
  const sourceBusy = conversation.runState === "running" || conversation.runState === "awaitingApproval" || conversation.queue.length > 0;
  const sourceCapability = capabilities?.find((entry) => entry.agent === conversation.agent);
  useEffect(() => { setExecutor(conversation.agent === "codex" ? "claude" : "codex"); }, [conversation.agent]);

  useEffect(subscribeCollaboration, []);
  useEffect(() => {
    if (!conversation.sessionKey && !conversation.sessionId) return;
    let current = true;
    // 历史会话尚无活动 key；查询使用临时 UUID，凭原生 sessionId 找回之前的协作。
    void hcode.invoke("collaboration:list", conversation.sessionKey ?? crypto.randomUUID(), conversation.sessionId).then(
      (saved) => { if (current) saved.forEach(useCollaborationStore.getState().accept); },
      (reason) => { if (current) setError(`读取协作记录失败：${String(reason)}`); },
    );
    return () => { current = false; };
  }, [conversation.sessionKey, conversation.sessionId]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setCapabilities(undefined);
    void hcode.invoke("collaboration:capabilities", { agent: conversation.agent, ...(conversation.sessionId ? { resumeSessionId: conversation.sessionId } : {}) }).then(
      (result) => { if (current) setCapabilities(result); },
      (reason) => { if (current) setError(`检查协作能力失败：${String(reason)}`); },
    );
    return () => { current = false; };
  }, [open, conversation.agent, conversation.sessionId]);

  const expertsReady = profiles.accepted && expertTurnLimit>=expertMinimumTurns(experts.length) && expertTurnLimit<=EXPERT_LIMITS.maxTurns && experts.length >= EXPERT_LIMITS.minParticipants && experts.length<=EXPERT_LIMITS.maxParticipants && experts.every(expert => { const capability = capabilities?.find(entry => entry.agent === expert.backend.agent); return profiles.profiles?.some(profile=>profile.role===expert.role&&!profile.issues.length) && capability?.canExecute && capability.canReview && (expert.backend.agent !== "agy" || capability.models?.some(model => model.value === expert.backend.model)); });
  const start = async () => {
    setStarting(true); setError("");
    try {
      const current = useAppStore.getState().conversations[conversation.viewId];
      if (!current || !sourceCapability?.canInitiate || current.runState === "running" || current.runState === "awaitingApproval" || current.queue.length) throw new Error("请先完成当前回合，并确认当前线程具备委派工具");
      if (mode === "code" && !codeOptions) throw new Error("请先确认工作区与验证计划");
      if(mode==='code'&&parallel&&!writeTasksReady(writeTasks,capabilities))throw new Error('请完成两项写任务配置与文件范围');
      const sessionKey = current.sessionKey ?? crypto.randomUUID();
      useAppStore.setState((state) => ({ conversations: { ...state.conversations, [current.viewId]: { ...current, sessionKey } } }));
      const initiator = { agent: current.agent, sessionKey, projectPath: current.projectPath, permissionMode: current.permissionMode, ...(current.sessionId ? { resumeSessionId: current.sessionId } : {}), ...(current.model ? { model: current.model } : {}), ...(current.effort ? { effort: current.effort } : {}) };
      const run = mode === "experts" ? await hcode.invoke("collaboration:startExperts", { mode: "experts", initiator, objective, experts:experts.map(expert=>({...expert,profileHash:profiles.profiles?.find(profile=>profile.role===expert.role)?.hash})), turnLimit:expertTurnLimit,acceptProfileLimitations:profiles.accepted }) : await hcode.invoke("collaboration:start", { initiator, executor: mode === "code" && parallel ? writeTasks[0]!.executor : { agent: executor, ...(executor === "agy" ? { model: executorModel } : useAppStore.getState().settings.defaultModels[executor] ? { model: useAppStore.getState().settings.defaultModels[executor] } : {}) }, ...(reviewer !== "default" ? { reviewer: { agent: reviewer, ...(reviewer === "agy" ? { model: reviewerModel } : useAppStore.getState().settings.defaultModels[reviewer] ? { model: useAppStore.getState().settings.defaultModels[reviewer] } : {}) } } : {}), objective, ...(mode === "code" ? { code: {...codeOptions!,...(parallel?{tasks:writeTasks.map(task=>({...task,objective:task.objective.trim(),allowedPaths:task.allowedPaths.map(path=>path.trim()),executor:{...task.executor,...(useAppStore.getState().settings.defaultModels[task.executor.agent]?{model:useAppStore.getState().settings.defaultModels[task.executor.agent]}:{})}}))}:{})} } : {}) });
      useCollaborationStore.getState().accept(run); setSelectedId(run.id); setObjective("");
    } catch (reason) { setError(String(reason)); }
    finally { setStarting(false); }
  };

  return <>
    <div className="mb-2 flex items-center gap-2 text-ui-sm">
      <Button ref={trigger} variant="outline" onClick={() => setOpen(true)}><NetworkIcon />{active ? RUN_LABELS[active.status] : "多 AI 协作"}</Button>
      <span className="text-foreground-subtle">{active ? "委派期间由协作调度当前会话" : "委派 · 自动审查 · 专家互审"}</span>
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }} className="flex max-h-[85vh] max-w-4xl flex-col gap-3">
        <DialogHeader><DialogTitle>多 AI 协作</DialogTitle><DialogDescription>当前会话的 AI 负责委派与汇总，其他会话执行和独立审查。支持只读调研、专家独立研究与互审，以及独立副本的并行代码交付。</DialogDescription></DialogHeader>
        <div className="min-h-0 overflow-y-auto pr-1">
          {error ? <p role="alert" className="mb-3 whitespace-pre-wrap text-destructive">{error}</p> : null}
          <CollaborationRecovery />
          {active ? <p role="status" className="mb-3 text-foreground-subtle">{active.status === "stopping" ? "等待原生中断确认，尚未暂停或停止" : "关闭此窗口后协作会继续；下方可暂停接管或停止"}</p> : <form onSubmit={(event) => { event.preventDefault(); if (mode !== "research") void start(); }} className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-3">
            <p className="text-foreground-subtle">发起者：{AGENTS[conversation.agent].name}（当前会话）</p>
            {!sourceCapability?.canInitiate ? <p role="status">{sourceCapability?.reason ?? "正在检查当前线程的委派能力…"}</p> : <>
              <label className="flex items-center gap-3">任务类型<select value={mode} onChange={(event) => { setMode(event.target.value as "research" | "code" | "experts"); setCodeOptions(undefined); }} className="rounded-md border border-border bg-background p-1"><option value="research">只读调研</option><option value="code">隔离代码交付</option><option value="experts">专家独立研究与互审</option></select></label>
              <label className="flex flex-col gap-1">任务目标<textarea required maxLength={8000} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="例如：调研登录模块的并发刷新问题，引用源码并提出修复建议" rows={3} className="rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
              {mode === "experts" ? <><ExpertSetup experts={experts} onChange={setExperts} capabilities={capabilities ?? []} profiles={profiles.profiles} turnLimit={expertTurnLimit} onTurnLimit={setExpertTurnLimit}/>{profiles.error?<p role="alert" className="text-destructive">{profiles.error}</p>:null}<Button type="button" variant="outline" onClick={profiles.reload}>重新发现本机角色与 Skills</Button><label className="flex items-start gap-2"><input type="checkbox" checked={profiles.accepted} onChange={event=>profiles.setAccepted(event.target.checked)}/>我已核对所选组合，接受只读指令加载及未接入工具的验证缺口；不运行角色/Skills 中的实施步骤。</label></> : <>
              {mode === "code" ? <ParallelCodeSetup enabled={parallel} onEnabled={setParallel} tasks={writeTasks} onChange={setWriteTasks} capabilities={capabilities} /> : null}
              {!(mode === "code" && parallel) ? <><label className="flex items-center gap-3">执行者<select value={executor} onChange={(event) => setExecutor(event.target.value as CollaborationWorkerAgent)} className="rounded-md border border-border bg-background p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">{(["codex", "claude", "agy"] as const).map((agent) => <option key={agent} value={agent} disabled={!capabilities?.find((entry) => entry.agent === agent)?.canExecute || mode === "code" && !capabilities?.find((entry) => entry.agent === agent)?.canExecuteCode}>{agent === "agy" ? "Antigravity / Gemini" : AGENTS[agent].name}{capabilities?.find((entry) => entry.agent === agent)?.canExecute ? "" : "（未通过检查）"}</option>)}</select></label>
              {executor === "agy" ? <label className="flex items-center gap-3">执行模型<select required value={executorModel} onChange={(event) => setExecutorModel(event.target.value)} className="rounded-md border border-border bg-background p-1"><option value="">选择当前账号可用的 Gemini 模型</option>{capabilities?.find((entry) => entry.agent === "agy")?.models?.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label> : null}
              </> : null}
              <label className="flex items-center gap-3">独立审查者<select value={reviewer} onChange={(event) => setReviewer(event.target.value as typeof reviewer)} className="rounded-md border border-border bg-background p-1"><option value="default">沿用当前会话（独立 {AGENTS[conversation.agent].name} 会话）</option>{(["claude", "codex", "agy"] as const).map((agent) => <option key={agent} value={agent} disabled={!capabilities?.find((entry) => entry.agent === agent)?.canReview}>{agent === "agy" ? "Antigravity / Gemini" : AGENTS[agent].name}</option>)}</select></label>
              {reviewer === "agy" ? <label className="flex items-center gap-3">审查模型<select required value={reviewerModel} onChange={(event) => setReviewerModel(event.target.value)} className="rounded-md border border-border bg-background p-1"><option value="">选择当前账号可用的 Gemini 模型</option>{capabilities?.find((entry) => entry.agent === "agy")?.models?.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label> : null}
              <p className="text-ui-sm text-foreground-subtle">{capabilities ? capabilities.find((entry) => entry.agent === executor)?.reason : "正在检查 CLI 能力…"}{mode === "code" ? " · agy/Gemini 当前可只读审查，代码执行尚未准入" : ""}</p>
              {mode === "code" ? <CodeValidationPlan path={conversation.projectPath} onChange={setCodeOptions} /> : null}
              </>}
              {mode === "research" ? <ResearchDraftPanel conversation={conversation} input={{ objective, executor: { agent: executor, ...(executor === "agy" ? { model: executorModel } : useAppStore.getState().settings.defaultModels[executor] ? { model: useAppStore.getState().settings.defaultModels[executor] } : {}) }, ...(reviewer !== "default" ? { reviewer: { agent: reviewer, ...(reviewer === "agy" ? { model: reviewerModel } : useAppStore.getState().settings.defaultModels[reviewer] ? { model: useAppStore.getState().settings.defaultModels[reviewer] } : {}) } } : {}) }} unavailable={sourceBusy ? "请先完成当前会话回合或消息队列" : executor === "agy" && !executorModel || reviewer === "agy" && !reviewerModel ? "请选择账号可用的 Gemini 模型" : !capabilities?.find(entry => entry.agent === executor)?.canExecute || reviewer !== "default" && !capabilities?.find(entry => entry.agent === reviewer)?.canReview ? "执行或审查 AI 尚未通过能力检查" : undefined} onStarted={run => { useCollaborationStore.getState().accept(run); setSelectedId(run.id); setObjective(""); }} /> :
              <Button type="submit" disabled={starting || sourceBusy || !objective.trim() || !sourceCapability?.canInitiate || (mode === "experts" ? !expertsReady : !codeOptions || parallel && !writeTasksReady(writeTasks,capabilities)) || mode === "code" && (!parallel && executor === "agy" && !executorModel || reviewer === "agy" && !reviewerModel || reviewer !== "default" && !capabilities?.find((entry) => entry.agent === reviewer)?.canReview || !parallel && !capabilities?.find((entry) => entry.agent === executor)?.canExecuteCode)}>{starting ? "正在启动…" : sourceBusy ? "请先完成当前回合 / 消息队列" : mode === "experts" ? "开始专家研究与互审" : "创建副本并开始代码协作"}</Button>}
            </>}
          </form>}
          {runs.length > 1 ? <label className="mb-3 flex items-center gap-3">协作记录<select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)} className="min-w-0 rounded-md border border-border bg-background p-1">{runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.experts && run.status === "completed" ? "专家互审与汇总已完成" : RUN_LABELS[run.status]}</option>)}</select></label> : null}
          {selected ? <CollaborationRunView key={selected.id} run={selected} /> : <p className="pb-3 text-foreground-subtle">暂无协作记录。</p>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
