// 普通聊天与协作共用执行入口；等待只消费可信 turnOutcome，不观察展示状态。
import { randomUUID } from "node:crypto";
import type { ChatSendParams, AgentKind } from "../../shared/types.js";
import type { TurnOutcome } from "../../shared/collaboration.js";
import type { AgentSendParams } from "../agents/types.js";
import type { ResearchRuntime } from "./researchRuntime.js";

export interface SessionExecutionHost {
  prepare(params: ChatSendParams): Promise<ChatSendParams>;
  send(params: AgentSendParams): Promise<{ sessionKey: string }>;
  interrupt(sessionKey: string): Promise<void>;
  failedToSend(sessionKey: string): void;
  finishedSending(sessionKey: string): void;
}

const CANCEL_ACK_TIMEOUT_MS = 30_000;

interface PendingExecution {
  sessionKey: string;
  resolve(result: TurnOutcome): void;
  reject(error: Error): void;
}

export class SessionExecutionService {
  private readonly pending = new Map<string, PendingExecution>();
  private readonly busy = new Set<string>();
  private readonly reservations = new Map<string, string>();
  private readonly ordinaryTurns = new Map<string, string>();
  private readonly unconfirmed = new Map<string, string>();
  private readonly sessionIdentities = new Map<string, string>();
  private readonly nativeBusy = new Map<string, string>();
  private readonly nativeByTurn = new Map<string, string>();
  private readonly nativeReservations = new Map<string, string>();
  private readonly reservationAliases = new Map<string, string>();

  constructor(private readonly host: SessionExecutionHost) {}

  /** 普通消息在被 Provider 接受后返回；保留原有附件、Git 与用量生命周期。 */
  async send(params: ChatSendParams) {
    const identity = this.identity(params);
    if (this.reservations.has(params.sessionKey) || identity && this.nativeReservations.has(identity)) throw new Error("该会话正在协作，请先停止协作后再发送普通消息");
    if (this.busy.has(params.sessionKey) || identity && this.nativeBusy.has(identity)) throw new Error("该会话仍有活动回合或原生中断未确认");
    const id = randomUUID();
    const tracked = params.agent === "claude" || params.agent === "codex" || params.agent === "agy";
    if (tracked) { this.busy.add(params.sessionKey); this.ordinaryTurns.set(id, params.sessionKey); this.trackNative(id, identity); }
    try { return await this.dispatch(params, id); }
    catch (error) { if (tracked) { this.ordinaryTurns.delete(id); this.busy.delete(params.sessionKey); this.releaseNative(id); } throw error; }
  }

  reserve(sessionKey: string, ownerId: string, nativeIdentity = this.sessionIdentities.get(sessionKey)) {
    if (this.busy.has(sessionKey) || this.reservations.has(sessionKey) || nativeIdentity && (this.nativeBusy.has(nativeIdentity) || this.nativeReservations.has(nativeIdentity))) throw new Error("会话已有活动回合或协作");
    this.reservations.set(sessionKey, ownerId);
    if (nativeIdentity) { this.nativeReservations.set(nativeIdentity, ownerId); this.reservationAliases.set(sessionKey, nativeIdentity); }
  }

  reservationOwner(sessionKey: string) {
    const identity = this.sessionIdentities.get(sessionKey);
    return this.reservations.get(sessionKey) ?? (identity ? this.nativeReservations.get(identity) : undefined);
  }
  isReserved(sessionKey: string) { return this.reservationOwner(sessionKey) !== undefined; }

  assertIdle(sessionKey: string) {
    if (this.busy.has(sessionKey)) throw new Error("会话仍有活动回合或原生停止状态未知，不能接管或续跑");
  }

  release(sessionKey: string, ownerId: string) {
    if (this.reservations.get(sessionKey) !== ownerId) return;
    this.reservations.delete(sessionKey);
    const identity = this.reservationAliases.get(sessionKey);
    if (identity && this.nativeReservations.get(identity) === ownerId) this.nativeReservations.delete(identity);
    this.reservationAliases.delete(sessionKey);
  }

