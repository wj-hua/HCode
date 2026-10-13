// 专家推荐草案冻结目标、逐角色分工、预览组合和能力版本；用户确认前不创建专家会话。
import type { PlanningDraft } from "./planningDraft.js";
import type { ExpertSelection } from "./experts.js";
import type { CollaborationBackend, CollaborationStartParams } from "./collaboration.js";
import type { ExpertProfilePreview, BusinessExpertType } from "./expertProfiles.js";
export interface ExpertAssignment extends ExpertSelection { role: BusinessExpertType; objective: string; reason: string }
export interface ExpertDraftInput {
  initiator: CollaborationStartParams["initiator"];
  objective: string;
  backendPreferences: CollaborationBackend[];
  turnLimit: number;
}
export interface ExpertDraftParams extends ExpertDraftInput { experts: ExpertAssignment[]; acceptProfileLimitations: boolean }
export interface ExpertDraftEdit { objective: string; experts: ExpertAssignment[]; turnLimit: number; acceptProfileLimitations: boolean }
export interface ExpertPlanCapability { agent: string; version?: string; canInitiate: boolean; canExecute: boolean; canReview: boolean; models: string[] }
export interface ExpertDraft extends PlanningDraft<ExpertDraftParams> {
  confidence?: "identified" | "needsSelection";
  profiles: ExpertProfilePreview[];
  capabilities: ExpertPlanCapability[];
}
