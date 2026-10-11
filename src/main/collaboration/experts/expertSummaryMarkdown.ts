// 将已校验的主持结论转为用户可读汇总；保留专家、版本和 claim 来源。
import type { CollaborationSnapshot } from "../../../shared/collaboration.js";

export function expertSummaryMarkdown(
  summary: NonNullable<CollaborationSnapshot["experts"]>["summary"] & {},
) {
  const section = (
    name: string,
    entries: {
      statement: string;
      sources: { expertId: string; versionId: string; claimId: string }[];
    }[],
  ) =>
    `### ${name}\n\n${entries.length ? entries.map((entry) => `- ${entry.statement}\n  来源：${entry.sources.map((ref) => `${ref.expertId} / ${ref.versionId} / ${ref.claimId}`).join("；")}`).join("\n") : "无"}`;
  return [
    summary.summary,
    section("经互审支持的共识", summary.consensus),
    section("未解决分歧", summary.disagreements),
    section("证据不足与未验证事项", summary.unverified),
    "### 局限\n\n" +
      summary.limitations.map((limit) => `- ${limit}`).join("\n"),
    ...(summary.failedExperts.length
      ? ["### 未参与本轮互审的专家\n\n" + summary.failedExperts.join("\n")]
      : []),
  ].join("\n\n");
}
