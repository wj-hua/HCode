// 计划的公共生命周期；业务分工分别由只读、专家和代码计划定义，Run 不属于草案状态。
import type { CollaborationStartParams, CollaborationTask, CollaborationCapabilities } from "./collaboration.js";
// 已移除的 CLI 仅保留在历史能力快照中；执行配置仍只接受当前已准入后端。
export const RETIRED_PLANNING_AGENTS = ['step', 'pi'] as const;
export interface PlanningCapability extends Pick<CollaborationCapabilities, 'version' | 'canInitiate' | 'canExecute' | 'canReview' | 'canExecuteCode'> {
  agent: CollaborationCapabilities['agent'] | typeof RETIRED_PLANNING_AGENTS[number];
  models: string[];
}
export interface DraftFile { path: string; hash: string }
export interface PlanningDraftParams { initiator: CollaborationStartParams["initiator"]; objective: string }
export interface PlanningDraft<P extends PlanningDraftParams = PlanningDraftParams> {
  id: string;
  revision: number;
  createdAt: number;
  status: "editing" | "preparing" | "ready" | "blocked" | "cancelled" | "abandoned" | "starting" | "started";
  params: P;
  summary?: string;
  sources: DraftFile[];
  turns: CollaborationTask[];
  error?: string;
  rawResult?: string;
  approvalHash?: string;
  runId?: string;
}
