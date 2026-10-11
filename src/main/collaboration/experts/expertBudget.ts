// 在共享硬预算内给未开始的研究、互审与主持汇总预留回合；格式修正不能挤掉后续阶段。
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";
export function expertReservedTurns(
  snapshot: CollaborationSnapshot,
  expertId?: string,
  sessionKey?:string,
  researchStart = 0,
) {
  const state = snapshot.experts!;
  if (snapshot.stage === "planning") return state.activeIds.length * 2 + 1;
  if (snapshot.stage === "expertResearch") {
    const pending = state.participants.filter(
      (expert) =>
        state.activeIds.includes(expert.id) &&
        expert.id !== expertId &&
        ["queued", "researching"].includes(expert.status) &&
        // 首轮已花费的回合不重复预留；模型回合完成与报告冻结之间仍可能是 researching。
        !snapshot.tasks.slice(researchStart).some(
          (task) =>
            task.expertId === expert.id &&
            task.role === "execution",
        ),
    ).length;
    return pending + state.activeIds.length + 1;
  }
  if (snapshot.stage === "peerReview")
    return (
      state.reviews.filter(
        (review) =>
          ["queued", "reviewing"].includes(review.status) &&
          review.sessionKey !== sessionKey &&
          !snapshot.tasks.some(
            (task) =>
              task.sessionKey === review.sessionKey &&
              task.role === "review",
          ),
      ).length + 1
    );
  return 0;
}
