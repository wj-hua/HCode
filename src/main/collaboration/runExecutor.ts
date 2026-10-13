// 一个 Run 的执行并发与硬回合预算；主持不占工作者槽，取消排队项不会启动 CLI。
import { deliveryCode } from '../../shared/codeCandidates.js';
import { randomUUID } from "node:crypto";
import type { ChatSendParams } from "../../shared/types.js";
import type { CollaborationSnapshot, CollaborationTask, DeliverySnapshot, TurnOutcome, CollaborationBackend } from "../../shared/collaboration.js";
import { expertReservedTurns } from './experts/expertBudget.js';
import type { SessionExecutionService } from "../sessions/sessionExecutionService.js";
import type { HostedTool, ResearchRuntime } from "../sessions/researchRuntime.js";
import { MAX_CONCURRENT_WORKERS, MAX_RUN_TURNS, TURN_TIMEOUT_MS } from "./contracts.js";
interface ExpertTurnOptions {id:string;backend:CollaborationBackend;onStart?:()=>Promise<void>;}

class WorkerPool {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new Error("任务已取消");
    await new Promise<void>((resolve, reject) => {
      const enter = () => { signal.removeEventListener("abort", cancelled); this.active++; resolve(); };
      const cancelled = () => { const at = this.queue.indexOf(enter); if (at >= 0) this.queue.splice(at, 1); reject(new Error("排队任务已取消")); };
      if (this.active < MAX_CONCURRENT_WORKERS) enter();
      else { this.queue.push(enter); signal.addEventListener("abort", cancelled, { once: true }); }
    });
    let released = false;
    return () => { if (released) return; released = true; this.active--; this.queue.shift()?.(); };
  }
}

export class RunExecutor {
  private readonly workers = new WorkerPool();
  private readonly runtimes = new Map<string, ResearchRuntime>();
  private readonly deliveryAborts = new Map<string, AbortController>();
  private expertResearchStart: number | undefined;

  constructor(
    readonly snapshot: CollaborationSnapshot,
    readonly abort: AbortController,
    private readonly execution: SessionExecutionService,
    private readonly changed: () => Promise<void>,
  ) {}

  /** 每项执行预留首次审查和最终汇总；执行者不能消耗掉强制交付门槛。 */
  canAddDelivery() {
    const remaining = this.snapshot.deliveries.reduce((total, delivery) => total + this.remainingTurns(delivery), 1);
    return this.snapshot.tasks.length + remaining + 2 <= MAX_RUN_TURNS;
  }

  cancelDelivery(id: string) {
    let abort = this.deliveryAborts.get(id);
    if (!abort) { abort = new AbortController(); this.deliveryAborts.set(id, abort); }
    abort.abort();
  }

  deliverySignal(id: string) {
    let abort = this.deliveryAborts.get(id);
    if (!abort) { abort = new AbortController(); this.deliveryAborts.set(id, abort); }
    return AbortSignal.any([this.abort.signal, abort.signal]);
  }

  private remainingTurns(delivery: DeliverySnapshot) {
    if (delivery.status === "queued") return 2;
    const latest = this.snapshot.tasks.findLast(task => task.deliveryId === delivery.id);
    const active = this.snapshot.tasks.findLast((task) => task.deliveryId === delivery.id && task.status === "running");
    // 实现/审查回合结束后宿主仍在异步验证或保存；预留剩余阶段，不能再次计算已消耗回合。
    if (delivery.status === "executing" || delivery.status === "revising") return active?.role === "execution" || latest?.role === "execution" && latest.status === "succeeded" ? 1 : 2;
    if (delivery.status === "reviewing") return active?.role === "review" || latest?.role === "review" && latest.status === "succeeded" ? 0 : 1;
    return 0;
  }

