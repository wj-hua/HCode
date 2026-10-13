// 用户明确选择重研、复审或排除失败专家；预算与原生会话身份累计保留。
import type {
  ExpertResumeParams,
  ExpertSelection,
} from "../../../shared/experts.js";
import type { CollaborationSource } from "../../../shared/collaboration.js";
import type { ActiveRun } from "../activeRun.js";
import type { CollaborationRepository } from "../collaborationRepository.js";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import { MAX_RUN_TURNS } from "../contracts.js";
import { RunExecutor } from "../runExecutor.js";
import { assertEvidenceCurrent } from "../reportEvidence.js";
import { EXPERT_LIMITS } from "../../../shared/experts.js";
import { expertResumeSchema } from "./expertContracts.js";
import type {ExpertProfileService} from "./profiles/expertProfileService.js";
interface ExpertControlHost {
  exclusive<T>(id: string, action: () => Promise<T>): Promise<T>;
  profiles:ExpertProfileService;
  execution: SessionExecutionService;
  repository: CollaborationRepository;
  active(id: string): Promise<ActiveRun>;
  assertSource(
    source: CollaborationSource,
    experts: ExpertSelection[],
  ): Promise<void>;
  changed(active: ActiveRun): Promise<void>;
  continue(active: ActiveRun, params: ExpertResumeParams): void;
}
export class ExpertControls {
  constructor(private readonly host: ExpertControlHost) {}
  /** 续跑先核对原生空闲、预算和冻结报告；原文与旧版本不清空。 */
  async resume(id: string, input: ExpertResumeParams) {
    return this.host.exclusive(id, () => this.resumeRun(id, input));
  }
  private async resumeRun(id: string, input: ExpertResumeParams) {
    const params = expertResumeSchema.parse(input),
      active = await this.host.active(id),
      snapshot = active.snapshot,
      state = snapshot.experts;
    if (!state) throw new Error("此任务不是专家流程");
    if (["running", "stopping", "cancelled"].includes(snapshot.status))
      throw new Error("请先等待活动回合停止；取消的流程不能续跑");
    await active.done;
    for (const task of snapshot.tasks)
      this.host.execution.assertIdle(task.sessionKey);
    const targets =
      params.action === "research"
        ? state.participants.filter(
            (expert) => !params.expertId || expert.id === params.expertId,
          )
        : [];
    if (params.action === "research" && !targets.length)
      throw new Error("专家不属于本次协作");
    const activeIds =
      params.action === "research"
        ? state.participants.map((expert) => expert.id)
        : params.action === "continuePartial"
          ? state.participants
              .filter(
                (expert) =>
                  expert.status === "reported" && expert.versions.length,
              )
              .map((expert) => expert.id)
          : state.activeIds;
    if (activeIds.length < EXPERT_LIMITS.minParticipants)
      throw new Error("至少两份有效报告才能互审");
    if (
      params.action === "continuePartial" &&
      activeIds.length === state.participants.length
    )
      throw new Error("所有专家均已产出报告，无需排除专家");
    const requiredTurns = activeIds.length + 1 + targets.length;
    if (snapshot.tasks.length + requiredTurns > (state.turnLimit ?? MAX_RUN_TURNS))
      throw new Error("累计回合预算不足，不自动加额度或换模型");
    try {
      for(const expert of state.participants.filter(entry=>activeIds.includes(entry.id)))if(expert.profile)await this.host.profiles.packet(snapshot.id,expert.profile);
      for (const expert of state.participants.filter(
        (entry) => activeIds.includes(entry.id) && !targets.includes(entry),
      )) {
        const version = expert.versions.at(-1);
        if (!version) throw new Error("专家缺少可复审报告，请先重新研究");
        await this.host.repository.readReport(snapshot.id, version);
        await assertEvidenceCurrent(
          snapshot.params.initiator.projectPath,
          version.evidence,
        );
      }
    } catch (error) {
      snapshot.status = "awaitingUser";
      snapshot.error = `冻结配置、源码或报告校验失败，旧汇总失效：${String(error)}`;
      delete state.summary;
      delete snapshot.summary;
      await this.host.changed(active);
      throw error;
    }
    const source = snapshot.params.initiator;
    source.resumeSessionId =
      snapshot.tasks.findLast(
        (task) => task.sessionKey === source.sessionKey && task.nativeSessionId,
      )?.nativeSessionId ?? source.resumeSessionId;
    await this.host.assertSource(
      {
        agent: source.agent,
        ...(source.resumeSessionId
          ? { resumeSessionId: source.resumeSessionId }
          : {}),
      },
      state.participants.filter((expert) => activeIds.includes(expert.id)),
    );
    this.host.execution.reserve(
      source.sessionKey,
      snapshot.id,
      source.resumeSessionId
        ? `${source.agent}:${source.resumeSessionId}`
        : undefined,
    );
    active.executor = new RunExecutor(
      snapshot,
      new AbortController(),
      this.host.execution,
      () => this.host.changed(active),
    );
    active.jobs.clear();
    state.activeIds = activeIds;
    if (params.action === "research") state.partialAuthorized = false;
    if (params.action === "continuePartial") state.partialAuthorized = true;
    for (const expert of targets) {
      expert.status = "queued";
      delete expert.error;
    }
    for (const review of state.reviews)
      if (["queued", "reviewing"].includes(review.status))
        review.status = "interrupted";
    delete state.summary;
    delete snapshot.summary;
    delete snapshot.error;
    delete snapshot.stopIntent;
    snapshot.status = "running";
    snapshot.stage =
      params.action === "research" ? "expertResearch" : "peerReview";
    try {
      await this.host.changed(active);
    } catch (error) {
      this.host.execution.release(source.sessionKey, snapshot.id);
      snapshot.status = "failed";
      snapshot.persistenceError = String(error);
      throw error;
    }
    this.host.continue(active, params);
  }
}
