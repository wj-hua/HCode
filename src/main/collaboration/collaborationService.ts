// 当前会话发起委派，宿主调度审查与修订；模型工具仅访问闭包绑定的 Run。
import { CollaborationRunner } from "./collaborationRunner.js";
import { WorkspaceService } from "./workspaces/workspaceService.js";
import { codeCandidates, candidateForVersion, candidateSnapshot, deliveryCode } from '../../shared/codeCandidates.js';
import { RunOperations } from './runOperations.js';
import { CodeRunService } from './workspaces/codeRunService.js';
import { CodeDeliveryWorkflow } from "./workspaces/codeDeliveryWorkflow.js";
import { inspectCodeProject } from "./workspaces/validationPlan.js";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { z } from "zod";
import type { CollaborationCapabilities, CollaborationSource, CollaborationSnapshot, CollaborationStartParams, DeliverySnapshot } from "../../shared/collaboration.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { SessionExecutionService } from "../sessions/sessionExecutionService.js";
import type { HostedTool } from "../sessions/researchRuntime.js";
import { collaborationCapabilities } from "./collaborationCapabilities.js";
import { CollaborationRepository } from "./collaborationRepository.js";
import { DeliveryWorkflow } from "./deliveryWorkflow.js";
import { RunExecutor } from "./runExecutor.js";
import { MAX_DELIVERIES, WAIT_TOOL_MS, MAX_RUN_TURNS, startSchema } from "./contracts.js";
import type { ActiveRun } from "./activeRun.js";
import { TaskMessages } from "./taskMessages.js";
import { RunControls } from "./runControls.js";
import { assertEvidenceCurrent } from "./reportEvidence.js";
import { EXPERT_LIMITS } from '../../shared/experts.js';
import type { ExpertStartParams } from '../../shared/experts.js';
import { expertStartSchema } from './experts/expertContracts.js';
import { assertExpertArtifactIsolation, assertExpertBackends } from './experts/expertAdmission.js';
import { ExpertControls } from './experts/expertControls.js';
import { expertSummaryData } from './experts/expertEvidence.js';

import { ExpertProfileService } from "./experts/profiles/expertProfileService.js";
import { CodeAdoptionService } from "./adoption/codeAdoptionService.js";
import { type AdoptionRequest } from "../../shared/codeAdoption.js";
import { sourceTools } from "./sourceTools.js";
import type { ApprovedResearchPlan } from "../../shared/researchDraft.js";
import type { CollaborationTask } from "../../shared/collaboration.js";
import { approvedPlanSchema } from "./collaborationSchemas.js";
export class CollaborationService {
  readonly adoption: CodeAdoptionService;
  private readonly runs = new Map<string, ActiveRun>();
  readonly controls: RunControls;
  readonly expertControls:ExpertControls;
  private readonly runner: CollaborationRunner;
  readonly workspaces: WorkspaceService;
  private readonly codeRuns: CodeRunService;
  private readonly operations=new RunOperations();
  inspectCodeProject = inspectCodeProject;

  private activate(snapshot: CollaborationSnapshot) {
    const active = {} as ActiveRun;
    Object.assign(active, { snapshot, executor: new RunExecutor(snapshot, new AbortController(), this.execution, () => this.changed(active)), messages: new TaskMessages(snapshot, () => this.changed(active)), jobs: new Map(), writes: Promise.resolve() });
    this.runs.set(snapshot.id, active);
    return active;
  }

  constructor(private readonly repository: CollaborationRepository, private readonly execution: SessionExecutionService, private readonly agents: AgentRegistry, private readonly emit: (snapshot: CollaborationSnapshot) => void, private readonly platform: NodeJS.Platform = process.platform, readonly profiles = new ExpertProfileService(repository.root)) {
    this.workspaces = new WorkspaceService(repository.root);
    this.codeRuns = new CodeRunService(this.workspaces);
    this.adoption = new CodeAdoptionService(this.workspaces,repository);
    this.runner=new CollaborationRunner({repository,execution,agents,profiles,emit,changed:active=>this.changed(active),tools:active=>this.tools(active),launchDelivery:(active,delivery,reviewOnly)=>this.launchDelivery(active,delivery,reviewOnly),revalidateDeliveries:active=>this.revalidateDeliveries(active)});
    this.expertControls=new ExpertControls({repository,execution,profiles,active:async id=>this.runs.get(z.string().uuid().parse(id))??this.activate(this.recovered(await repository.load(id))),assertSource:async (source,experts)=>{const capabilities=await this.capabilities(source);assertExpertBackends(experts,capabilities);const capability=capabilities.find(entry=>entry.agent===source.agent);if(!capability?.canInitiate)throw new Error(capability?.reason??'当前源会话不支持专家主持');},changed:active=>this.changed(active),continue:(active,params)=>{active.done=this.runner.run(active,params);}});
    this.controls = new RunControls({
      workspaces: this.workspaces,
      exclusive:(id,action)=>this.operations.execute(id,action),
      repository, execution, agents,
      active: async (id) => this.activeRun(id),
      changed: (active) => this.changed(active),
      continue: (active, params) => { active.done = this.runner.run(active, params); },
    });
  }

