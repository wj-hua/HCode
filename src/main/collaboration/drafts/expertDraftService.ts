// 专家草案使用独立存储和专属规则；稳定服务入口复用已验证的生命周期。
import type { ExpertDraft, ExpertDraftInput, ExpertDraftEdit } from "../../../shared/expertDraft.js";
import type { CollaborationService } from "../collaborationService.js";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { DraftLifecycleService } from "./draftLifecycleService.js";
import { DraftPlanner } from "./draftPlanner.js";
import { ExpertDraftPolicy } from "./expertDraftPolicy.js";
import { expertDraftSchema } from "./expertDraftContracts.js";
export class ExpertDraftService extends DraftLifecycleService<ExpertDraft, ExpertDraftInput, ExpertDraftEdit> {
  constructor(root: string, collaboration: CollaborationService, execution: SessionExecutionService, agents: AgentRegistry, emit?: (draft: ExpertDraft) => void) {
    super(root, expertDraftSchema, execution, new ExpertDraftPolicy(collaboration, new DraftPlanner(execution, agents)), emit);
  }
}
