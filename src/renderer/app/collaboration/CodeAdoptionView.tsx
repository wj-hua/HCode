// 采纳完整版本的确认、冲突和恢复反馈；不向模型暴露原项目写回入口。
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import { Button } from "@/components/ui/button.js";
import { useCodeAdoption } from "./useCodeAdoption";
const STATUS_LABELS = {
  prepared: "准备采纳后中断",
  applying: "应用尚未完成",
  applied: "已应用到原项目",
  needsRecovery: "需要恢复",
  rolledBack: "已撤回本次未完成应用",
} as const;
export function CodeAdoptionView({
  run,
  versionId,
}: {
  run: CollaborationSnapshot;
  versionId?: string;
}) {
  const state = useCodeAdoption(run, versionId),
    adoption = state.state;
  const working = run.status === "running" || run.status === "stopping";
  const blocked = Boolean(
    adoption && (adoption.status !== "rolledBack" || adoption.cleanupPending),
  );
  const recoverable = Boolean(
    adoption &&
    (["prepared", "applying", "needsRecovery"].includes(adoption.status) ||
      adoption.cleanupPending),
  );
  return (
    <section
      aria-label="采纳到原项目"
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className="font-medium">采纳到原项目</p>
      <p className="break-all text-ui-sm text-foreground-subtle">
        目标：{run.code!.workspace.originalPath}
      </p>
      {adoption ? (
        <>
          <p role="status">
            {STATUS_LABELS[adoption.status]} · {adoption.changedPaths.length}{" "}
            个文件{adoption.cleanupPending ? " · 临时文件仍需清理" : ""}
          </p>
          {adoption.error ? (
            <p role="alert" className="whitespace-pre-wrap text-destructive">
              {adoption.error}
            </p>
          ) : null}
        </>
      ) : null}
      {!blocked ? (
        <Button
          variant="outline"
          disabled={
            state.busy || working || !versionId || run.code?.stopUnconfirmed
          }
          onClick={() => void state.inspect()}
        >
          检查所选版本能否采纳
        </Button>
      ) : null}
      {state.preview && !blocked ? (
        <>
          <p>
            所选候选 v{state.preview.version.version} ·{" "}
            {state.preview.changes.length} 个文件 ·{" "}
            {state.preview.eligible ? "冲突检查通过" : "暂不能采纳"}
          </p>
          {state.preview.reasons.length ? (
            <ul className="list-disc pl-5">
              {state.preview.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {state.preview.conflicts.length ? (
            <div role="alert">
              <p>以下文件有冲突，原项目未写入：</p>
              <ul className="list-disc pl-5">
                {state.preview.conflicts.map((conflict) => (
                  <li key={conflict.path} className="break-all">
                    {conflict.path}：{conflict.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {state.preview.eligible ? (
            <>
              <p className="text-ui-sm text-foreground-subtle">
                请先核对上方完整差异。将应用所选版本的全部改动；应用期间暂停其他工具编辑这些文件。此操作不提交或推送代码。
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={state.confirmed}
                  disabled={state.busy}
                  onChange={(event) => state.setConfirmed(event.target.checked)}
                />
                <span>
                  我已核对差异，确认将候选 v{state.preview.version.version}{" "}
                  应用到上述原项目。
                </span>
              </label>
              <Button
                disabled={state.busy || !state.confirmed}
                onClick={() => void state.apply()}
              >
                确认采纳所选版本
              </Button>
            </>
          ) : null}
        </>
      ) : null}
      {recoverable ? (
        <>
          <p>
            重启后不会自动继续写回。恢复会撤回本次未完成的改动；文件有后续修改时停止并保留记录。已成功应用的版本只清理临时文件。
          </p>
          <Button
            variant="outline"
            disabled={state.busy || working}
            onClick={() => void state.recover()}
          >
            {adoption?.status === "applied" || adoption?.status === "rolledBack"
              ? "恢复清理临时文件"
              : "恢复未完成的应用"}
          </Button>
        </>
      ) : null}
      {state.busy ? <p role="status">正在核对或应用，请等待最终结果…</p> : null}
      {state.error ? (
        <p role="alert" className="whitespace-pre-wrap text-destructive">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