  capabilities(source?: CollaborationSource): Promise<CollaborationCapabilities[]> { return collaborationCapabilities(this.agents, this.platform, source); }

  /** 启动校验和初始记录成功后返回；后续阶段由主进程运行，不依赖视图存活。 */
  async start(input: CollaborationStartParams): Promise<CollaborationSnapshot> {
    return this.startRun(input);
  }

  /** 草案确认复用固定 Run ID；已落盘结果只读取，重启后不会再次派发。 */
  async startPrepared(input: CollaborationStartParams, approval: ApprovedResearchPlan, turns: CollaborationTask[]) {
    if (input.code) throw new Error("只读草案不能执行代码任务");
    return this.startFromApproved(input.initiator, approval, turns, 3, MAX_RUN_TURNS, prepared => this.startRun(input, prepared));
  }

  async startPreparedExperts(input: ExpertStartParams, approval: ApprovedResearchPlan, turns: CollaborationTask[]) {
    const params = expertStartSchema.parse(input);
    return this.startFromApproved(params.initiator, approval, turns, params.experts.length * EXPERT_LIMITS.turnsPerParticipant + 1, params.turnLimit ?? MAX_RUN_TURNS, prepared => this.startExpertRun(params, prepared));
  }

  /** 固定身份的已确认计划只启动一次；恢复返回保存的 Run，不重建专家或派发。 */
  private async startFromApproved(source: CollaborationStartParams["initiator"], approval: ApprovedResearchPlan, turns: CollaborationTask[], remaining: number, limit: number, create: (prepared: { approved: ApprovedResearchPlan; turns: CollaborationTask[] }) => Promise<CollaborationSnapshot>) {
    const approved = approvedPlanSchema.parse(approval);
    return this.operations.execute(approved.draftId, async () => {
      const existing = await this.getApprovedPlan(approved);
      if (existing) return existing;
      if (!turns.length || turns.length + remaining > limit || turns.some(turn => turn.role !== "planning" || turn.sessionKey !== source.sessionKey || turn.agent !== source.agent || turn.status === "running") || turns.at(-1)?.status !== "succeeded" || turns.at(-1)?.nativeSessionId !== source.resumeSessionId) throw new Error("计划的原会话、规划回合或预算不合法");
      return create({ approved, turns });
    });
  }

