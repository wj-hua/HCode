// 用户操作在可信回合边界生效；续跑保留历史/预算并复核证据，绝不自动扩大权限。
import { codeCandidates, deliveryCode } from '../../shared/codeCandidates.js';
import { z } from "zod";
import type { CollaborationResumeParams, DeliverySnapshot } from "../../shared/collaboration.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { SessionExecutionService } from "../sessions/sessionExecutionService.js";
import type { ActiveRun } from "./activeRun.js";
import type { CollaborationRepository } from "./collaborationRepository.js";
import { MAX_RUN_TURNS, resumeSchema } from "./contracts.js";
import { RunExecutor } from "./runExecutor.js";
import { assertEvidenceCurrent } from "./reportEvidence.js";

import type { WorkspaceService } from "./workspaces/workspaceService.js";
interface ControlHost {
  workspaces?: WorkspaceService;
  exclusive<T>(id:string,action:()=>Promise<T>):Promise<T>;
  repository: CollaborationRepository;
  execution: SessionExecutionService;
  agents: AgentRegistry;
  active(id: string): Promise<ActiveRun>;
  changed(active: ActiveRun): Promise<void>;
  continue(active: ActiveRun, params: CollaborationResumeParams): void;
}

import { adoptionBlocksEdits, adoptionNeedsRecovery } from "../../shared/codeAdoption.js";
export class RunControls {
  constructor(private readonly host: ControlHost) {}

  /** stopping 先持久化；paused/cancelled 由调度器确认活动回合停止后落盘。 */
  async stop(id: string, intent: "pause" | "cancel") {
    return this.host.exclusive(id,()=>this.stopRun(id,intent));
  }
  private async stopRun(id:string,intent:"pause"|"cancel") {
    const active = await this.host.active(id);
    const snapshot = active.snapshot;
    if (!["running", "stopping"].includes(snapshot.status)) {
      if (intent === "pause") throw new Error("当前协作不在运行中");
      if (snapshot.status === "completed") throw new Error("协作已完成");
      snapshot.status = "cancelled";
      for (const delivery of snapshot.deliveries.filter((entry) => entry.status !== "accepted")) delivery.status = "cancelled";
      await this.host.changed(active);
      return;
    }
    if (snapshot.stopIntent === "cancel" && intent === "pause") throw new Error("取消已请求，不能转成暂停");
    snapshot.stopIntent = intent;
    snapshot.status = "stopping";
    try { await this.host.changed(active); }
    finally { active.executor.abort.abort(); }
  }

  private delivery(active: ActiveRun, id: string) {
    const delivery = active.snapshot.deliveries.find((entry) => entry.id === z.string().uuid().parse(id));
    if (!delivery) throw new Error("任务不属于本次协作");
    return delivery;
  }

  async cancelDelivery(id: string, deliveryId: string) {
    return this.host.exclusive(id,()=>this.cancelRunDelivery(id,deliveryId));
  }
  private async cancelRunDelivery(id:string,deliveryId:string) {
    const active = await this.host.active(id);
    const delivery = this.delivery(active, deliveryId);
    if (delivery.status === "accepted") throw new Error("报告已接受，不能取消已完成交付");
    if (active.snapshot.status === "stopping") throw new Error("正在等待本次协作停止确认");
    if (active.snapshot.status === "running" && ["queued", "executing", "reviewing", "revising"].includes(delivery.status)) {
      delivery.error = "用户请求停止此任务，等待原生确认";
      active.executor.cancelDelivery(delivery.id);
    } else delivery.status = "cancelled";
    await this.host.changed(active);
  }

  async reply(id: string, messageId: string, text: string) {
    return this.host.exclusive(id, async () => {
      const active = await this.host.active(id);
      if (["cancelled", "completed", "stopping"].includes(active.snapshot.status)) throw new Error("当前协作不能接收回复");
      await active.messages.reply(z.string().uuid().parse(messageId), text, "user");
    });
  }