  /** 只用原生事件绑定身份，不从展示状态推断回合终态或释放锁。 */
  observeIdentity(sessionKey: string, agent: AgentKind, nativeId: string) {
    const identity = `${agent}:${nativeId}`;
    this.sessionIdentities.set(sessionKey, identity);
    const owner = this.reservations.get(sessionKey);
    if (owner) { this.nativeReservations.set(identity, owner); this.reservationAliases.set(sessionKey, identity); }
    const pending = [...this.pending.entries()].find(([, entry]) => entry.sessionKey === sessionKey)?.[0] ?? [...this.ordinaryTurns.entries()].find(([, key]) => key === sessionKey)?.[0];
    if (pending) this.trackNative(pending, identity);
  }

  private identity(params: ChatSendParams) { return params.resumeSessionId ? `${params.agent}:${params.resumeSessionId}` : this.sessionIdentities.get(params.sessionKey); }
  private trackNative(turnId: string, identity?: string) { if (identity) { this.nativeBusy.set(identity, turnId); this.nativeByTurn.set(turnId, identity); } }
  private releaseNative(turnId: string) {
    const identity = this.nativeByTurn.get(turnId);
    if (identity && this.nativeBusy.get(identity) === turnId) this.nativeBusy.delete(identity);
    this.nativeByTurn.delete(turnId);
  }

  /** 先登记等待，再发送；即便 CLI 同步返回终态也不会丢结果。 */
  async execute(params: ChatSendParams, research: ResearchRuntime, signal: AbortSignal): Promise<TurnOutcome> {
    if (signal.aborted) throw new Error("执行已取消");
    const identity = this.identity(params);
    if (this.busy.has(params.sessionKey) || identity && this.nativeBusy.has(identity)) throw new Error("该会话已有活动执行回合");
    this.busy.add(params.sessionKey);
    const executionTurnId = randomUUID();
    this.trackNative(executionTurnId, identity);
    const result = new Promise<TurnOutcome>((resolve, reject) => this.pending.set(executionTurnId, { sessionKey: params.sessionKey, resolve, reject }));
    // 发送前错误也可能发生；立即登记拒绝处理避免未处理的 Promise rejection。
    const observed = result.then((value) => ({ value }), (error: Error) => ({ error }));
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    const uncertain = (reason: string) => {
      if (!this.pending.has(executionTurnId)) return;
      this.unconfirmed.set(executionTurnId, params.sessionKey);
      this.pending.get(executionTurnId)?.reject(new Error(`未收到原生中断确认：${reason}；保留会话锁，不标记为已停止`));
    };
    const cancel = () => {
      if (!this.pending.has(executionTurnId)) return;
      if (!cancellationTimer) cancellationTimer = setTimeout(() => uncertain("等待超过 30 秒"), CANCEL_ACK_TIMEOUT_MS);
      void this.host.interrupt(params.sessionKey).catch((error: unknown) => uncertain(String(error)));
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await this.dispatch(params, executionTurnId, research);
      if (signal.aborted) cancel();
      const settled = await observed;
      if ("error" in settled) throw settled.error;
      return settled.value;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      this.pending.delete(executionTurnId);
      if (this.unconfirmed.get(executionTurnId) !== params.sessionKey) { this.busy.delete(params.sessionKey); this.releaseNative(executionTurnId); }
    }
  }

  acceptOutcome(event: TurnOutcome) {
    const recognized = this.ordinaryTurns.get(event.executionTurnId) === event.sessionKey || this.unconfirmed.get(event.executionTurnId) === event.sessionKey || this.pending.get(event.executionTurnId)?.sessionKey === event.sessionKey;
    if (recognized && event.nativeSessionId) this.observeIdentity(event.sessionKey, event.agent, event.nativeSessionId);
    if (recognized) this.releaseNative(event.executionTurnId);
    if (this.ordinaryTurns.get(event.executionTurnId) === event.sessionKey) { this.ordinaryTurns.delete(event.executionTurnId); this.busy.delete(event.sessionKey); }
    if (this.unconfirmed.get(event.executionTurnId) === event.sessionKey) { this.unconfirmed.delete(event.executionTurnId); this.busy.delete(event.sessionKey); }
    const pending = this.pending.get(event.executionTurnId);
    if (pending?.sessionKey === event.sessionKey) { this.pending.delete(event.executionTurnId); pending.resolve(event); }
  }

  private async dispatch(params: ChatSendParams, executionTurnId: string, research?: ResearchRuntime) {
    try {
      const prepared = await this.host.prepare(params);
      return await this.host.send({ ...prepared, executionTurnId, research });
    } catch (error) {
      this.host.failedToSend(params.sessionKey);
      throw error;
    } finally {
      this.host.finishedSending(params.sessionKey);
    }
  }
}