  /** 确认响应丢失后只读取相同凭据的结果，不以当前文件或后端状态重启任务。 */
  async getApprovedPlan(approval: ApprovedResearchPlan) {
    const approved = approvedPlanSchema.parse(approval);
    let existing: CollaborationSnapshot;
    try { existing = await this.get(approved.draftId); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    if (JSON.stringify(existing.approvedPlan) !== JSON.stringify(approved)) throw new Error("已启动计划的确认版本不一致");
    return existing;
  }

  private async startRun(input: CollaborationStartParams, prepared?: { approved: ApprovedResearchPlan; turns: CollaborationTask[] }): Promise<CollaborationSnapshot> {
    const params = startSchema.parse(input);
    const root = await realpath(params.initiator.projectPath);
    if (!(await stat(root)).isDirectory()) throw new Error("协作项目不是目录");
    params.initiator.projectPath = root;
    const capabilities = await this.capabilities({ agent: params.initiator.agent, ...(params.initiator.resumeSessionId ? { resumeSessionId: params.initiator.resumeSessionId } : {}) });
    const source = capabilities.find((capability) => capability.agent === params.initiator.agent);
    if (!source?.canInitiate) throw new Error(source?.reason ?? "发起者未通过协作能力检查");
    if (!capabilities.find((capability) => capability.agent === params.executor.agent)?.canExecute) throw new Error("所选执行者未通过协作能力检查");
    for (const backend of [params.executor, ...(params.reviewer ? [params.reviewer] : [])]) {
      const capability = capabilities.find((entry) => entry.agent === backend.agent);
      if (backend === params.reviewer && !capability?.canReview) throw new Error("所选审查者未通过协作能力检查");
      if (backend.agent === "agy" && (!backend.model || !capability?.models?.some((model) => model.value === backend.model))) throw new Error("请选择当前账号模型列表中的 Gemini 模型，不使用默认模型或自动替换");
    }
    if (params.code && !capabilities.find((entry) => entry.agent === params.executor.agent)?.canExecuteCode) throw new Error("所选执行者尚未通过代码写入准入，当前仅支持只读研究/审查");
    const snapshot: CollaborationSnapshot = { id: prepared?.approved.draftId ?? randomUUID(), seq: 0, createdAt: Date.now(), params, status: "running", stage: "planning", tasks: structuredClone(prepared?.turns ?? []), deliveries: [], ...(prepared ? { approvedPlan: prepared.approved } : {}) };
    this.execution.reserve(params.initiator.sessionKey, snapshot.id, params.initiator.resumeSessionId ? `${params.initiator.agent}:${params.initiator.resumeSessionId}` : undefined);
    let active: ActiveRun;
    try {
      await this.codeRuns.initialize(snapshot,params,capabilities);
      active = this.activate(snapshot);
      await this.changed(active);
    }
    catch (error) { this.execution.release(params.initiator.sessionKey, snapshot.id); this.runs.delete(snapshot.id); throw error; }
    active.done = this.runner.run(active);
    return structuredClone(snapshot);
  }

  /** 终结快照等待源会话恢复收尾；采纳和重启展示不沿用提前发布的完成状态。 */
  async get(id: string) {
    const active=this.runs.get(z.string().uuid().parse(id));
    if(active?.snapshot.stage === "finished")await active.done;
    return this.adoption.decorate(structuredClone(active?.snapshot ?? this.recovered(await this.repository.load(id))));
  }

  private async activeRun(id:string) {
    const active=this.runs.get(z.string().uuid().parse(id)) ?? this.activate(this.recovered(await this.repository.load(id)));
    await this.adoption.decorate(active.snapshot);
    return active;
  }
  adoptionPreview = async (id:string,versionId:string) => this.adoptionPreviewForVersion(await this.get(id),versionId);
  private adoptionPreviewForVersion(snapshot:CollaborationSnapshot,versionId:string) {
    return this.adoption.preview(candidateSnapshot(snapshot,candidateForVersion(snapshot,versionId)),versionId);
  }
  async applyCandidate(id:string,request:AdoptionRequest) {
    return this.operations.execute(id,async()=>{
    const active=await this.activeRun(id);await active.done;
    const target=candidateForVersion(active.snapshot,request.versionId);
    const result=await this.adoption.apply(candidateSnapshot(active.snapshot,target),request);await this.changed(active);return result;
    });
  }
  async recoverAdoption(id:string,adoptionId:string) {
    return this.operations.execute(id,async()=>{
    const active=await this.activeRun(id);await active.done;
    const target=codeCandidates(active.snapshot).find(entry=>entry.code.adoption?.id===adoptionId);
    if(!target)throw new Error('采纳恢复记录不属于本次代码任务');
    const result=await this.adoption.recover(candidateSnapshot(active.snapshot,target),adoptionId);await this.changed(active);return result;
    });
  }

  /** 专家项目不能包含宿主报告目录，推荐和启动使用相同边界。 */
  assertExpertProject(project: string) { return assertExpertArtifactIsolation(project, this.repository.root); }

  /** 冻结专家配置后启动；首轮上下文不携带其他专家产物。 */
  async startExperts(input:ExpertStartParams):Promise<CollaborationSnapshot> { return this.startExpertRun(input); }

  private async startExpertRun(input: ExpertStartParams, prepared?: { approved: ApprovedResearchPlan; turns: CollaborationTask[] }): Promise<CollaborationSnapshot> {
    const params=expertStartSchema.parse(input),root=await realpath(params.initiator.projectPath);
    if(!(await stat(root)).isDirectory())throw new Error('协作项目不是目录');
    await this.assertExpertProject(root);
    params.initiator.projectPath=root;
    const capabilities=await this.capabilities({agent:params.initiator.agent,...(params.initiator.resumeSessionId?{resumeSessionId:params.initiator.resumeSessionId}:{})});
    const source=capabilities.find(entry=>entry.agent===params.initiator.agent);
    if(!source?.canInitiate)throw new Error(source?.reason??'当前源会话不支持专家主持');
    assertExpertBackends(params.experts,capabilities);
    const runId=prepared?.approved.draftId ?? randomUUID();
    const profiles=params.experts.some(expert=>expert.profileHash || !["architecture","implementation","quality"].includes(expert.role)) ? await this.profiles.freeze(runId,root,params.experts,params.acceptProfileLimitations===true) : [];
    const participants=params.experts.map(expert=>({...expert,id:randomUUID(),sessionKey:randomUUID(),status:'queued' as const,versions:[],rawResults:[],...(profiles.find(profile=>profile.role===expert.role)?{profile:profiles.find(profile=>profile.role===expert.role),profileLoads:[],resourceReads:[]}:{} )}));
    const snapshot:CollaborationSnapshot={id:runId,seq:0,createdAt:Date.now(),params,status:'running',stage:'planning',tasks:structuredClone(prepared?.turns ?? []),deliveries:[],...(prepared ? { approvedPlan: prepared.approved } : {}),experts:{participants,reviews:[],activeIds:participants.map(expert=>expert.id),partialAuthorized:false,rawSummaries:[],turnLimit:params.turnLimit??MAX_RUN_TURNS}};
    this.execution.reserve(params.initiator.sessionKey,snapshot.id,params.initiator.resumeSessionId?`${params.initiator.agent}:${params.initiator.resumeSessionId}`:undefined);
    const active=this.activate(snapshot);
    try{await this.changed(active);}catch(error){this.execution.release(params.initiator.sessionKey,snapshot.id);this.runs.delete(snapshot.id);throw error;}
    active.done=this.runner.run(active);
    return structuredClone(snapshot);
  }

  async list(sessionKey: string, sessionId?: string): Promise<CollaborationSnapshot[]> {
    z.string().uuid().parse(sessionKey);
    const saved = (await this.repository.catalog()).snapshots;
    return Promise.all(saved.filter((snapshot) => snapshot.params.initiator.sessionKey === sessionKey || Boolean(sessionId && (snapshot.params.initiator.resumeSessionId === sessionId || snapshot.tasks.some((task) => task.role === "planning" && task.nativeSessionId === sessionId)))).map((snapshot) => structuredClone(this.runs.get(snapshot.id)?.snapshot ?? this.recovered(snapshot))).map(snapshot=>this.adoption.decorate(snapshot)));
  }

  async recoveryIssues() { return (await this.repository.catalog()).issues; }

  async repair(id: string) {
    const active = this.runs.get(id);
    if (active && ["running", "stopping"].includes(active.snapshot.status)) throw new Error("活动协作不能修复事件日志");
    const snapshot = this.recovered(await this.repository.repairTail(id));
    this.runs.delete(id);
    return snapshot;
  }

  async cancel(id: string) { await this.controls.stop(id, "cancel"); }

  /** 退出时只请求本服务持有的回合中断；重启后以 interrupted 显式恢复。 */
  dispose() {
    for (const active of this.runs.values()) if (["running", "stopping"].includes(active.snapshot.status)) active.executor.abort.abort();
  }

  async artifact(runId: string, versionId: string) {
    const snapshot = await this.get(runId);
    const version = [...snapshot.deliveries.flatMap((delivery) => delivery.versions),...(snapshot.experts?.participants.flatMap(expert=>expert.versions)??[])].find((entry) => entry.id === z.string().uuid().parse(versionId));
    if (!version) throw new Error("该产物不属于本次协作");
    return this.repository.readReport(snapshot.id, version);
  }


  /** 操作绑定所选独立任务；先等待所有模型回合停止，副本和原项目不会混用。 */
  async candidateAction(id: string, action: "manual" | "discard" | "cleanup", deliveryId?: string) {
    return this.operations.execute(id,async()=>{
    z.enum(["manual", "discard", "cleanup"]).parse(action);
    const active = await this.activeRun(id);
    if (["running", "stopping"].includes(active.snapshot.status)) throw new Error("先暂停并等待原生停止确认");
    await active.done;
    const path=await this.codeRuns.action(active.snapshot,action,deliveryId);
    await this.changed(active);return path;
    });
  }
  async candidatePreview(id: string, versionId: string) {
    return this.codeRuns.preview(await this.get(id),versionId);
  }

  private async changed(active: ActiveRun) {
    const write = active.writes.then(async () => {
      active.snapshot.seq++;
      const durable = structuredClone(active.snapshot);
      await this.repository.save(durable);
      this.emit(durable);
    });
    active.writes = write;
    await write;
  }


  private tools(active: ActiveRun): HostedTool[] {
    return sourceTools(async (name, input) => {
      switch (name) {
        case "get_context_requests": return active.messages.pending();
        case "reply_context": await active.messages.reply(String(input.messageId), String(input.text), "initiator"); return { replied: true };
        case "delegate_task": return this.delegate(active, String(input.requestKey), String(input.objective));
        case "get_task_result": return this.taskResult(active, String(input.taskId));
        case "wait_tasks": return this.wait(active, input.taskIds as string[]);
        default: throw new Error("未知协作工具");
      }
    });
  }

  /** 汇总前后核对冻结版本；外部编辑不能沿用先前已接受的审查结论。 */
  private async revalidateDeliveries(active: ActiveRun) {
    for (const delivery of active.snapshot.deliveries.filter((entry) => entry.status === "accepted")) {
      const version = delivery.versions.at(-1)!;
      try { await this.repository.readReport(active.snapshot.id, version);
        if(deliveryCode(active.snapshot,delivery)?.adoption?.status==="applied")continue;
        await assertEvidenceCurrent(deliveryCode(active.snapshot,delivery)?.workspace.path ?? active.snapshot.params.initiator.projectPath, version.evidence);
        await this.codeRuns.assertAccepted(active.snapshot,delivery); }
      catch (error) { delivery.status = "awaitingUser"; delivery.error = String(error); active.snapshot.error = "报告或源码证据已变化，需要重新调研和审查"; }
    }
  }

  private async delegate(active: ActiveRun, requestKey: string, objective: string) {
    if(active.snapshot.params.mode==='experts')throw new Error('专家流程由宿主固定调度，不允许自由委派');
    if (active.snapshot.stage !== "planning" || active.executor.abort.signal.aborted) throw new Error("本次协作已停止派发");
    const configured='code' in active.snapshot.params?active.snapshot.params.code?.tasks:undefined;
    if(configured && !configured.some(task=>task.requestKey===requestKey))throw new Error('任务不在用户确认的并行计划中');
    if(configured)objective=configured.find(task=>task.requestKey===requestKey)!.objective;
    else if (active.snapshot.code) objective = active.snapshot.params.objective;
    const existing = active.snapshot.deliveries.find((delivery) => delivery.requestKey === requestKey);
    if (existing) {
      if (existing.objective !== objective) throw new Error("相同幂等键对应不同任务");
      if(configured && existing.status==='queued' && !active.jobs.has(existing.id))this.launchDelivery(active,existing);
      return { taskId: existing.id };
    }
    if (active.snapshot.code && active.snapshot.deliveries.length) throw new Error("隔离代码首版只允许一个完整交付");
    if (active.snapshot.deliveries.length >= MAX_DELIVERIES || !active.executor.canAddDelivery()) throw new Error("任务/回合预算不足，无法为新任务预留审查与汇总");
    const delivery: DeliverySnapshot = { id: randomUUID(), requestKey, objective, executor: active.snapshot.params.executor, status: "queued", versions: [], reviews: [] };
    active.snapshot.deliveries.push(delivery);
    await this.changed(active);
    this.launchDelivery(active, delivery);
    return { taskId: delivery.id };
  }

  private launchDelivery(active: ActiveRun, delivery: DeliverySnapshot, reviewOnly = false) {
    delivery.workerSessionKey ??= active.snapshot.tasks.findLast((task) => task.deliveryId === delivery.id && task.role === "execution")?.sessionKey ?? randomUUID();
    delete delivery.error;
    const workflow = new DeliveryWorkflow({ runId: active.snapshot.id, root: active.snapshot.params.initiator.projectPath, repository: this.repository, pauseRequested: () => active.snapshot.stopIntent === "pause", questionCount: (id) => (active.snapshot.messages ?? []).filter((entry) => entry.deliveryId === id && entry.type === "clarification").length, pendingContext: (id) => active.messages.pending(id).length > 0, context: (id) => active.messages.context(id), changed: () => this.changed(active), execute: (role, key, text, schema, target) => active.executor.execute(role, key, text, schema, target, role === "execution" ? active.messages.workerTools(target, key) : undefined) });
    const code=deliveryCode(active.snapshot,delivery);
    const codeWorkflow = code ? new CodeDeliveryWorkflow({ runId: active.snapshot.id, root: code.workspace.path, repository: this.repository, code, workspaces: this.workspaces, signal: active.executor.deliverySignal(delivery.id), changed: () => this.changed(active), questionCount: (id) => (active.snapshot.messages ?? []).filter((entry) => entry.deliveryId === id && entry.type === "clarification").length, pendingContext: (id) => active.messages.pending(id).length > 0, context: (id) => active.messages.context(id), execute: (role, key, text, schema, target, tools) => active.executor.execute(role, key, text, schema, target, role === "execution" ? [...active.messages.workerTools(target, key), ...(tools ?? [])] : tools) }) : undefined;
    const job = (codeWorkflow ?? workflow).run(delivery, delivery.workerSessionKey!, reviewOnly).catch(async (error: unknown) => { delivery.status = active.executor.abort.signal.aborted && active.snapshot.stopIntent === "pause" ? "interrupted" : active.executor.abort.signal.aborted || /取消/.test(String(error)) ? "cancelled" : "awaitingUser"; delivery.error = error instanceof Error ? error.message : String(error); await this.changed(active); });
    // 立即登记拒绝观察；run() 会统一收集失败，避免 detached promise 静默失败。
    void job.catch((error: unknown) => { active.snapshot.persistenceError = String(error); active.executor.abort.abort(); });
    active.jobs.set(delivery.id, job);
  }

  private requireDelivery(active: ActiveRun, id: string) {
    const delivery = active.snapshot.deliveries.find((entry) => entry.id === id);
    if (!delivery) throw new Error("任务不属于本次协作");
    return delivery;
  }

  private async taskResult(active: ActiveRun, id: string) {
    if(active.snapshot.experts){if(!active.snapshot.experts.participants.some(expert=>expert.id===id))throw new Error('专家不属于本次协作');return expertSummaryData(active.snapshot.id,active.snapshot.experts,this.repository);}
    const delivery = this.requireDelivery(active, id);
    const version = delivery.versions.at(-1);
    return { ...delivery, deliveryId: delivery.id, contextRequests: active.messages.pending(delivery.id), ...(version ? { report: (await this.repository.readReport(active.snapshot.id, version)).text } : {}) };
  }

  private async wait(active: ActiveRun, ids: string[]) {
    const deliveries = ids.map((id) => this.requireDelivery(active, id));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = active.messages.watch();
    let abortListener: () => void;
    const stopped = new Promise<void>((resolve) => { abortListener = () => resolve(); active.executor.abort.signal.addEventListener("abort", abortListener, { once: true }); });
    try {
      if (!active.messages.pending().length && !active.executor.abort.signal.aborted) await Promise.race([stopped, wake.promise, Promise.all(ids.map((id) => active.jobs.get(id))), new Promise<void>((resolve) => { timer = setTimeout(resolve, WAIT_TOOL_MS); })]);
      return deliveries.map((delivery) => ({ taskId: delivery.id, status: delivery.status, needsInput: active.messages.pending(delivery.id), pending: ["queued", "executing", "reviewing", "revising"].includes(delivery.status) }));
    } finally { active.executor.abort.signal.removeEventListener("abort", abortListener!); wake.dispose(); if (timer) clearTimeout(timer); }
  }

  private recovered(snapshot: CollaborationSnapshot): CollaborationSnapshot {
    if (!["running", "stopping"].includes(snapshot.status)) return snapshot;
    for(const target of codeCandidates(snapshot))if(target.code.phase==='validation'||snapshot.tasks.some(task=>task.deliveryId===target.deliveryId&&task.status==='running'))target.code.stopUnconfirmed=true;
    for(const expert of snapshot.experts?.participants??[])if(expert.status==='researching')expert.status='interrupted';
    for(const review of snapshot.experts?.reviews??[])if(review.status==='reviewing')review.status='interrupted';
    return { ...snapshot, ...(snapshot.code && snapshot.code.phase === "validation" ? { code: { ...snapshot.code, stopUnconfirmed: true } } : {}), status: "interrupted", stage: "finished", error: "应用重启，原执行状态未知；未自动重跑", tasks: snapshot.tasks.map((task) => task.status === "running" ? { ...task, status: "interrupted" } : task), deliveries: snapshot.deliveries.map((delivery) => ["queued", "executing", "reviewing", "revising"].includes(delivery.status) ? { ...delivery, status: "interrupted" } : delivery) };
  }
}