  /** 资料只保存到指定交付或专家的消息记录；不会派发模型或改写目标/权限。 */
  async supplement(id: string, targetId: string, text: string) {
    return this.host.exclusive(id, async () => {
      const active = await this.host.active(id), snapshot = active.snapshot;
      if (["running", "stopping", "cancelled"].includes(snapshot.status)) throw new Error("请先等待协作结束或确认暂停，再保存资料");
      await active.done;
      const target = z.string().uuid().parse(targetId);
      const expert = snapshot.experts?.participants.find(entry => entry.id === target);
      const delivery = snapshot.deliveries.find(entry => entry.id === target);
      if (!expert && !delivery) throw new Error("资料目标不属于本次协作");
      const code = delivery && deliveryCode(snapshot, delivery);
      if (delivery?.status === "cancelled" || code?.workspace.state === "discarded" || adoptionBlocksEdits(code?.adoption)) throw new Error("此任务已停止、丢弃或采纳，不能补充执行资料");
      await active.messages.supplement(target, text);
      // 新资料不能被上一轮汇总冒充已核对；冻结报告与原生历史仍完整保留。
      if (!snapshot.summary && !snapshot.experts?.summary && delivery?.status !== "accepted") return;
      delete snapshot.summary;
      if (snapshot.experts) delete snapshot.experts.summary;
      if (delivery?.status === "accepted") {
        delivery.status = "awaitingUser";
        delivery.error = "补充资料尚未纳入此报告，请选择重新调研 / 修订或审查";
      }
      if (snapshot.status !== "paused") snapshot.status = "awaitingUser";
      snapshot.error = "已保存新资料，旧汇总已失效；报告和审查历史保留，请明确选择续跑";
      await this.host.changed(active);
    });
  }

  /** 仅原生确认暂停且源会话已完成恢复时提供接管；请求停止不等于已停止。 */
  async takeover(id: string) {
    return this.host.exclusive(id, async () => {
      const active = await this.host.active(id);
      if (active.snapshot.status !== "paused") throw new Error("请先暂停并等待原生停止确认，再接管原会话");
      await active.done;
      if (active.snapshot.status !== "paused") throw new Error("恢复原会话失败，不能确认接管");
      if (codeCandidates(active.snapshot).some(({ code }) => adoptionNeedsRecovery(code.adoption))) throw new Error("请先恢复原项目的未完成采纳，再接管原会话");
      for (const task of active.snapshot.tasks) this.host.execution.assertIdle(task.sessionKey);
      if (codeCandidates(active.snapshot).some(({ code }) => code.stopUnconfirmed)) throw new Error("候选停止未确认，不能接管");
      this.host.execution.assertIdle(active.snapshot.params.initiator.sessionKey);
    });
  }

  /** 核对本进程迟到终态并恢复源会话；磁盘恢复为 interrupted，不能凭空确认停止。 */
  async refreshStop(id: string) {
    return this.host.exclusive(id, async () => {
      const active = await this.host.active(id), snapshot = active.snapshot;
      if (snapshot.status !== "stopping" || snapshot.stage !== "finished") return;
      await active.done;
      if (codeCandidates(snapshot).some(({ code }) => code.stopUnconfirmed)) return;
      if (!snapshot.tasks.every(task => this.host.execution.isIdle(task.sessionKey))) return;
      const source = snapshot.params.initiator;
      if (this.host.agents.get(source.agent).hasSession(source.sessionKey)) await this.host.agents.get(source.agent).endResearch?.(source.sessionKey, source.permissionMode);
      snapshot.status = snapshot.stopIntent === "pause" ? "paused" : "cancelled";
      snapshot.error = "原生迟到终态已确认；旧错误和回合记录保留，未自动续跑";
      await this.host.changed(active);
    });
  }

