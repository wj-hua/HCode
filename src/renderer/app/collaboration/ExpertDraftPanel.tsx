// 专家计划侧面板：推荐、编辑、能力确认、开始各有明确动作，不把选择团队当成执行。
import { LoaderCircleIcon } from "lucide-react";
import type { Conversation } from "../store/appStore";
import type { ExpertDraftInput } from "@hcode/shared/expertDraft";
import { COLLABORATION_LIMITS } from "@hcode/shared/collaboration";
import type { CollaborationSnapshot, CollaborationCapabilities } from "@hcode/shared/collaboration";
import { EXPERT_LIMITS } from "@hcode/shared/experts";
import { Button } from "@/components/ui/button.js";
import { useExpertDraft } from "./useExpertDraft";
import { ExpertDraftTeam } from "./ExpertDraftTeam";
import { hasRepeatedExpertBackend } from "./expertPresentation";
import { expertPlanIssues } from "./expertDraftPresentation";
const EDITOR_ROWS = 3;
const FEEDBACK = "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:brightness-90";
export function ExpertDraftPanel({ conversation, input, capabilities, unavailable, onStarted }: {
  conversation: Conversation; input: Omit<ExpertDraftInput, "initiator">; capabilities: CollaborationCapabilities[]; unavailable?: string;
  onStarted(run: CollaborationSnapshot, input: string): void;
}) {
  const plan = useExpertDraft(conversation, input, onStarted), draft = plan.draft, edit = plan.edit;
  const preparing = draft?.status === "preparing", terminal = draft?.status === "started" || draft?.status === "abandoned";
  const locked = plan.busy || preparing || draft?.status === "starting";
  const issues = draft && edit ? expertPlanIssues(draft, edit, capabilities, plan.changed, unavailable) : [];
  return <section aria-label="专家评审计划" className="flex flex-col gap-3">
    <p className="font-medium">先查看推荐团队，再开始专家评审</p>
    <p className="text-ui-sm text-foreground-subtle">当前 AI 依据目标和实际项目资料推荐。生成使用额度，只读资料；确认前不研究、不互审。支持 @项目文件，输入附件尚未接入。</p>
    {plan.loading ? <p role="status">正在读取专家计划…</p> : null}
    {unavailable && !preparing ? <p role="status">{unavailable}</p> : null}
    {plan.error || draft?.error ? <p role={draft?.status === "cancelled" && !plan.error ? "status" : "alert"} className={`whitespace-pre-wrap ${draft?.status === "cancelled" && !plan.error ? "text-foreground-subtle" : "text-destructive"}`}>{plan.error || draft?.error}</p> : null}
    {preparing ? <div role="status" className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />正在推荐专家，尚未开始研究</span><Button type="button" variant="outline" onClick={() => void plan.cancel()}>取消推荐</Button></div> : <Button type="button" className={FEEDBACK} variant={draft && !terminal ? "outline" : "default"} disabled={plan.loading || locked || Boolean(unavailable) || !(input.objective.trim() || edit?.objective.trim())} onClick={() => void plan.generate()}>{draft && !terminal ? "重新生成专家计划" : "推荐专家团队并查看计划"}</Button>}
    {draft && edit && !terminal ? <>
      <div className="flex items-center justify-between text-ui-sm"><span>{draft.confidence === "needsSelection" ? edit.experts.length >= EXPERT_LIMITS.minParticipants ? "团队已由你选择，请核对分工" : "资料不足，请选择团队" : preparing ? "推荐中" : draft.status === "ready" ? "计划待确认" : "计划尚未就绪"}</span><span>版本 {draft.revision}</span></div>
      {draft.summary ? <p className="whitespace-pre-wrap">{draft.summary}</p> : null}
      <label className="flex flex-col gap-1">评审目标<textarea aria-label="专家计划评审目标" rows={EDITOR_ROWS} maxLength={COLLABORATION_LIMITS.maxContextLength} value={edit.objective} disabled={locked} onChange={event => plan.update({ ...edit, objective: event.target.value })} className="rounded-md border border-border bg-background p-2 focus-visible:ring-2 focus-visible:ring-ring" /></label>
      <ExpertDraftTeam draft={draft} edit={edit} onChange={plan.update} capabilities={capabilities} disabled={locked} />
      {hasRepeatedExpertBackend(edit.experts) ? <p role="status" className="text-ui-sm">部分专家使用相同 AI 和模型；代表不同角色视角，不算独立模型证据。</p> : null}
      <details><summary className="cursor-pointer text-ui-sm">预算与计划资料</summary><label className="mt-2 flex items-center gap-2">累计回合上限<input aria-label="专家计划累计回合上限" type="number" min={2 + edit.experts.length * EXPERT_LIMITS.turnsPerParticipant} max={EXPERT_LIMITS.maxTurns} value={edit.turnLimit} disabled={locked} onChange={event => plan.update({ ...edit, turnLimit: Number(event.target.value) })} className="w-20 rounded border border-border bg-background p-1 focus-visible:ring-2 focus-visible:ring-ring" /></label><p className="mt-2 text-ui-sm">已用 {draft.turns.length} / {edit.turnLimit} 回合 · 独立研究、互审及汇总还需至少 {edit.experts.length * EXPERT_LIMITS.turnsPerParticipant + 1} 回合。格式修正仍占预算。</p>{draft.sources.map(file => <p key={file.path} className="mt-1 break-all text-ui-sm">{file.path} · {file.hash}</p>)}</details>
      <p className="text-ui-sm">仅分析项目文件；不联网、不运行测试或设备验证。角色和 Skills 不增加工具权限。</p>
      <details><summary className="cursor-pointer text-ui-sm">本次团队实际能力与缺少工具</summary><ul className="mt-2 space-y-1 text-ui-sm">{draft.profiles.filter(profile => edit.experts.some(expert => expert.role === profile.role)).flatMap(profile => profile.limitations.map((text, index) => <li key={`${profile.role}-${index}`}>{text}</li>))}</ul></details>
      <label className="flex items-start gap-2 text-ui-sm"><input type="checkbox" aria-label="确认本次专家团队能力限制" checked={edit.acceptProfileLimitations} disabled={locked || plan.changed || edit.experts.length < EXPERT_LIMITS.minParticipants || !["ready", "editing"].includes(draft.status)} onChange={event => void plan.acknowledge(event.target.checked)} />我已核对本次团队，接受未联网、未执行测试与设备验证等限制。</label>
      {issues.length ? <div role="status" className="text-ui-sm"><p className="font-medium">开始前还需：</p><ul className="mt-1 list-disc space-y-1 pl-5">{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div> : null}
      <div className="flex flex-wrap gap-2">
        {plan.changed ? <Button type="button" className={FEEDBACK} variant="outline" disabled={locked || Boolean(unavailable) || !edit.objective.trim() || edit.experts.some(expert => !expert.objective.trim())} onClick={() => void plan.save()}>保存专家分工</Button> : null}
        <Button type="button" className={FEEDBACK} disabled={plan.busy || preparing || !["ready", "starting"].includes(draft.status) || issues.length > 0} onClick={() => void plan.confirm()}>{draft.status === "starting" ? "找回本次确认结果" : "确认团队并开始专家评审"}</Button>
        <Button type="button" className={FEEDBACK} variant="ghost" disabled={locked} onClick={() => void plan.abandon()}>放弃专家计划</Button>
      </div>
      <details><summary className="cursor-pointer text-ui-sm">原生推荐记录</summary>{draft.turns.map(turn => <p key={turn.id} className="mt-2 whitespace-pre-wrap text-ui-sm">{turn.agent} · {turn.status}{turn.error ? ` · ${turn.error}` : ""}</p>)}</details>
    </> : null}
  </section>;
}
