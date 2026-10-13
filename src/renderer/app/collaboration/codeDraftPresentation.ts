// 界面按共同业务规则展示缺口，额外提示本地未保存编辑和当前会话限制。
import type { CodeDraft, CodeDraftEdit } from '@hcode/shared/codeDraft';
import type { CollaborationCapabilities } from '@hcode/shared/collaboration';
import { codeDraftIssues } from '@hcode/shared/codePlanRules';
export function codePlanIssues(draft: CodeDraft, edit: CodeDraftEdit, capabilities: CollaborationCapabilities[], changed: boolean, unavailable?: string) {
  const versions = capabilities.map(value => ({ ...value, models: value.models?.map(model => model.value) ?? [] }));
  return [...(unavailable ? [unavailable] : []), ...codeDraftIssues(draft, edit, versions, true), ...(changed ? ['计划已修改，请先保存再确认范围与检查。'] : [])];
}
