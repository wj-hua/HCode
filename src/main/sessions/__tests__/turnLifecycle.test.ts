// 从会话执行边界验证真实终态：界面空闲、重复结果和取消竞争不能产生假成功。
import { describe, expect, it } from "vitest";
import { TurnLifecycle } from "../turnLifecycle.js";
import type { TurnOutcome } from "../../../shared/collaboration.js";

function setup() {
  const outcomes: TurnOutcome[] = [];
  const lifecycle = new TurnLifecycle("session", "codex", (event) => outcomes.push(event));
  return { lifecycle, outcomes };
}

describe("原生回合终态", () => {
  it("发送前建立关联，早到和重复结果只回报一次", () => {
    const { lifecycle, outcomes } = setup();
    lifecycle.begin("execution-1");
    lifecycle.finish({ outcome: "succeeded", text: "report", nativeTurnId: "native-1" });
    lifecycle.finish({ outcome: "succeeded", text: "duplicate", nativeTurnId: "native-1" });
    expect(outcomes).toEqual([expect.objectContaining({ executionTurnId: "execution-1", text: "report", outcome: "succeeded" })]);
  });

  it("先接受取消，迟到的成功不能覆盖取消", () => {
    const { lifecycle, outcomes } = setup();
    lifecycle.begin("execution-1");
    lifecycle.requestCancellation();
    lifecycle.finish({ outcome: "succeeded", text: "late" });
    expect(outcomes[0]?.outcome).toBe("cancelled");
  });

  it("上一原生回合的迟到结果不能完成新的回合", () => {
    const { lifecycle, outcomes } = setup();
    lifecycle.begin("execution-1");
    lifecycle.bindNativeTurn("native-1");
    lifecycle.finish({ outcome: "failed", text: "", nativeTurnId: "native-1", error: "failure" });
    lifecycle.begin("execution-2");
    lifecycle.bindNativeTurn("native-2");
    lifecycle.finish({ outcome: "succeeded", text: "old", nativeTurnId: "native-1" });
    expect(outcomes).toHaveLength(1);
    lifecycle.finish({ outcome: "succeeded", text: "new", nativeTurnId: "native-2" });
    expect(outcomes[1]?.executionTurnId).toBe("execution-2");
  });

  it("不允许覆盖尚未终结的执行关联", () => {
    const { lifecycle } = setup();
    lifecycle.begin("execution-1");
    expect(() => lifecycle.begin("execution-2")).toThrow("运行");
  });
});
