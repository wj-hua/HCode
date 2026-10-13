// 展示本次团队、推荐依据和可编辑任务；新增角色明确来自用户选择，不冒充 AI 推荐。
import type { ExpertDraft, ExpertDraftEdit, ExpertAssignment } from "@hcode/shared/expertDraft";
import { COLLABORATION_LIMITS } from "@hcode/shared/collaboration";
import type { CollaborationCapabilities, CollaborationBackend } from "@hcode/shared/collaboration";
import { BUSINESS_EXPERT_TYPES } from "@hcode/shared/expertProfiles";
import { EXPERT_ROLES, EXPERT_LIMITS } from "@hcode/shared/experts";
import { ExpertBackendSetup } from "./ExpertBackendSetup";
import { ExpertProfileDetails } from "./ExpertProfileDetails";
const EDITOR_ROWS = 3;
export function ExpertDraftTeam({ draft, edit, onChange, capabilities, disabled }: {
  draft: ExpertDraft; edit: ExpertDraftEdit; onChange(edit: ExpertDraftEdit): void; capabilities: CollaborationCapabilities[]; disabled: boolean;
}) {
  const change = (role: ExpertAssignment["role"], value: Partial<ExpertAssignment>) => onChange({ ...edit, experts: edit.experts.map(expert => expert.role === role ? { ...expert, ...value } : expert) });
  const preferred = draft.params.backendPreferences.find(backend => capabilities.some(value => value.agent === backend.agent && value.canExecute && value.canReview));
  const choose = (role: ExpertAssignment["role"], selected: boolean) => {
    if (!selected) { onChange({ ...edit, experts: edit.experts.filter(expert => expert.role !== role) }); return; }
    if (!preferred) return;
    onChange({ ...edit, experts: [...edit.experts, { role, objective: EXPERT_ROLES[role].responsibility, reason: "用户添加的专家，按所选角色职责核对当前目标。", backend: preferred, profileHash: draft.profiles.find(profile => profile.role === role)?.hash }] });
  };
  const backend = (expert: ExpertAssignment, value: CollaborationBackend) => {
    const preference = draft.params.backendPreferences.find(entry => entry.agent === value.agent);
    change(expert.role, { backend: value.agent !== expert.backend.agent && value.agent !== "agy" && preference?.model ? { ...value, model: preference.model } : value });
  };
  return <fieldset disabled={disabled} className="flex flex-col gap-3">
    <legend className="mb-2 font-medium">本次专家团队 · {edit.experts.length} 位</legend>
    <details open={!edit.experts.length}><summary className="cursor-pointer text-ui-sm">调整团队（选择 2–7 位）</summary><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{BUSINESS_EXPERT_TYPES.map(role => <label key={role} className="flex items-center gap-2"><input type="checkbox" checked={edit.experts.some(expert => expert.role === role)} disabled={!edit.experts.some(expert => expert.role === role) && (edit.experts.length >= EXPERT_LIMITS.maxParticipants || !preferred)} onChange={event => choose(role, event.target.checked)} />{EXPERT_ROLES[role].name}</label>)}</div></details>
    {edit.experts.map(expert => {
      const profile = draft.profiles.find(value => value.role === expert.role);
      return <article key={expert.role} className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <p className="font-medium">{EXPERT_ROLES[expert.role].name}</p>
        <p className="text-ui-sm text-foreground-subtle">推荐依据（生成时）：{expert.reason}</p>
        <label className="flex flex-col gap-1">此次研究任务<textarea aria-label={`${EXPERT_ROLES[expert.role].name}研究任务`} rows={EDITOR_ROWS} maxLength={COLLABORATION_LIMITS.maxContextLength} value={expert.objective} onChange={event => change(expert.role, { objective: event.target.value })} className="rounded-md border border-border bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
        <ExpertBackendSetup expert={expert} capabilities={capabilities} onChange={value => backend(expert, value)} />
        {profile ? <ExpertProfileDetails profile={profile} /> : <p role="alert">本计划没有此角色的有效组合，请重新生成。</p>}
      </article>;
    })}
  </fieldset>;
}
