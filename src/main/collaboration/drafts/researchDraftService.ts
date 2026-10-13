// 只读草案的输入、执行后端准入和单项任务规划；生命周期与专家计划共享。
import { randomUUID } from "node:crypto";
import type { ResearchDraftInput, ResearchDraft, ResearchDraftEdit } from "../../../shared/researchDraft.js";
import type { CollaborationService } from "../collaborationService.js";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { draftInputSchema, draftEditSchema, draftSchema, draftHash } from "./draftContracts.js";
import { DraftLifecycleService, type DraftPolicy } from "./draftLifecycleService.js";
import { DraftPlanner } from "./draftPlanner.js";
import { COLLABORATION_LIMITS } from "../../../shared/collaboration.js";

class ResearchPolicy implements DraftPolicy<ResearchDraft, ResearchDraftInput, ResearchDraftEdit> {
  private readonly planner: DraftPlanner;
  constructor(private readonly collaboration: CollaborationService, execution: SessionExecutionService, agents: AgentRegistry) { this.planner = new DraftPlanner(execution, agents); }
  async create(input: ResearchDraftInput): Promise<ResearchDraft> {
    return { id: randomUUID(), revision: 1, createdAt: Date.now(), status: "editing", params: draftInputSchema.parse(input), sources: [], turns: [] };
  }
  edit(draft: ResearchDraft, input: ResearchDraftEdit) {
    const edit = draftEditSchema.parse(input);
    draft.params = { ...draft.params, ...edit, reviewer: edit.reviewer };
  }
  plan(draft: ResearchDraft, save: () => Promise<void>, signal: AbortSignal) { return this.planner.generate(draft, save, signal); }
  plannedStatus(): "ready" { return "ready"; }
  budget() { return { limit: COLLABORATION_LIMITS.maxTurns, remaining: 3 }; }
  hash = draftHash;
  existing(approval: Parameters<CollaborationService["getApprovedPlan"]>[0]) { return this.collaboration.getApprovedPlan(approval); }
  start(draft: ResearchDraft, approval: Parameters<CollaborationService["startPrepared"]>[1]) { return this.collaboration.startPrepared(draft.params, approval, draft.turns); }
  async admit(draft: ResearchDraft) {
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
}

export class ResearchDraftService extends DraftLifecycleService<ResearchDraft, ResearchDraftInput, ResearchDraftEdit> {
  constructor(root: string, collaboration: CollaborationService, execution: SessionExecutionService, agents: AgentRegistry, emit?: (draft: ResearchDraft) => void) {
    super(root, draftSchema, execution, new ResearchPolicy(collaboration, execution, agents), emit);
  }
}
