// 管理一个会话的当前执行关联与一次性终态；Provider 只提供原生结果，不用 idle 推断成功。
import type { AgentKind } from "../../shared/types.js";
import type { TurnOutcome } from "../../shared/collaboration.js";

type NativeOutcome = Omit<TurnOutcome, "sessionKey" | "agent" | "executionTurnId">;

export class TurnLifecycle {
  private active: { executionTurnId: string; nativeTurnId?: string; cancelling: boolean } | null = null;

  constructor(
    private readonly sessionKey: string,
    private readonly agent: AgentKind,
    private readonly emit: (event: TurnOutcome) => void,
  ) {}

  /** 必须在发给 CLI 前调用；禁止并行输入覆盖该会话的终态归属。 */
  begin(executionTurnId: string) {
    if (this.active) throw new Error("会话仍在运行，不能覆盖执行回合");
    this.active = { executionTurnId, cancelling: false };
  }

  bindNativeTurn(nativeTurnId: string) {
    if (this.active) this.active.nativeTurnId = nativeTurnId;
  }

  requestCancellation() {
    if (this.active) this.active.cancelling = true;
  }

  /** 重复或过期原生结果不产生新终态；取消只在收到可信结束信号后落为终态。 */
  finish(result: NativeOutcome) {
    const active = this.active;
    if (!active) return;
    if (active.nativeTurnId && result.nativeTurnId && active.nativeTurnId !== result.nativeTurnId) return;
    this.active = null;
    this.emit({
      ...result,
      sessionKey: this.sessionKey,
      agent: this.agent,
      executionTurnId: active.executionTurnId,
      outcome: active.cancelling ? "cancelled" : result.outcome,
    });
  }
}
