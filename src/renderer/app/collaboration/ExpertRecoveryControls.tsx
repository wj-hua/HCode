// 失败后的继续策略须由用户明确选择；不自动排除专家或清空累计预算。
import { useState } from "react";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { EXPERT_ROLES, type ExpertResumeParams } from "@hcode/shared/experts";
import { Button } from "@/components/ui/button.js";
import { hcode } from "../bridge";
import { bindCollaborationSource } from "./sourceConversation";
export function ExpertRecoveryControls({
  run,
}: {
  run: CollaborationSnapshot;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const state = run.experts!;
  if (["running", "stopping", "cancelled", "completed"].includes(run.status))
    return null;
  const valid = state.participants.filter(
    (expert) => expert.status === "reported" && expert.versions.length,
  );
  const resume = async (params: ExpertResumeParams) => {
    setBusy(true);
    setError("");
    try {
      bindCollaborationSource(run);
      await hcode.invoke("collaboration:resumeExperts", run.id, params);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <p className="text-ui-sm text-foreground-subtle">
        旧版本、失败原因和互审意见保留。续跑核对原会话和源码，累计预算不重置。
      </p>
      <div className="flex flex-wrap gap-2">
        {state.participants
          .filter((expert) => expert.status !== "reported")
          .map((expert) => (
            <Button
              key={expert.id}
              variant="outline"
              disabled={busy}
              onClick={() =>
                void resume({ action: "research", expertId: expert.id })
              }
            >
              重试{EXPERT_ROLES[expert.role].name}
            </Button>
          ))}
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void resume({ action: "research" })}
        >
          全部重新研究
        </Button>
        {valid.length >= 2 && valid.length < state.participants.length ? (
          <Button
            disabled={busy}
            onClick={() => void resume({ action: "continuePartial" })}
          >
            排除失败专家，以 {valid.length} 份报告继续
          </Button>
        ) : null}
        {state.activeIds.length >= 2 &&
        state.activeIds.every((id) =>
          valid.some((expert) => expert.id === id),
        ) ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void resume({ action: "review" })}
          >
            重新互审并汇总
          </Button>
        ) : null}
      </div>
      {busy ? <p role="status">正在验证并恢复…</p> : null}
      {error ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
