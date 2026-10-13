// 协作记录的只读展示投影；只关联宿主身份，不解析提示词或改变执行/审查状态。
import type { CollaborationSnapshot, CollaborationTask } from './collaboration.js';
import type { PlanningDraft } from './planningDraft.js';
import type { AgentKind, SessionSummary } from './types.js';
import { EXPERT_ROLES } from './experts.js';
import { deliveryCode, codeCandidates } from './codeCandidates.js';

export interface PresentationTask extends CollaborationTask { projectPath: string; label: string }
export interface CollaborationPresentation {
  id: string; runId?: string; createdAt: number; projectPath: string; objective: string;
  status: string; stage?: string; summary?: string; summaryLabel?: string; error?: string; tasks: PresentationTask[];
  source: { agent: AgentKind; sessionKey: string; nativeSessionId?: string };
}
export interface PresentationCatalog { entries: CollaborationPresentation[]; errors: string[] }
export interface PresentationConversation { agent: AgentKind; projectPath: string; sessionKey?: string; sessionId?: string }
export const COLLABORATION_PRESENTATION_LIMITS = { titleLength: 80 } as const;
export const TASK_ROLE_LABELS = { planning: '计划生成', execution: '执行 / 修订', review: '独立审查', synthesis: '当前会话汇总' } as const;
export const TASK_RESULT_LABELS = { running: '运行中', succeeded: '回合完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' } as const;
const DRAFT_PRESENTATION_NAMESPACE = "draft:";
const STAGE_LABELS = { planning: '制定计划', awaitingWorkers: '执行、审查与修订', expertResearch: '专家独立研究', peerReview: '专家交叉审查', synthesis: '当前会话汇总', finished: '流程已结束' } as const;
const RUN_STATES = { running: '协作进行中', stopping: '等待原生停止确认', paused: '已暂停', awaitingUser: '等待人工处理', completed: '汇总已完成', failed: '协作失败', cancelled: '已停止', interrupted: '已中断' } as const;
const DRAFT_STATES = { editing: '计划待完善', preparing: '正在生成计划', ready: '计划待确认', blocked: '计划生成受阻', cancelled: '规划已取消', abandoned: '计划已放弃', starting: '正在启动协作', started: '计划已确认' } as const;

