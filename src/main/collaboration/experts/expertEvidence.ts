// 互审必须覆盖冻结报告每个 claim；汇总不能把争议或缺证据自动升级为共识。
import { createHash } from "node:crypto";
import type {
  ExpertState,
  ExpertClaimRef,
  ExpertSummary,
  PeerClaim,
} from "../../../shared/experts.js";
import { reportSchema } from "../collaborationSchemas.js";
import { validateReport, assertEvidenceCurrent } from "../reportEvidence.js";
import type { CollaborationRepository } from "../collaborationRepository.js";
import { peerResultSchema } from "./expertContracts.js";

/** 以参与报告实际读取的文件集合确认一致版本，外部改动使阶段失效。 */
export async function expertContext(root: string, state: ExpertState) {
  const files = new Map<string, string>();
  for (const participant of state.participants.filter((expert) =>
    state.activeIds.includes(expert.id),
  )) {
    const version = participant.versions.at(-1);
    if (!version) throw new Error("专家缺少有效报告");
    await assertEvidenceCurrent(root, version.evidence);
    for (const evidence of version.evidence) {
      const known = files.get(evidence.path);
      if (known && known !== evidence.hash)
        throw new Error("专家读取的源码版本不一致，请重新研究");
      files.set(evidence.path, evidence.hash);
    }
  }
  for (const review of state.reviews.filter(
    (entry) =>
      entry.status === "completed" &&
      state.activeIds.includes(entry.targetId) &&
      state.participants
        .find((expert) => expert.id === entry.targetId)
        ?.versions.at(-1)?.id === entry.versionId,
  ))
    await assertEvidenceCurrent(
      root,
      (review.claims ?? []).flatMap((claim) => claim.evidence),
    );
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...files.entries()].sort(([first], [second]) =>
          first.localeCompare(second),
        ),
      ),
    )
    .digest("hex");
}

/** 覆盖目标全部 claim 并核对准确源码行；返回带宿主 hash 的审查证据。 */
export async function validatePeer(
  root: string,
  input: unknown,
  report: ReturnType<typeof reportSchema.parse>,
) {
  const review = peerResultSchema.parse(input),
    claims = new Set(report.findings.map((finding) => finding.id));
  if (
    review.claims.length !== claims.size ||
    new Set(review.claims.map((claim) => claim.claimId)).size !== claims.size ||
    review.claims.some((claim) => !claims.has(claim.claimId))
  )
    throw new Error(
      "互审必须逐项覆盖冻结报告的全部 claimId，不能遗漏或引用不存在的结论",
    );
  const frozen: PeerClaim[] = [];
  for (const claim of review.claims) {
    if (claim.assessment !== "insufficientEvidence" && !claim.evidence.length)
      throw new Error("支持或反驳必须引用实际源码证据");
    const validated = claim.evidence.length
      ? await validateReport(
          root,
          JSON.stringify({
            summary: review.summary,
            findings: [
              {
                id: claim.claimId,
                title: claim.claimId,
                detail: claim.reason,
                evidence: claim.evidence,
              },
            ],
            limitations: review.limitations,
          }),
        )
      : undefined;
    frozen.push({ ...claim, evidence: validated ? validated.evidence : [] });
  }
  return { ...review, claims: frozen };
}

function claimKey(ref: ExpertClaimRef) {
  return `${ref.expertId}/${ref.versionId}/${ref.claimId}`;
}
/** 只接受当前版本真实引用；共识必须获支持，分歧和缺证据项不得遗漏。 */
export function validateExpertSummary(
  summary: ExpertSummary,
  state: ExpertState,
  reports: Map<string, ReturnType<typeof reportSchema.parse>>,
) {
  const assessments = new Map<string, string>();
  for (const id of state.activeIds) {
    const expert = state.participants.find(
        (participant) => participant.id === id,
      )!,
      version = expert.versions.at(-1)!;
    const review = state.reviews.findLast(
      (entry) =>
        entry.targetId === id &&
        entry.versionId === version.id &&
        entry.status === "completed",
    );
    if (!review?.claims) throw new Error("缺少当前报告版本的完整互审");
    for (const claim of review.claims)
      assessments.set(
        claimKey({
          expertId: id,
          versionId: version.id,
          claimId: claim.claimId,
        }),
        claim.assessment,
      );
  }
  for (const [category, conclusions] of Object.entries({
    consensus: summary.consensus,
    disagreements: summary.disagreements,
    unverified: summary.unverified,
  })) {
    for (const conclusion of conclusions) {
      if (
        category === "consensus" &&
        new Set(conclusion.sources.map((ref) => ref.expertId)).size < 2
      )
        throw new Error("共识必须至少引用两位专家经互审支持的结论");
      for (const ref of conclusion.sources) {
        if (
          !reports
            .get(ref.expertId)
            ?.findings.some((claim) => claim.id === ref.claimId) ||
          !assessments.has(claimKey(ref))
        )
          throw new Error("汇总引用不属于当前有效专家、版本或 claim");
        if (
          category === "consensus" &&
          assessments.get(claimKey(ref)) !== "supported"
        )
          throw new Error("争议或证据不足的结论不能列为共识");
      }
    }
  }
  const covered = (entries: ExpertSummary["disagreements"]) =>
    new Set(entries.flatMap((entry) => entry.sources.map(claimKey)));
  const disputed = covered(summary.disagreements),
    insufficient = covered(summary.unverified);
  for (const [key, assessment] of assessments) {
    if (
      (assessment === "disputed" && !disputed.has(key)) ||
      (assessment === "insufficientEvidence" && !insufficient.has(key))
    )
      throw new Error("汇总遗漏未解决的分歧或证据不足的结论");
  }
  const failed = state.participants
    .filter((expert) => !state.activeIds.includes(expert.id))
    .map((expert) => expert.id);
  if (
    summary.failedExperts.length !== failed.length ||
    new Set(summary.failedExperts).size !== failed.length ||
    summary.failedExperts.some((id) => !failed.includes(id))
  )
    throw new Error("汇总未如实列出未参与本轮互审的专家");
  return summary;
}

/** 工具只读取本 Run 的冻结报告；源身份和参与者清单由宿主提供。 */
export async function expertSummaryData(
  runId: string,
  state: ExpertState,
  repository: CollaborationRepository,
) {
  const participants = await Promise.all(
    state.participants.map(async (participant) => ({
      id: participant.id,
      role: participant.role,
      backend: participant.backend,
      status: participant.status,
      profile:participant.profile,
      profileLoads:participant.profileLoads,
      resourceReads:participant.resourceReads,
      versions: participant.versions,
      error: participant.error,
      ...(participant.versions.length
        ? {
            report: JSON.parse(
              (await repository.readReport(runId, participant.versions.at(-1)!))
                .text,
            ),
          }
        : {}),
    })),
  );
  return {
    participants,
    reviews: state.reviews.map(({ rawResults, ...review }) => review),
    activeIds: state.activeIds,
    contextHash: state.contextHash,
    partialAuthorized: state.partialAuthorized,
  };
}
