// 代码草案公开服务；复用共同生命周期，输入、范围与项目确认由代码 Policy 负责。
import type { CodeDraft, CodeDraftInput, CodeDraftEdit } from '../../../shared/codeDraft.js';
import type { CollaborationService } from '../collaborationService.js';
import type { SessionExecutionService } from '../../sessions/sessionExecutionService.js';
import type { AgentRegistry } from '../../agents/registry.js';
import { DraftLifecycleService } from './draftLifecycleService.js';
import { DraftPlanner } from './draftPlanner.js';
import { CodeDraftPolicy } from './codeDraftPolicy.js';
import { codeDraftSchema } from './codeDraftContracts.js';
export class CodeDraftService extends DraftLifecycleService<CodeDraft, CodeDraftInput, CodeDraftEdit> {
  constructor(root: string, collaboration: CollaborationService, execution: SessionExecutionService, agents: AgentRegistry, emit?: (draft: CodeDraft) => void) { super(root, codeDraftSchema, execution, new CodeDraftPolicy(collaboration, new DraftPlanner(execution, agents)), emit); }
}
