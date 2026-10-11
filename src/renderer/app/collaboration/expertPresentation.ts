// 专家身份与冻结引用的用户可读名称；同后端/模型不能作为独立模型来源。
import {
  EXPERT_ROLES,
  type ExpertState,
  type ExpertSelection,
} from "@hcode/shared/experts";
import { AGENTS } from "@hcode/shared/agents";
export function expertLabel(state: ExpertState, id: string) {
  const expert = state.participants.find((entry) => entry.id === id);
  if (!expert) throw new Error("专家引用不属于本次协作");
  return `${EXPERT_ROLES[expert.role].name} · ${AGENTS[expert.backend.agent].name}`;
}
export function hasRepeatedExpertBackend(experts: ExpertSelection[]) {
  const identities = experts.map(
    (expert) => `${expert.backend.agent}/${expert.backend.model ?? "default"}`,
  );
  return new Set(identities).size < identities.length;
}
