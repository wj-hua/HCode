// 人工续跑的可见计划：目标、阶段与最少预算来自真实快照；最终准入仍由主进程复核。
import { COLLABORATION_LIMITS, type CollaborationResumeParams, type CollaborationSnapshot } from './collaboration.js';
import { EXPERT_ROLES, type ExpertResumeParams } from './experts.js';
import { AGENTS } from './agents.js';
import { collaborationInputTitle } from './collaborationPresentation.js';
import { codeCandidates, deliveryCode } from './codeCandidates.js';
import { adoptionBlocksEdits, adoptionNeedsRecovery } from './codeAdoption.js';

export interface RecoveryOption {
  id: string;
  label: string;
  target: string;
  stages: string;
  minTurns: number;
  blocked?: string;
  params: CollaborationResumeParams | ExpertResumeParams;
}

export function recoveryTarget(run: CollaborationSnapshot, targetId: string) {
  const expert = run.experts?.participants.find(entry => entry.id === targetId);
  if (expert) return `${EXPERT_ROLES[expert.role].name} · ${AGENTS[expert.backend.agent].name}`;
  const index = run.deliveries.findIndex(entry => entry.id === targetId);
  const delivery = run.deliveries[index];
  return delivery ? `任务 ${index + 1} · ${collaborationInputTitle(delivery.objective)}` : '目标已不存在';
}

/** 预算只展示最少所需回合；模型纠正与自动修订仍受原累计上限约束。 */
export function recoveryOptions(run: CollaborationSnapshot): RecoveryOption[] {
  if (['running', 'stopping', 'cancelled'].includes(run.status)) return [];
  const limit = run.experts?.turnLimit ?? COLLABORATION_LIMITS.maxTurns;
  const options = run.experts ? expertOptions(run) : deliveryOptions(run);
  const unfinishedAdoption = codeCandidates(run).some(({ code }) => adoptionNeedsRecovery(code.adoption));
  return options.map(option => ({ ...option, blocked: unfinishedAdoption ? '请先恢复原项目的未完成采纳' : option.blocked ?? (run.tasks.length + option.minTurns > limit ? '累计回合预算不足，请保留记录并另行决定下一步' : undefined) }));
}

function deliveryOptions(run: CollaborationSnapshot): RecoveryOption[] {
  if (run.params.mode === 'experts') return [];
  const reviewer = AGENTS[run.params.reviewer?.agent ?? run.params.initiator.agent].name;
  return run.deliveries.flatMap(delivery => {
    const code = deliveryCode(run, delivery);
    if (delivery.status === 'cancelled' || code?.workspace.state === 'discarded' || adoptionBlocksEdits(code?.adoption)) return [];
    const pending = run.messages?.some(message => message.deliveryId === delivery.id && message.type === 'clarification' && !run.messages?.some(reply => reply.replyTo === message.id));
    const blocked = code?.stopUnconfirmed ? '候选停止未确认，不能续跑' : pending ? '先保存此任务的澄清回复' : undefined;
    const target = recoveryTarget(run, delivery.id);
    return [
      { id: `${delivery.id}:execute`, label: code ? '修订候选' : '重新调研', target, stages: `${AGENTS[delivery.executor.agent].name} ${code ? '实现 / 修订 → 宿主验证' : '调研 / 修订'} → ${reviewer} 独立审查 → 当前会话汇总；其他任务不重做`, minTurns: 3, blocked, params: { deliveryId: delivery.id, action: 'execute' as const } },
      { id: `${delivery.id}:review`, label: code ? '验证并重新审查' : '重新审查', target, stages: `${code ? '宿主验证 → ' : ''}${reviewer} 审查第 ${delivery.versions.at(-1)?.version ?? 0} 版 → 有阻塞时仅修订本任务 → 当前会话汇总`, minTurns: 2, blocked: blocked ?? (!delivery.versions.length ? '尚无有效报告，请选择重新调研 / 修订' : undefined), params: { deliveryId: delivery.id, action: 'review' as const } },
    ];
  });
}

function expertOptions(run: CollaborationSnapshot): RecoveryOption[] {
  const state = run.experts!;
  const valid = state.participants.filter(expert => expert.status === 'reported' && expert.versions.length);
  const peerStages = '保留其他专家报告 → 团队重新互审 → 当前会话汇总';
  const options: RecoveryOption[] = state.participants.map(expert => ({ id: expert.id, label: '重新研究', target: recoveryTarget(run, expert.id), stages: `仅重做此专家研究 → ${peerStages}`, minTurns: state.participants.length + 2, params: { action: 'research', expertId: expert.id } }));
  options.push({ id: 'all', label: '全部重新研究', target: `${state.participants.length} 位专家`, stages: '全部专家重新研究 → 团队互审 → 当前会话汇总', minTurns: state.participants.length * 2 + 1, params: { action: 'research' } });
  if (state.activeIds.every(id => valid.some(expert => expert.id === id))) options.push({ id: 'review', label: '重新互审', target: `${state.activeIds.length} 份现有报告`, stages: '保留研究报告 → 团队重新互审 → 当前会话汇总', minTurns: state.activeIds.length + 1, params: { action: 'review' } });
  if (valid.length >= 2 && valid.length < state.participants.length) options.push({ id: 'partial', label: '以有效报告继续', target: `${valid.length} 位有效专家；其余专家将排除`, stages: '明确授权部分参与 → 有效报告互审 → 当前会话汇总', minTurns: valid.length + 1, params: { action: 'continuePartial' } });
  return options;
}