/** 与原生列表的自动标题规则一致；审计正文仍只保存在原生会话中。 */
export function collaborationInputTitle(text: string) {
  const line = text.trim().split('\n')[0]!.trim();
  const limit = COLLABORATION_PRESENTATION_LIMITS.titleLength;
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** 执行成功不等于审查通过，汇总完成不等于代码已经采纳。 */
export function presentationForRun(run: CollaborationSnapshot): CollaborationPresentation {
  const source = run.params.initiator;
  const candidates = codeCandidates(run);
  const applied = candidates.filter(entry => entry.code.adoption?.status === 'applied').length;
  const tasks = run.tasks.map(task => {
    const delivery = run.deliveries.find(entry => entry.id === task.deliveryId);
    const expert = run.experts?.participants.find(entry => entry.id === task.expertId);
    const projectPath = task.presentation?.projectPath ?? (delivery ? deliveryCode(run, delivery)?.workspace.path : undefined) ?? source.projectPath;
    const role = run.experts && task.role === 'execution' ? '独立研究' : run.experts && task.role === 'review' ? '专家互审' : TASK_ROLE_LABELS[task.role];
    return { ...task, projectPath, label: `${role}${expert || delivery ? ' · ' : ''}${(expert ? EXPERT_ROLES[expert.role].name : undefined) ?? delivery?.objective ?? ''}` };
  });
  return { id: run.id, runId: run.id, createdAt: run.createdAt, projectPath: source.projectPath, objective: run.params.objective, stage: run.stage === "finished" ? undefined : STAGE_LABELS[run.stage], status: RUN_STATES[run.status] + (candidates.length ? ` · 已采纳 ${applied} / ${candidates.length}` : ''), summaryLabel: candidates.some(entry => entry.code.adoption) ? '当时的汇总（采纳前），采纳状态以宿主记录为准' : '当前会话汇总', summary: run.experts?.summary?.summary ?? (run.experts ? undefined : run.summary), error: run.error ?? run.persistenceError, tasks, source: { agent: source.agent, sessionKey: source.sessionKey, nativeSessionId: source.resumeSessionId ?? tasks.find(task => task.role === 'planning')?.nativeSessionId } };
}

/** 草案只呈现规划状态；同 UUID 的正式 Run 由合并规则优先保留。 */
export function presentationForDraft(draft: PlanningDraft): CollaborationPresentation {
  const source = draft.params.initiator;
  return { id: `${DRAFT_PRESENTATION_NAMESPACE}${draft.id}`, runId: draft.runId, createdAt: draft.createdAt, projectPath: source.projectPath, objective: draft.params.objective, status: DRAFT_STATES[draft.status], summary: draft.summary, error: draft.error, tasks: draft.turns.map(task => ({ ...task, projectPath: source.projectPath, label: TASK_ROLE_LABELS[task.role] })), source: { agent: source.agent, sessionKey: source.sessionKey, nativeSessionId: source.resumeSessionId } };
}

/** 草案与正式 Run 可共用业务 UUID；正式 Run 到达后，慢草案查询不能覆盖执行结果。 */
export function mergePresentationEntry(entries: readonly CollaborationPresentation[], next: CollaborationPresentation) {
  if (next.runId && next.id !== next.runId && entries.some(entry => entry.id === next.runId)) return entries;
  return [...entries.filter(entry => entry.id !== next.id && entry.id !== `${DRAFT_PRESENTATION_NAMESPACE}${next.id}`), next];
}

/** 原生身份与实际目录必须同时匹配；重复/不明确的关联保留原文。 */
export function presentationTaskForTurn(entries: readonly CollaborationPresentation[], conversation: PresentationConversation, turnId: string) {
  const matches = entries.flatMap(entry => entry.tasks.filter(task => task.agent === conversation.agent && task.projectPath === conversation.projectPath && (task.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && task.nativeSessionId === conversation.sessionId)) && (task.presentation?.executionTurnId === turnId || task.presentation?.nativeTurnId === turnId)).map(task => ({ entry, task })));
  const distinct = [...new Map(matches.map(match => [match.task.id, match])).values()];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** 内部线程归入发起项目；隔离目录保留在导航引用中，源会话保持普通会话身份。 */
export function groupCollaborationSessions(sessions: readonly SessionSummary[], entries: readonly CollaborationPresentation[], projectPath: string) {
  const groupedIds = new Set<string>();
  const groups = entries.filter(entry => entry.projectPath === projectPath && entry.runId === entry.id).sort((left, right) => right.createdAt - left.createdAt).flatMap(entry => {
    const threads = new Map<string, SessionSummary>();
    for (const task of entry.tasks) {
      if (!task.nativeSessionId || task.role === 'planning' || task.role === 'synthesis') continue;
      if (task.agent === entry.source.agent && task.nativeSessionId === entry.source.nativeSessionId) continue;
      const key = `${task.agent}:${task.nativeSessionId}`;
      const actual = sessions.find(session => session.agent === task.agent && session.id === task.nativeSessionId && session.projectPath === task.projectPath);
      groupedIds.add(`${key}:${task.projectPath}`);
      if (!threads.has(key)) threads.set(key, { ...(actual ?? { id: task.nativeSessionId, agent: task.agent, projectPath: task.projectPath, createdAt: entry.createdAt, updatedAt: entry.createdAt }), title: task.label });
    }
    return threads.size ? [{ entry, sessions: [...threads.values()] }] : [];
  });
  return { ordinary: sessions.filter(session => !groupedIds.has(`${session.agent}:${session.id}:${session.projectPath}`)), groups };
}

export function usagePresentation(tasks: readonly CollaborationTask[]) {
  const known = tasks.filter(task => task.usage?.inputTokens !== undefined && task.usage.outputTokens !== undefined);
  return { knownTurns: known.length, unknownTurns: tasks.length - known.length, ...(known.length ? { inputTokens: known.reduce((sum, task) => sum + task.usage!.inputTokens!, 0), outputTokens: known.reduce((sum, task) => sum + task.usage!.outputTokens!, 0) } : {}) };
}

/** 只替换与宿主原始首行完全相等的自动标题；用户重命名保持原样。 */
export function presentationTitle(title: string, conversation: PresentationConversation, entries: readonly CollaborationPresentation[]) {
  const associated = entries.filter(entry => entry.source.agent === conversation.agent && entry.projectPath === conversation.projectPath && (entry.source.sessionKey === conversation.sessionKey || Boolean(conversation.sessionId && entry.source.nativeSessionId === conversation.sessionId))).sort((left, right) => left.createdAt - right.createdAt);
  for (const entry of associated) {
    if (!entry.tasks.some(task => {
      const raw = task.presentation?.inputTitle;
      return raw && (title === raw || title === collaborationInputTitle(raw));
    })) continue;
    return collaborationInputTitle(entry.objective);
  }
  return title;
}

/** 查询与用户看到的任务名、角色保持一致，折叠的项目也可由查询展开。 */
export function collaborationGroupMatchesQuery(group: { entry: CollaborationPresentation; sessions: readonly SessionSummary[] }, query: string) {
  return !query || `${group.entry.objective} ${group.sessions.map(session => session.title).join(' ')}`.toLowerCase().includes(query.toLowerCase());
}