  async execute(role: CollaborationTask["role"], key: string, text: string, schema?: Record<string, unknown>, delivery?: DeliverySnapshot, tools?: HostedTool[], expert?:ExpertTurnOptions): Promise<TurnOutcome> {
    if (this.abort.signal.aborted) throw new Error("协作已取消");
    let deliveryAbort: AbortController | undefined;
    if (delivery) { deliveryAbort = this.deliveryAborts.get(delivery.id); if (!deliveryAbort) { deliveryAbort = new AbortController(); this.deliveryAborts.set(delivery.id, deliveryAbort); } }
    const signal = AbortSignal.any([this.abort.signal, ...(deliveryAbort ? [deliveryAbort.signal] : []), AbortSignal.timeout(TURN_TIMEOUT_MS)]);
    const release = role === "execution" || role === "review" ? await this.workers.acquire(signal) : () => {};
    try { return await this.runTurn(role, key, text, schema, delivery, tools, signal, expert); }
    finally { release(); }
  }

  private async runTurn(role: CollaborationTask["role"], key: string, text: string, schema: Record<string, unknown> | undefined, delivery: DeliverySnapshot | undefined, tools: HostedTool[] | undefined, signal: AbortSignal, expert?:ExpertTurnOptions) {
    const summaryReserve = role === "synthesis" ? 0 : 1;
    const reviewReserve = role === "execution" ? 1 : 0;
    const otherDeliveries = this.snapshot.deliveries.filter((entry) => entry.id !== delivery?.id).reduce((total, entry) => total + this.remainingTurns(entry), 0);
    if(this.snapshot.experts&&this.snapshot.stage==='expertResearch'&&this.expertResearchStart===undefined)this.expertResearchStart=this.snapshot.tasks.length;
    const reserved=this.snapshot.experts?expertReservedTurns(this.snapshot,expert?.id,key,this.expertResearchStart):summaryReserve+reviewReserve+otherDeliveries;
    if (this.snapshot.tasks.length + 1 + reserved > (this.snapshot.experts?.turnLimit ?? MAX_RUN_TURNS)) throw new Error("协作回合预算不足；为其他交付的强制审查和最终汇总保留回合，请人工处理");
    const initiator = this.snapshot.params.initiator;
    const configuredReviewer='reviewer' in this.snapshot.params?this.snapshot.params.reviewer:undefined;
    const backend = expert?.backend ?? (role === "execution" ? delivery!.executor : role === "review" && configuredReviewer ? configuredReviewer : { agent: initiator.agent as "claude" | "codex", model: initiator.model });
    const { agent, model } = backend;
    const task: CollaborationTask = { id: randomUUID(), sessionKey: key, agent, role, status: "running", ...(delivery ? { deliveryId: delivery.id } : {}), ...(expert?{expertId:expert.id}:{}), ...(model ? { model } : {}) };
    this.snapshot.tasks.push(task);
    await this.changed();
    const nativeSessionId = this.snapshot.tasks.findLast((entry) => entry.sessionKey === key && entry.nativeSessionId)?.nativeSessionId;
    const root = delivery ? deliveryCode(this.snapshot,delivery)?.workspace.path ?? initiator.projectPath : initiator.projectPath;
    const params: ChatSendParams = { ...initiator, projectPath: root, sessionKey: key, agent, text, permissionMode: agent === "claude" ? "default" : "read-only", ...(model ? { model } : { model: undefined }), ...(role === "planning" || role === "synthesis" ? {} : { resumeSessionId: nativeSessionId, effort: undefined }) };
    let runtime = this.runtimes.get(key);
    if (!runtime) { runtime = { root, tools, outputSchema: schema }; this.runtimes.set(key, runtime); }
    runtime.outputSchema=schema;
    let result: TurnOutcome;
    try { await expert?.onStart?.(); result = await this.execution.execute(params, runtime, signal); }
    catch (error) { result = { sessionKey: key, agent, executionTurnId: randomUUID(), outcome: signal.aborted ? "interrupted" : "failed", text: "", error: error instanceof Error ? error.message : String(error) }; }
    if (signal.aborted && result.outcome === "succeeded") result = { ...result, outcome: "cancelled", error: "协作已取消或回合超时" };
    task.status = result.outcome;
    if (result.nativeSessionId) task.nativeSessionId = result.nativeSessionId;
    if (result.error) task.error = result.error;
    if (result.usage) task.usage = result.usage;
    await this.changed();
    return result;
  }
}
