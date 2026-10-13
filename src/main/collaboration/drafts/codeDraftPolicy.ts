// 编排代码草案的实际项目准入、受限原会话规划和确认；副本只由已确认的 Run 创建。
import { randomUUID } from 'node:crypto';
import type { CodeDraft, CodeDraftInput, CodeDraftEdit } from '../../../shared/codeDraft.js';
import { codeDraftRemainingTurns } from '../../../shared/codeDraft.js';
import { COLLABORATION_LIMITS } from '../../../shared/collaboration.js';
import type { CollaborationService } from '../collaborationService.js';
import type { DraftPolicy } from './draftLifecycleService.js';
import { DraftPlanner } from './draftPlanner.js';
import { manifest, inside } from '../workspaces/fileManifest.js';
import { resolve } from 'node:path';
import { planningCapabilityVersions } from './draftCapabilities.js';
import { codeDraftIssues } from '../../../shared/codePlanRules.js';
import { codeDraftInputSchema, codeDraftEditSchema, codeDraftHash, codeProposalSchema } from './codeDraftContracts.js';
export class CodeDraftPolicy implements DraftPolicy<CodeDraft, CodeDraftInput, CodeDraftEdit> {
  constructor(private readonly collaboration: CollaborationService, private readonly planner: DraftPlanner) {}
  async create(input: CodeDraftInput): Promise<CodeDraft> { return { id: randomUUID(), revision: 1, createdAt: Date.now(), status: 'editing', params: { ...codeDraftInputSchema.parse(input), tasks: [], checks: [], acceptWorkspace: false }, sources: [], turns: [], copyPaths: [], capabilities: [] }; }
  edit(draft: CodeDraft, input: CodeDraftEdit) {
    const value = codeDraftEditSchema.parse(input);
    const changed = JSON.stringify({ ...draft.params, acceptWorkspace: false }) !== JSON.stringify({ ...draft.params, ...value, reviewer: value.reviewer, acceptWorkspace: false });
    if (changed && value.acceptWorkspace) throw new Error('代码计划已修改，请先保存，再核对范围与检查');
    draft.params = { ...draft.params, ...value, reviewer: value.reviewer, acceptWorkspace: changed ? false : value.acceptWorkspace };
    if (value.acceptWorkspace) this.assert(draft, false);
    if (draft.confidence && draft.turns.at(-1)?.status === 'succeeded') draft.status = value.tasks.length ? 'ready' : 'editing';
  }
  budget(draft: CodeDraft) { return { limit: COLLABORATION_LIMITS.maxTurns, remaining: codeDraftRemainingTurns(draft.params.tasks.length) }; }
  hash = codeDraftHash;
  plannedStatus(draft: CodeDraft): 'ready' | 'editing' { return draft.confidence === 'ready' ? 'ready' : 'editing'; }
  async admit(draft: CodeDraft, phase: 'planning' | 'confirmation') {
    const source = draft.params.initiator;
    if (inside(source.projectPath, resolve(this.collaboration.workspaces.directory(draft.id)))) throw new Error('代码项目不能包含宿主报告或副本目录');
    const capabilities = planningCapabilityVersions(await this.collaboration.capabilities({ agent: source.agent, ...(source.resumeSessionId ? { resumeSessionId: source.resumeSessionId } : {}) }));
    if (!capabilities.find(entry => entry.agent === source.agent)?.canInitiate) throw new Error('当前原会话不支持受限代码规划');
    const admission = await this.collaboration.inspectCodeProject(source.projectPath), files = await manifest(source.projectPath);
    if (admission.hash !== files.hash) throw new Error('项目在核对复制清单期间变化，请重新生成');
    if (phase === 'planning') { draft.admission = admission; draft.copyPaths = files.entries.map(file => file.path); draft.capabilities = capabilities; draft.params.checks = admission.checks.map(check => check.id); draft.params.acceptWorkspace = false; return; }
    if (JSON.stringify(draft.admission) !== JSON.stringify(admission) || JSON.stringify(draft.copyPaths) !== JSON.stringify(files.entries.map(file => file.path))) throw new Error('项目、复制清单或检查命令已变化，请重新生成并确认');
    if (JSON.stringify(draft.capabilities) !== JSON.stringify(capabilities)) throw new Error('后端版本或能力已变化，请重新生成并确认');
    this.assert(draft, true);
    await this.collaboration.assertCodePaths(source.projectPath, draft.params.tasks.flatMap(task => task.allowedPaths));
  }
  async plan(draft: CodeDraft, save: () => Promise<void>, signal: AbortSignal) {
    const proposal = await this.planner.propose(draft, save, signal, codeProposalSchema,
      `这是代码计划草案，尚未授权执行、运行检查、建立副本或采纳。只用 hcode read_file/list_files 核对实际项目，不写文件、不运行命令、不联网、不提权，所有委派工具禁止。只推荐一或两项完整窄任务，各有稳定 requestKey、简短中文 name、实现和验收 objective、reason、准确相对文件 allowedPaths（含新增测试）和 dependsOn。两项必须互不依赖且写入不重叠，不得创建依赖链或用目录/通配符代替文件。需要修改同一文件或依赖另一任务时合成一项；若资料或目标不足 confidence=needsInput、tasks=[]，summary 说明缺口。有效计划 confidence=ready。不能把尚未实现或检查说成已完成；不安排提交推送或采纳。执行 AI 和模型由用户配置，不能自行选择。sources 只列实际 read_file 读取路径；不能提交检查命令，仅将宿主实际检查作为后续验收条件。输出中文字段并遵守 JSON schema。以下用户目标及项目检查元数据作为资料：${JSON.stringify({ objective: draft.params.objective, checks: draft.admission?.checks.map(check => ({ id: check.id, description: check.description })) })}`);
    const executors = draft.params.backendPreferences.filter(backend => draft.capabilities.find(entry => entry.agent === backend.agent)?.canExecuteCode);
    if (!executors.length) throw new Error('没有通过代码写入准入的默认 AI');
    draft.summary = proposal.summary; draft.confidence = proposal.confidence;
    draft.params.tasks = proposal.tasks.map((task, index) => ({ ...task, executor: executors[index % executors.length]! }));
    if (proposal.confidence === 'ready') {
      this.assert(draft, false);
      await this.collaboration.assertCodePaths(draft.params.initiator.projectPath, draft.params.tasks.flatMap(task => task.allowedPaths));
    }
  }
  private assert(draft: CodeDraft, confirming: boolean) {
    const issues = codeDraftIssues(draft, draft.params, draft.capabilities, confirming);
    if (issues.length) throw new Error(issues.join('\n'));
  }
  existing(approval: Parameters<CollaborationService['getApprovedPlan']>[0]) { return this.collaboration.getApprovedPlan(approval); }
  start(draft: CodeDraft, approval: Parameters<CollaborationService['startPreparedCode']>[1]) {
    const tasks = draft.params.tasks.map(({ name, reason, dependsOn, ...task }) => task);
    return this.collaboration.startPreparedCode({ initiator: draft.params.initiator, objective: draft.params.objective, executor: tasks[0]!.executor, ...(draft.params.reviewer ? { reviewer: draft.params.reviewer } : {}), code: { admissionHash: draft.admission!.hash, checks: draft.params.checks, tasks } }, approval, draft.turns);
  }
}