  /** 只重跑用户指定的交付；旧意见/旧版本保留，硬预算累计不重置。 */
  async resume(id: string, input: CollaborationResumeParams) {
    return this.host.exclusive(id,()=>this.resumeRun(id,input));
  }
  private async resumeRun(id:string,input:CollaborationResumeParams) {
    const params = resumeSchema.parse(input);
    const active = await this.host.active(id);
    if (["running", "stopping", "cancelled"].includes(active.snapshot.status)) throw new Error("请先暂停或等待活动回合结束");
    await active.done;
    const snapshot = active.snapshot;
    if(codeCandidates(snapshot).some(({code})=>adoptionNeedsRecovery(code.adoption)))throw new Error('请先恢复原项目的未完成采纳，再续跑 AI');
    if(snapshot.experts)throw new Error("专家流程请使用专家续跑操作");
    const targets = params.deliveryId ? [this.delivery(active, params.deliveryId)] : snapshot.deliveries.filter((entry) => entry.status !== "accepted" && entry.status !== "cancelled");
    for(const delivery of targets){
      const code=deliveryCode(snapshot,delivery);
      if(code&&this.host.workspaces?.isLeased(code.workspace.id))throw new Error("候选正在采纳或其他操作中");
      if(adoptionBlocksEdits(code?.adoption))throw new Error("候选已应用或采纳尚需恢复，不能重新执行");
      if(code?.workspace.state==='discarded'||code?.stopUnconfirmed)throw new Error("候选已丢弃或停止未确认，不能续跑");
    }
    if (!targets.length) throw new Error("没有需要续跑的交付，请选择具体任务");
    const requiredTurns = 1 + targets.length * (params.action === "review" ? 1 : 2);
    if (snapshot.tasks.length + requiredTurns > MAX_RUN_TURNS) throw new Error("累计回合预算不足；保留历史，需要另行决定预算，不自动加额度或换模型");
    for (const delivery of targets) {
      if (active.messages.pending(delivery.id).length) throw new Error("请先回答此任务的澄清问题");
      if (delivery.workerSessionKey) this.host.execution.assertIdle(delivery.workerSessionKey);
      if (params.action === "review") {
        try { await this.checkVersion(active, delivery); }
        catch (error) { await this.invalidate(active, delivery, error); throw error; }
      }
    }
    // 接管期间其他已接受报告也可能变化；不让旧通过结论污染最终汇总。
    for (const delivery of snapshot.deliveries.filter((entry) => entry.status === "accepted")) {
      if(adoptionBlocksEdits(deliveryCode(snapshot,delivery)?.adoption))continue;
      try { await this.checkVersion(active, delivery); }
      catch (error) { await this.invalidate(active, delivery, error); }
    }
    if (params.context) for (const delivery of targets) await active.messages.supplement(delivery.id, params.context);
    const nativeSource = snapshot.tasks.findLast((task) => task.sessionKey === snapshot.params.initiator.sessionKey && task.nativeSessionId)?.nativeSessionId;
    if (nativeSource) snapshot.params.initiator.resumeSessionId = nativeSource;
    this.host.execution.reserve(snapshot.params.initiator.sessionKey, snapshot.id, snapshot.params.initiator.resumeSessionId ? `${snapshot.params.initiator.agent}:${snapshot.params.initiator.resumeSessionId}` : undefined);
    active.executor = new RunExecutor(snapshot, new AbortController(), this.host.execution, () => this.host.changed(active));
    active.jobs.clear();
    snapshot.status = "running";
    snapshot.stage = "awaitingWorkers";
    delete snapshot.stopIntent;
    delete snapshot.error;
    delete snapshot.summary;
    try { await this.host.changed(active); }
    catch (error) { this.host.execution.release(snapshot.params.initiator.sessionKey, snapshot.id); snapshot.status = "failed"; snapshot.persistenceError = String(error); throw error; }
    this.host.continue(active, params);
  }

  private async invalidate(active: ActiveRun, delivery: DeliverySnapshot, error: unknown) {
    delivery.status = "awaitingUser";
    delivery.error = String(error);
    active.snapshot.status = "awaitingUser";
    active.snapshot.error = codeCandidates(active.snapshot).length ? "候选或报告变化，旧接受结果失效；请重新实现 / 修订后验证并送审" : "报告或源码变化，旧接受结果失效；请重新调研后送审";
    delete active.snapshot.summary;
    await this.host.changed(active);
  }

  private async checkVersion(active: ActiveRun, delivery: DeliverySnapshot) {
    const version = delivery.versions.at(-1);
    if (!version) throw new Error("没有报告可以重新审查，请选择重新执行");
    await this.host.repository.readReport(active.snapshot.id, version);
    const code=deliveryCode(active.snapshot,delivery);
    await assertEvidenceCurrent(code?.workspace.path ?? active.snapshot.params.initiator.projectPath, version.evidence);
    if (code) {
      const frozen = code.versions.at(-1);
      if (!frozen || !this.host.workspaces) throw new Error("没有候选代码版本可重新审查");
      await this.host.workspaces.assertCurrent(code.workspace, frozen);
    }
  }
}
