// 当前会话的协作入口；沿用已有会话身份，首次启动先绑定 key，防止原生行事件丢失。
import { DEFAULT_WRITE_TASKS, ParallelCodeSetup, writeTasksReady } from "./ParallelCodeSetup";
import { ResearchDraftPanel } from "./ResearchDraftPanel";
import type { CodeWriteTask } from "@hcode/shared/codeDelivery";
import { createPortal } from "react-dom";
import { SidePanel } from "../conversation/SidePanel";
import { useUiStore } from "../store/uiStore";
import type { WorkMode } from "../composer/workMode";
import { useEffect, useRef, useState } from "react";
import type { CodeStartOptions } from "@hcode/shared/codeDelivery";
import { CodeValidationPlan } from "./CodeValidationPlan";
import { ExpertDraftPanel } from "./ExpertDraftPanel";
import { EXPERT_LIMITS } from "@hcode/shared/experts";
import { NetworkIcon } from "lucide-react";
import type { CollaborationWorkerAgent } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { hcode } from "../bridge";
import { useAppStore, type Conversation } from "../store/appStore";
import { useCollaborationSession } from "./useCollaborationSession";
import { useCollaborationStore } from "./collaborationStore";
import { CollaborationRecovery } from "./CollaborationRecovery";
import { CollaborationRunView, RUN_LABELS } from "./CollaborationRunView";

const panelPositions = new Map<string, { selectedId?: string; scrollTop: number }>();

