// 专家流程的只读会话投影；仅取当前冻结版本与最新一轮互审，不携带原生提示词。
import type { CollaborationSnapshot } from './collaboration.js';
import { EXPERT_ROLES, type ExpertSummary, type ExpertClaimRef } from './experts.js';
import { AGENTS } from './agents.js';

export interface ExpertConversation {
  phase: CollaborationSnapshot['stage'];
  busy: boolean;
  participants: { id: string; label: string; state: string; complete: boolean; busy: boolean; error?: string }[];
  research: { completed: number; total: number };
  review: { completed: number; total: number };
  summary?: ExpertSummary;
  references: Record<string, string>;
  labels: Record<string, string>;
}
const RESEARCH_STATES = { queued: '等待研究', researching: '独立研究中', reported: '报告已提交', failed: '研究失败', interrupted: '研究已中断' } as const;
const REVIEW_STATES = { queued: '等待互审', reviewing: '互审中', completed: '互审已完成', failed: '互审失败', interrupted: '互审已中断' } as const;

/** 同一报告受同一专家多次审查时，仅显示最新尝试，历史失败仍在审计记录中。 */
export function expertConversation(run: CollaborationSnapshot): ExpertConversation | undefined {
  const state = run.experts;
  if (!state) return undefined;
  const busy = run.status === 'running';
  const labels = Object.fromEntries(state.participants.map(expert => [expert.id, `${EXPERT_ROLES[expert.role].name} · ${AGENTS[expert.backend.agent].name}`]));
  const references = Object.fromEntries(state.participants.flatMap(expert => expert.versions.map(version => [version.id, `${labels[expert.id]} · v${version.version}`])));
  const versions = new Set(state.participants.filter(expert => state.activeIds.includes(expert.id)).flatMap(expert => expert.versions.slice(-1).map(version => version.id)));
  const reviews = [...new Map(state.reviews.filter(review => versions.has(review.versionId)).map(review => [`${review.versionId}:${review.reviewerId}`, review])).values()];
  const participants = state.participants.map(expert => {
    const assigned = reviews.filter(review => review.reviewerId === expert.id);
    const current = assigned.find(review => review.status === 'reviewing') ?? assigned.find(review => review.status === 'failed' || review.status === 'interrupted') ?? assigned.at(-1);
    const reviewing = run.stage === 'peerReview' && current;
    const working = reviewing ? current.status === 'reviewing' : expert.status === 'researching';
    const activity = reviewing ? REVIEW_STATES[current.status] : RESEARCH_STATES[expert.status];
    const stopped = run.status === 'paused' ? '已暂停' : run.status === 'stopping' ? '等待停止确认' : '已中断';
    return { id: expert.id, label: labels[expert.id]!, state: !busy && working ? `${reviewing ? '互审' : '研究'}${stopped}` : activity, complete: reviewing ? current.status === 'completed' : expert.status === 'reported', busy: busy && working, error: reviewing ? current.error : expert.error };
  });
  return { phase: run.stage, busy, participants, research: { completed: state.participants.filter(expert => expert.status === 'reported').length, total: state.participants.length }, review: { completed: reviews.filter(review => review.status === 'completed').length, total: reviews.length }, summary: state.summary, references, labels };
}

/** 引用名称来自真实冻结版本；缺失引用显式保留为不可定位，不能指向其他报告。 */
export function expertReferenceLabel(experts: ExpertConversation, ref: ExpertClaimRef) {
  return experts.references[ref.versionId] ?? '报告引用已缺失';
}
