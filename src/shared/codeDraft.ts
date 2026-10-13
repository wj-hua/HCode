// 代码计划与 Run 分离；复制范围和检查由宿主发现，明确确认后才创建隔离副本。
import type { PlanningDraft, PlanningCapability } from './planningDraft.js';
import type { CollaborationBackend, CollaborationStartParams } from './collaboration.js';
import type { CodeAdmission, CodeWriteTask, ValidationCheckId } from './codeDelivery.js';
import { PARALLEL_CODE_LIMITS } from './codeDelivery.js';
export const CODE_DRAFT_LIMITS = { minTasks: 1, maxTasks: PARALLEL_CODE_LIMITS.maxTasks, maxChecks: 4, turnsPerTask: 2, synthesisTurns: 1, maxNameLength: 120, maxReasonLength: 2000 } as const;
export interface CodePlannedTask extends CodeWriteTask { name: string; reason: string; dependsOn: string[] }
export interface CodeDraftInput {
  initiator: CollaborationStartParams['initiator'];
  objective: string;
  backendPreferences: CodeWriteTask['executor'][];
  reviewer?: CollaborationBackend;
}
export interface CodeDraftParams extends CodeDraftInput {
  tasks: CodePlannedTask[];
  checks: ValidationCheckId[];
  acceptWorkspace: boolean;
}
export type CodeDraftEdit = Pick<CodeDraftParams, 'objective' | 'tasks' | 'reviewer' | 'checks' | 'acceptWorkspace'>;
export interface CodeDraft extends PlanningDraft<CodeDraftParams> {
  confidence?: 'ready' | 'needsInput';
  admission?: CodeAdmission;
  copyPaths: string[];
  capabilities: PlanningCapability[];
}

/** 每项预留实现和独立审查，再加原会话汇总；空草案按最小单任务预留。 */
export function codeDraftRemainingTurns(taskCount: number) { return Math.max(taskCount, CODE_DRAFT_LIMITS.minTasks) * CODE_DRAFT_LIMITS.turnsPerTask + CODE_DRAFT_LIMITS.synthesisTurns; }