export function CollaborationPanel({ conversation, currentInput, workMode, attachmentBlocked, onStarted }: { conversation: Conversation; currentInput: string; workMode: WorkMode; attachmentBlocked?: string; onStarted(input: string): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const submittedInput = useRef("");
  const panel = useUiStore(state => state.sidePanel);
  const setSidePanel = useUiStore(state => state.setSidePanel);
  const open = panel?.type === "collaboration" && panel.viewId === conversation.viewId;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => { setPortal(document.getElementById("conversation-panels")); }, []);
  const close = () => { setSidePanel(null); requestAnimationFrame(() => trigger.current?.focus()); };
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState<"research" | "code" | "experts">("research");
  const [parallel,setParallel]=useState(false);
  const [writeTasks,setWriteTasks]=useState<CodeWriteTask[]>(DEFAULT_WRITE_TASKS);
  const [codeOptions, setCodeOptions] = useState<CodeStartOptions>();
  const [executor, setExecutor] = useState<CollaborationWorkerAgent>(conversation.agent === "codex" ? "claude" : "codex");
  const [executorModel, setExecutorModel] = useState("");
  const [reviewer, setReviewer] = useState<"default" | CollaborationWorkerAgent>("default");
  const [reviewerModel, setReviewerModel] = useState("");
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(panelPositions.get(conversation.viewId)?.selectedId);
  const { runs, active, capabilities, checkingCapabilities, sourceCapability, sourceBusy, error: sessionError } = useCollaborationSession(conversation, open);
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  useEffect(() => { setExecutor(conversation.agent === "codex" ? "claude" : "codex"); }, [conversation.agent]);

  useEffect(() => { if (open) setObjective(currentInput); }, [panel]);
  useEffect(() => { setMode(workMode === "experts" ? "experts" : "research"); }, [workMode]);
  useEffect(() => {
    if (!open || !scrollRef.current) return;
    scrollRef.current.scrollTop = panelPositions.get(conversation.viewId)?.scrollTop ?? 0;
  }, [open]);
  const selectRun = (id: string) => { setSelectedId(id); panelPositions.set(conversation.viewId, { selectedId: id, scrollTop: 0 }); };

  const startCode = async () => {
    setStarting(true); setError("");
    try {
      const current = useAppStore.getState().conversations[conversation.viewId];
      if (!current || !sourceCapability?.canInitiate || current.runState === "running" || current.runState === "awaitingApproval" || current.queue.length) throw new Error("请先完成当前回合，并确认当前线程具备委派工具");
      if (mode === "code" && !codeOptions) throw new Error("请先确认工作区与验证计划");
      if(mode==='code'&&parallel&&!writeTasksReady(writeTasks,capabilities))throw new Error('请完成两项写任务配置与文件范围');
      const sessionKey = current.sessionKey ?? crypto.randomUUID();
      useAppStore.setState((state) => ({ conversations: { ...state.conversations, [current.viewId]: { ...current, sessionKey } } }));
      const initiator = { agent: current.agent, sessionKey, projectPath: current.projectPath, permissionMode: current.permissionMode, ...(current.sessionId ? { resumeSessionId: current.sessionId } : {}), ...(current.model ? { model: current.model } : {}), ...(current.effort ? { effort: current.effort } : {}) };
      const run = await hcode.invoke("collaboration:start", { initiator, executor: mode === "code" && parallel ? writeTasks[0]!.executor : { agent: executor, ...(executor === "agy" ? { model: executorModel } : executorModel || useAppStore.getState().settings.defaultModels[executor] ? { model: executorModel || useAppStore.getState().settings.defaultModels[executor] } : {}) }, ...(reviewer !== "default" ? { reviewer: { agent: reviewer, ...(reviewer === "agy" ? { model: reviewerModel } : reviewerModel || useAppStore.getState().settings.defaultModels[reviewer] ? { model: reviewerModel || useAppStore.getState().settings.defaultModels[reviewer] } : {}) } } : {}), objective, ...(mode === "code" ? { code: {...codeOptions!,...(parallel?{tasks:writeTasks.map(task=>({...task,objective:task.objective.trim(),allowedPaths:task.allowedPaths.map(path=>path.trim()),executor:{...task.executor,...(useAppStore.getState().settings.defaultModels[task.executor.agent]?{model:useAppStore.getState().settings.defaultModels[task.executor.agent]}:{})}}))}:{})} } : {}) });
      useCollaborationStore.getState().accept(run); selectRun(run.id); setObjective(""); onStarted(objective); setSidePanel({ type: "collaboration", viewId: conversation.viewId, intent: "records" });
    } catch (reason) { setError(String(reason)); }
    finally { setStarting(false); }
  };

  return <>
    <div className="mb-2 flex items-center gap-2 text-ui-sm">
      <Button ref={trigger} variant="ghost" size="sm" className="focus-visible:ring-2 focus-visible:ring-ring active:brightness-90" onClick={() => setSidePanel({ type: "collaboration", viewId: conversation.viewId, intent: "records" })}><NetworkIcon />{active ? RUN_LABELS[active.status] : "协作计划与记录"}</Button>
    </div>
    {portal ? createPortal(<div hidden={!open} inert={!open}>
      <SidePanel label="协作任务面板" title="协作计划与任务" onClose={close} focus={open} collaboration>
        <div ref={scrollRef} onScroll={() => panelPositions.set(conversation.viewId, { selectedId, scrollTop: scrollRef.current?.scrollTop ?? 0 })} className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 text-ui-sm text-foreground-subtle">当前 AI 制定计划与汇总，其他 AI 执行和独立审查。关闭面板后任务继续。</p>
          {error || sessionError ? <p role="alert" className="mb-3 whitespace-pre-wrap text-destructive">{error || sessionError}</p> : null}
          <CollaborationRecovery />
          {attachmentBlocked ? <p role="status" className="mb-3">{attachmentBlocked}</p> : null}
          {active ? <p role="status" className="mb-3 text-foreground-subtle">{active.status === "stopping" ? "等待原生中断确认，尚未暂停或停止" : "关闭此窗口后协作会继续；下方可暂停接管或停止"}</p> : <details open={!selected || panel?.type === "collaboration" && panel.intent === "plan"} className="mb-4"><summary className="mb-3 cursor-pointer font-medium">{selected ? "制定新的计划" : "制定协作计划"}</summary><form onSubmit={(event) => { event.preventDefault(); if (mode === "code" && !attachmentBlocked) void startCode(); }} className="mb-4 flex flex-col gap-3 rounded-lg border border-border p-3">
            <p className="text-foreground-subtle">发起者：{AGENTS[conversation.agent].name}（当前会话）</p>
            {!sourceCapability?.canInitiate ? <p role="status">{sourceCapability?.reason ?? "正在检查当前线程的委派能力…"}</p> : <>
              {mode === "experts" ? <p className="text-ui-sm">专家评审 · 当前 AI 推荐，用户调整并确认团队</p> : <label className="flex flex-col gap-1">协作任务<select value={mode} onChange={(event) => { setMode(event.target.value as "research" | "code" | "experts"); setCodeOptions(undefined); }} className="min-w-0 w-full rounded-md border border-border bg-background p-1"><option value="research">只读调研</option><option value="code">隔离代码交付</option></select></label>}
              {mode !== "code" ? <div><p className="text-ui-sm text-foreground-subtle">当前输入目标（保留在聊天输入框）</p><p className="mt-1 whitespace-pre-wrap">{objective || "请在输入框填写任务目标，再打开计划。"}</p></div> : <label className="flex flex-col gap-1">当前输入目标<textarea required maxLength={8000} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="例如：调研登录模块的并发刷新问题，引用源码并提出修复建议" rows={3} className="rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>}

              {mode === "experts" ? <ExpertDraftPanel conversation={conversation} input={{ objective, turnLimit: EXPERT_LIMITS.defaultProfileTurns, backendPreferences: (["claude", "codex"] as const).map(agent => ({ agent, ...(useAppStore.getState().settings.defaultModels[agent] ? { model: useAppStore.getState().settings.defaultModels[agent] } : {}) })) }} capabilities={capabilities ?? []} unavailable={attachmentBlocked ?? (checkingCapabilities ? "正在核对当前会话及 AI 能力…" : sourceBusy ? "请先完成当前回合或消息队列" : undefined)} onStarted={(run, input) => { useCollaborationStore.getState().accept(run); selectRun(run.id); setObjective(""); onStarted(input); setSidePanel({ type: "collaboration", viewId: conversation.viewId, intent: "records" }); }} /> : <>
              {mode === "code" ? <p className="text-ui-sm text-foreground-subtle">隔离代码交付沿用手动范围与验证配置；自动代码计划尚未接入。</p> : null}
              {mode === "code" ? <ParallelCodeSetup enabled={parallel} onEnabled={setParallel} tasks={writeTasks} onChange={setWriteTasks} capabilities={capabilities} /> : null}
              {!(mode === "code" && parallel) ? <><label className="flex flex-col gap-1">执行者<select value={executor} onChange={(event) => { setExecutor(event.target.value as CollaborationWorkerAgent); setExecutorModel(""); }} className="min-w-0 w-full rounded-md border border-border bg-background p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring">{(["codex", "claude", "agy"] as const).map((agent) => <option key={agent} value={agent} disabled={!capabilities?.find((entry) => entry.agent === agent)?.canExecute || mode === "code" && !capabilities?.find((entry) => entry.agent === agent)?.canExecuteCode}>{agent === "agy" ? "Antigravity / Gemini" : AGENTS[agent].name}{capabilities?.find((entry) => entry.agent === agent)?.canExecute ? "" : "（未通过检查）"}</option>)}</select></label>
              {executor === "agy" ? <label className="flex flex-col gap-1">执行模型<select required value={executorModel} onChange={(event) => setExecutorModel(event.target.value)} className="min-w-0 w-full rounded-md border border-border bg-background p-1"><option value="">选择当前账号可用的 Gemini 模型</option>{capabilities?.find((entry) => entry.agent === "agy")?.models?.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label> : null}
              </> : null}
              <label className="flex flex-col gap-1">独立审查者<select value={reviewer} onChange={(event) => { setReviewer(event.target.value as typeof reviewer); setReviewerModel(""); }} className="min-w-0 w-full rounded-md border border-border bg-background p-1"><option value="default">沿用当前会话（独立 {AGENTS[conversation.agent].name} 会话）</option>{(["claude", "codex", "agy"] as const).map((agent) => <option key={agent} value={agent} disabled={!capabilities?.find((entry) => entry.agent === agent)?.canReview}>{agent === "agy" ? "Antigravity / Gemini" : AGENTS[agent].name}</option>)}</select></label>
              {reviewer === "agy" ? <label className="flex flex-col gap-1">审查模型<select required value={reviewerModel} onChange={(event) => setReviewerModel(event.target.value)} className="min-w-0 w-full rounded-md border border-border bg-background p-1"><option value="">选择当前账号可用的 Gemini 模型</option>{capabilities?.find((entry) => entry.agent === "agy")?.models?.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label> : null}
              <p className="text-ui-sm text-foreground-subtle">{capabilities ? capabilities.find((entry) => entry.agent === executor)?.reason : "正在检查 CLI 能力…"}{mode === "code" ? " · agy/Gemini 当前可只读审查，代码执行尚未准入" : ""}</p>
              {mode === "code" ? <CodeValidationPlan path={conversation.projectPath} onChange={setCodeOptions} /> : null}
              {mode === "research" ? <ResearchDraftPanel onPrepared={input => { submittedInput.current = input; }} conversation={conversation} input={{ objective, executor: { agent: executor, ...(executor === "agy" ? { model: executorModel } : executorModel || useAppStore.getState().settings.defaultModels[executor] ? { model: executorModel || useAppStore.getState().settings.defaultModels[executor] } : {}) }, ...(reviewer !== "default" ? { reviewer: { agent: reviewer, ...(reviewer === "agy" ? { model: reviewerModel } : reviewerModel || useAppStore.getState().settings.defaultModels[reviewer] ? { model: reviewerModel || useAppStore.getState().settings.defaultModels[reviewer] } : {}) } } : {}) }} onRestored={draft => { setExecutor(draft.params.executor.agent); setExecutorModel(draft.params.executor.model ?? ""); setReviewer(draft.params.reviewer?.agent ?? "default"); setReviewerModel(draft.params.reviewer?.model ?? ""); }} unavailable={attachmentBlocked ?? (checkingCapabilities ? "正在重新核对当前线程及 AI 能力…" : sourceBusy ? "请先完成当前会话回合或消息队列" : executor === "agy" && !executorModel || reviewer === "agy" && !reviewerModel ? "请选择账号可用的 Gemini 模型" : !capabilities?.find(entry => entry.agent === executor)?.canExecute || reviewer !== "default" && !capabilities?.find(entry => entry.agent === reviewer)?.canReview ? "执行或审查 AI 尚未通过能力检查" : undefined)} onStarted={run => { useCollaborationStore.getState().accept(run); selectRun(run.id); setObjective(""); onStarted(submittedInput.current); setSidePanel({ type: "collaboration", viewId: conversation.viewId, intent: "records" }); }} /> :
              <Button type="submit" disabled={checkingCapabilities || Boolean(attachmentBlocked) || starting || sourceBusy || !objective.trim() || !sourceCapability?.canInitiate || (!codeOptions || parallel && !writeTasksReady(writeTasks,capabilities)) || mode === "code" && (!parallel && executor === "agy" && !executorModel || reviewer === "agy" && !reviewerModel || reviewer !== "default" && !capabilities?.find((entry) => entry.agent === reviewer)?.canReview || !parallel && !capabilities?.find((entry) => entry.agent === executor)?.canExecuteCode)}>{starting ? "正在启动…" : sourceBusy ? "请先完成当前回合 / 消息队列" : "创建副本并开始代码协作"}</Button>}
              </>}
            </>}
          </form></details>}
          {runs.length > 1 ? <label className="mb-3 flex items-center gap-3">协作记录<select value={selected?.id ?? ""} onChange={(event) => selectRun(event.target.value)} className="min-w-0 rounded-md border border-border bg-background p-1">{runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString()} · {run.experts && run.status === "completed" ? "专家互审与汇总已完成" : RUN_LABELS[run.status]}</option>)}</select></label> : null}
          {selected ? <CollaborationRunView key={selected.id} run={selected} /> : <p className="pb-3 text-foreground-subtle">暂无协作记录。</p>}
        </div>
      </SidePanel>
    </div>, portal) : null}
  </>;
}
