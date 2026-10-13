// U0 只读草案的版本与生命周期；不通过创建 Run 模拟计划预览。
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { ResearchDraftInput, ResearchDraft, ResearchDraftEdit } from "../../../shared/researchDraft.js";
import type { CollaborationService } from "../collaborationService.js";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { DraftRepository } from "./draftRepository.js";
import { assertEditable, assertRevision, draftEditSchema, draftInputSchema } from "./draftContracts.js";
import { RunOperations } from "../runOperations.js";
import { DraftPlanner, DraftPlanningCancelled } from "./draftPlanner.js";
import { COLLABORATION_LIMITS } from "../../../shared/collaboration.js";
import { readResearchFile } from "../../sessions/researchRuntime.js";
import { draftHash } from "./draftContracts.js";
import { TURN_TIMEOUT_MS } from "../contracts.js";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";

export class ResearchDraftService {
  readonly repository: DraftRepository;
  private readonly operations = new RunOperations();
  private readonly active = new Map<string, AbortController>();
  private readonly confirmations = new Map<string, { revision: number; result: Promise<CollaborationSnapshot> }>();
  private readonly planner: DraftPlanner;
  constructor(root: string, private readonly collaboration: CollaborationService, private readonly execution: SessionExecutionService, agents: AgentRegistry, private readonly emit?: (draft: ResearchDraft) => void) {
    this.repository = new DraftRepository(root);
    this.planner = new DraftPlanner(execution, agents);
  }
  async create(input: ResearchDraftInput): Promise<ResearchDraft> {
    const params = draftInputSchema.parse(input);
    params.initiator.projectPath = await realpath(params.initiator.projectPath);
    if (!(await stat(params.initiator.projectPath)).isDirectory()) throw new Error("计划项目不是目录");
    const draft: ResearchDraft = { id: randomUUID(), revision: 1, createdAt: Date.now(), status: "editing", params, sources: [], turns: [] };
    await this.persist(draft);
    return draft;
  }
  async get(id: string) {
    const draft = await this.repository.load(id);
    if (draft.status === "preparing" && !this.active.has(id)) {
      draft.status = "blocked"; draft.error = "上次规划中断，原生停止状态未知；请核对原会话，本计划不会自动执行";
      for (const turn of draft.turns.filter(turn => turn.status === "running")) { turn.status = "interrupted"; turn.error = draft.error; }
    }
    return draft;
  }
  async list(sessionKey?: string, nativeSessionId?: string) {
    if (!sessionKey && !nativeSessionId) throw new Error("缺少草案查询的会话身份");
    const drafts = await this.repository.list();
    return Promise.all(drafts.filter(draft => draft.params.initiator.sessionKey === sessionKey || Boolean(nativeSessionId && draft.params.initiator.resumeSessionId === nativeSessionId)).sort((left, right) => right.createdAt - left.createdAt).map(draft => this.get(draft.id)));
  }
  async update(id: string, revision: number, input: ResearchDraftEdit) {
    return this.operations.execute(id, async () => {
      const draft = await this.get(id);
      assertRevision(draft, revision); assertEditable(draft);
      const edit = draftEditSchema.parse(input);
      draft.params = { ...draft.params, ...edit, reviewer: edit.reviewer };
      draft.revision++; delete draft.error;
      await this.persist(draft);
      return draft;
    });
  }
  async abandon(id: string, revision: number) {
    return this.operations.execute(id, async () => {
      const draft = await this.get(id);
      assertRevision(draft, revision); assertEditable(draft);
      draft.status = "abandoned"; draft.revision++;
      await this.persist(draft);
      return draft;
    });
  }
  /** 仅执行受限原生规划，持久化回合后才调用模型；未确认时不创建 Run。 */
  async prepare(id: string, revision: number) {
    return this.operations.execute(id, async () => {
      const draft = await this.get(id);
      assertRevision(draft, revision); assertEditable(draft);
      if (draft.turns.some(turn => turn.error?.includes("原生停止状态未知") || turn.error?.includes("未收到原生中断确认"))) throw new Error("原生停止状态未知，不能重新生成计划");
      await this.admit(draft);
      if (draft.turns.length + 4 > COLLABORATION_LIMITS.maxTurns) throw new Error("规划预算不足，必须保留执行、独立审查和汇总回合");
      const source = draft.params.initiator;
      this.execution.reserve(source.sessionKey, id, source.resumeSessionId ? `${source.agent}:${source.resumeSessionId}` : undefined);
      const abort = new AbortController(); this.active.set(id, abort);
      draft.status = "preparing"; draft.revision++; delete draft.error;
      try {
        await this.planner.generate(draft, () => this.persist(draft), AbortSignal.any([abort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]));
        draft.status = "ready";
      } catch (error) {
        draft.status = error instanceof DraftPlanningCancelled ? "cancelled" : "blocked"; draft.error = error instanceof Error ? error.message : String(error);
      }
      try {
        await this.persist(draft);
        return draft;
      } finally {
        this.active.delete(id); this.execution.release(source.sessionKey, id);
      }
    });
  }
  /** 同一确认等待同一 Promise；先落盘启动意图，再由固定 Run ID 恢复确认结果。 */
  async confirm(id: string, revision: number) {
    const pending = this.confirmations.get(id);
    if (pending) {
      if (pending.revision !== revision) throw new Error("计划版本与正在确认的版本不一致");
      return pending.result;
    }
    const result = this.operations.execute(id, async () => {
      const draft = await this.get(id);
      assertRevision(draft, revision);
      if (!["ready", "starting", "started"].includes(draft.status)) throw new Error("请先生成有效计划并查看启动条件");
      if (draft.status !== "started") {
        await this.admit(draft);
        for (const file of draft.sources) if ((await readResearchFile(draft.params.initiator.projectPath, file.path)).hash !== file.hash) throw new Error("计划引用的文件已变化，请重新生成并确认");
        if (draft.turns.length + 3 > COLLABORATION_LIMITS.maxTurns) throw new Error("累计预算不足，不能开始协作");
        if (draft.status === "ready") {
          draft.approvalHash = draftHash(draft); draft.status = "starting";
          await this.persist(draft);
        }
      }
      if (!draft.approvalHash) throw new Error("启动意图缺少确认凭据，不能执行");
      if (draft.approvalHash !== draftHash(draft)) throw new Error("计划内容与确认凭据不一致，不能执行");
      const run = await this.collaboration.startPrepared(draft.params, { draftId: draft.id, revision, hash: draft.approvalHash }, draft.turns);
      draft.status = "started"; draft.runId = run.id;
      await this.persist(draft);
      return run;
    });
    this.confirmations.set(id, { revision, result });
    try { return await result; }
    finally { this.confirmations.delete(id); }
  }
  cancel(id: string) {
    const abort = this.active.get(id);
    if (!abort) throw new Error("计划没有活动规划回合");
    abort.abort();
  }
  isPlanning(id: string) { return this.active.has(id); }
  private async persist(draft: ResearchDraft) {
    await this.repository.save(draft);
    this.emit?.(structuredClone(draft));
  }
  private async admit(draft: ResearchDraft) {
    const source = draft.params.initiator;
    const capabilities = await this.collaboration.capabilities({ agent: source.agent, ...(source.resumeSessionId ? { resumeSessionId: source.resumeSessionId } : {}) });
    const sourceCapability = capabilities.find(capability => capability.agent === source.agent);
    if (!sourceCapability?.canInitiate) throw new Error(sourceCapability?.reason ?? "当前会话不支持受限规划");
    for (const [backend, reviewing] of [[draft.params.executor, false], [draft.params.reviewer ?? source, true]] as const) {
      const capability = capabilities.find(entry => entry.agent === backend.agent);
      if (!(reviewing ? capability?.canReview : capability?.canExecute)) throw new Error("执行或审查 AI 未通过能力检查");
      if (backend.agent === "agy" && (!backend.model || !capability?.models?.some(model => model.value === backend.model))) throw new Error("请选择账号可用的 Gemini 模型");
    }
  }
  dispose() { for (const abort of this.active.values()) abort.abort(); }
}
