// 固定规划时观察到的后端版本及能力，避免确认时静默使用另一配置。
import type { CollaborationCapabilities } from '../../../shared/collaboration.js';
import type { PlanningCapability } from '../../../shared/planningDraft.js';
export function planningCapabilityVersions(values: CollaborationCapabilities[]): PlanningCapability[] {
  return values.map(entry => ({ agent: entry.agent, ...(entry.version ? { version: entry.version } : {}), canInitiate: entry.canInitiate, canExecute: entry.canExecute, canReview: entry.canReview, canExecuteCode: entry.canExecuteCode, models: entry.models?.map(model => model.value).sort() ?? [] })).sort((left, right) => left.agent.localeCompare(right.agent));
}
