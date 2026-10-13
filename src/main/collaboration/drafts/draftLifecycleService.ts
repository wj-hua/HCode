// 只读、专家与代码草案共用版本、停止确认、预算预留和幂等启动；分工规则由各自 Policy 管理。
import { realpath, stat } from "node:fs/promises";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { DraftRepository } from "./draftRepository.js";
import { assertEditable, assertRevision } from "./draftContracts.js";
import { RunOperations } from "../runOperations.js";
import { DraftPlanningCancelled } from "./draftPlanner.js";
import { readResearchFile } from "../../sessions/researchRuntime.js";
import { TURN_TIMEOUT_MS } from "../contracts.js";
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
import type { PlanningDraft } from "../../../shared/planningDraft.js";
import type { ApprovedResearchPlan } from "../../../shared/researchDraft.js";
import type { z } from "zod";

export interface DraftPolicy<T extends PlanningDraft, Input, Edit> {
  create(input: Input): Promise<T>;
  edit(draft: T, input: Edit): void;
  admit(draft: T, phase: "planning" | "confirmation"): Promise<void>;
  plan(draft: T, save: () => Promise<void>, signal: AbortSignal): Promise<void>;
  plannedStatus(draft: T): "ready" | "editing";
  budget(draft: T): { limit: number; remaining: number };
  hash(draft: T): string;
  existing(approval: ApprovedResearchPlan): Promise<CollaborationSnapshot | undefined>;
  start(draft: T, approval: ApprovedResearchPlan): Promise<CollaborationSnapshot>;
}

export class DraftLifecycleService<T extends PlanningDraft, Input, Edit> {
  readonly repository: DraftRepository<T>;
  private readonly operations = new RunOperations();
  private readonly active = new Map<string, AbortController>();
  private readonly confirmations = new Map<string, { revision: number; result: Promise<CollaborationSnapshot> }>();
  constructor(root: string, schema: z.ZodType<T>, private readonly execution: SessionExecutionService, private readonly policy: DraftPolicy<T, Input, Edit>, private readonly emit?: (draft: T) => void) {
    this.repository = new DraftRepository(root, schema);
  }
  async create(input: Input): Promise<T> {
    const draft = await this.policy.create(input);
    draft.params.initiator.projectPath = await realpath(draft.params.initiator.projectPath);
    if (!(await stat(draft.params.initiator.projectPath)).isDirectory()) throw new Error("计划项目不是目录");
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
  async update(id: string, revision: number, input: Edit) {
    return this.operations.execute(id, async () => {
      const draft = await this.get(id);
      assertRevision(draft, revision); assertEditable(draft);
      this.policy.edit(draft, input);
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
      await this.policy.admit(draft, "planning");
      if (draft.turns.length + 1 + this.policy.budget(draft).remaining > this.policy.budget(draft).limit) throw new Error("规划预算不足，必须保留执行、独立审查和汇总回合");
      const source = draft.params.initiator;
      this.execution.reserve(source.sessionKey, id, source.resumeSessionId ? `${source.agent}:${source.resumeSessionId}` : undefined);
      const abort = new AbortController(); this.active.set(id, abort);
      draft.status = "preparing"; draft.revision++; delete draft.error;
      try {
        await this.policy.plan(draft, () => this.persist(draft), AbortSignal.any([abort.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)]));
        draft.status = this.policy.plannedStatus(draft);
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
      if (draft.status === "starting") {
        if (!draft.approvalHash || draft.approvalHash !== this.policy.hash(draft)) throw new Error("计划内容与确认凭据不一致，不能恢复");
        const existing = await this.policy.existing({ draftId: draft.id, revision, hash: draft.approvalHash });
        if (existing) {
          draft.status = "started"; draft.runId = existing.id;
          await this.persist(draft);
          return existing;
        }
      }
      if (draft.status !== "started") {
        await this.policy.admit(draft, "confirmation");
        for (const file of draft.sources) if ((await readResearchFile(draft.params.initiator.projectPath, file.path)).hash !== file.hash) throw new Error("计划引用的文件已变化，请重新生成并确认");
        if (draft.turns.length + this.policy.budget(draft).remaining > this.policy.budget(draft).limit) throw new Error("累计预算不足，不能开始协作");
        if (draft.status === "ready") {
          draft.approvalHash = this.policy.hash(draft); draft.status = "starting";
          await this.persist(draft);
        }
      }
      if (!draft.approvalHash) throw new Error("启动意图缺少确认凭据，不能执行");
      if (draft.approvalHash !== this.policy.hash(draft)) throw new Error("计划内容与确认凭据不一致，不能执行");
      const run = await this.policy.start(draft, { draftId: draft.id, revision, hash: draft.approvalHash });
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
  private async persist(draft: T) {
    await this.repository.save(draft);
    this.emit?.(structuredClone(draft));
  }
  dispose() { for (const abort of this.active.values()) abort.abort(); }
}
