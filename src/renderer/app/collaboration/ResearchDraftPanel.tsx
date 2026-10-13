// U0 最小计划预览：先看分工，再明确开始；即时反馈和错误原因不依赖颜色。
import { LoaderCircleIcon, FileTextIcon } from "lucide-react";
import type { Conversation } from "../store/appStore";
import type { CollaborationSnapshot } from "@hcode/shared/collaboration";
import type { ResearchDraftInput } from "@hcode/shared/researchDraft";
import { COLLABORATION_LIMITS } from "@hcode/shared/collaboration";
import { AGENTS } from "@hcode/shared/agents";
import { Button } from "@/components/ui/button.js";
import { useResearchDraft } from "./useResearchDraft";
const CONTROL_FEEDBACK = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:brightness-90";
const EDITOR_ROWS = 4;

export function ResearchDraftPanel({ conversation, input, unavailable, onStarted }: {
  conversation: Conversation;
  input: Omit<ResearchDraftInput, "initiator">;
  unavailable?: string;
  onStarted(run: CollaborationSnapshot): void;
}) {
  const plan = useResearchDraft(conversation, input, onStarted);
  const draft = plan.draft;
  const preparing = draft?.status === "preparing";
  const terminal = draft?.status === "abandoned" || draft?.status === "started";
  const ready = draft?.status === "ready" || draft?.status === "starting";
  return <section aria-label="只读协作计划" className="flex flex-col gap-3 border-t border-border pt-3">
    <div className="flex items-center gap-2 font-medium"><FileTextIcon className="size-4" />先查看计划，再开始协作</div>
    <p className="text-ui-sm text-foreground-muted">生成计划会使用当前 AI 的额度。只读取项目资料；尚未派发任务，不创建写入副本。</p>
    <p className="text-ui-sm text-foreground-muted">本计划只使用这里的文字目标与项目文件，普通聊天输入框的附件不会带入。</p>
    {plan.loading ? <p role="status">正在读取已保存计划…</p> : null}
    {unavailable && !preparing ? <p role="status">{unavailable}</p> : null}
    {!input.objective.trim() && !draft ? <p role="status">请先填写任务目标。</p> : null}
    {plan.error || draft?.error ? <p role={draft?.status === "cancelled" && !plan.error ? "status" : "alert"} className={`whitespace-pre-wrap ${draft?.status === "cancelled" && !plan.error ? "text-foreground-muted" : "text-destructive"}`}>{plan.error || draft?.error}</p> : null}
    {preparing ? <div role="status" className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2"><LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />正在生成计划，确认前不会执行</span>
      <Button type="button" className={CONTROL_FEEDBACK} variant="outline" onClick={() => void plan.cancel()}>取消规划</Button>
    </div> : <Button type="button" className={CONTROL_FEEDBACK} variant={ready ? "outline" : "default"} disabled={plan.busy || plan.loading || Boolean(unavailable) || !(input.objective.trim() || plan.objective.trim())} onClick={() => void plan.generate()}>{plan.busy ? "正在处理…" : ready ? "重新生成计划" : "生成并预览计划"}</Button>}
    {draft && !terminal ? <div className="flex flex-col gap-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between"><span className="font-medium">{preparing ? "规划中" : ready ? "计划待确认" : draft.status === "cancelled" ? "规划已取消" : "计划尚未就绪"}</span><span className="text-ui-sm text-foreground-muted">版本 {draft.revision}</span></div>
      {draft.summary ? <p className="whitespace-pre-wrap">{draft.summary}</p> : null}
      <label className="flex flex-col gap-1">任务与验收要求<textarea aria-label="计划任务与验收要求" value={plan.objective} onChange={event => plan.setObjective(event.target.value)} disabled={plan.busy || preparing || draft.status === "starting"} maxLength={COLLABORATION_LIMITS.maxContextLength} rows={EDITOR_ROWS} className="rounded-md border border-border bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <p className="text-ui-sm">执行：{AGENTS[draft.params.executor.agent].name} · 独立审查：{AGENTS[draft.params.reviewer?.agent ?? draft.params.initiator.agent].name} · 汇总：当前原会话</p>
      <p className="text-ui-sm text-foreground-muted">计划引用 {draft.sources.length} 个文件版本 · 规划已用 {draft.turns.length} / {COLLABORATION_LIMITS.maxTurns} 回合 · 执行仍限于只读，不运行测试</p>
      {plan.changed ? <p role="status">计划或 AI 配置已修改，请先保存，再确认开始。</p> : null}
      <div className="flex flex-wrap gap-2">
        {plan.changed ? <Button type="button" className={CONTROL_FEEDBACK} variant="outline" disabled={plan.busy || preparing || !plan.objective.trim()} onClick={() => void plan.save()}>保存计划修改</Button> : null}
        <Button type="button" className={CONTROL_FEEDBACK} disabled={plan.busy || preparing || !ready || plan.changed || Boolean(unavailable)} onClick={() => void plan.confirm()}>确认计划并开始协作</Button>
        <Button type="button" className={CONTROL_FEEDBACK} variant="ghost" disabled={plan.busy || preparing || draft.status === "starting"} onClick={() => void plan.abandon()}>放弃草案</Button>
      </div>
      <details><summary className="cursor-pointer text-ui-sm">资料版本与规划记录</summary><ul className="mt-2 space-y-1 text-ui-sm">{draft.sources.map(file => <li key={file.path} className="break-all">{file.path} · {file.hash}</li>)}{draft.turns.filter(turn => turn.error).map(turn => <li key={turn.id} className="whitespace-pre-wrap">原生回合：{turn.status} · {turn.error}</li>)}</ul></details>
    </div> : null}
  </section>;
}
