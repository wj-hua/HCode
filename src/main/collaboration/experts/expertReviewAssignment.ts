// 按参与角色确定专项审查关系；没有相关角色时明确退为通用证据审查。
import type { ExpertParticipant } from "../../../shared/experts.js";
import { PROFILE_DEFINITIONS } from "./profiles/profileDefinitions.js";
import type { BusinessExpertType } from "../../../shared/expertProfiles.js";
export function expertReviewAssignment(
  target: ExpertParticipant,
  active: ExpertParticipant[],
) {
  const definition = PROFILE_DEFINITIONS[target.role as BusinessExpertType];
  const specialist = definition?.reviewers
    .map((role) =>
      active.find((expert) => expert.role === role && expert.id !== target.id),
    )
    .find(Boolean);
  if (specialist)
    return { reviewerId: specialist.id, assignment: "domain" as const };
  const index = active.findIndex((expert) => expert.id === target.id),
    reviewer = active[(index + 1) % active.length];
  if (!reviewer || reviewer.id === target.id)
    throw new Error("没有其他专家可进行证据审查");
  return { reviewerId: reviewer.id, assignment: "evidence" as const };
}
