// 专家输入、claim 互审与主持结论的契约；身份与版本由宿主填入，不相信模型自报。
import { z } from "zod";
import { EXPERT_ROLES, EXPERT_LIMITS,expertMinimumTurns } from "../../../shared/experts.js";
import { COLLABORATION_LIMITS } from "../../../shared/collaboration.js";
import { BUSINESS_EXPERT_TYPES } from "../../../shared/expertProfiles.js";
import {
  startSchema,
  backendSchema,
  versionSchema,
  evidenceSchema,
} from "../collaborationSchemas.js";
import {profileSnapshotSchema,profileHashSchema,profileLoadSchema,resourceReadSchema} from "./profiles/profileContracts.js";
const roleSchema = z.enum(
  Object.keys(EXPERT_ROLES) as [
    keyof typeof EXPERT_ROLES,
    ...(keyof typeof EXPERT_ROLES)[],
  ],
);
const selectionSchema = z
  .object({ role: roleSchema, backend: backendSchema, profileHash: profileHashSchema.optional() })
  .strict();
export const expertStartSchema = z
  .object({
    mode: z.literal("experts"),
    initiator: startSchema.shape.initiator,
    objective: startSchema.shape.objective,
    turnLimit: z.number().int().min(expertMinimumTurns(EXPERT_LIMITS.minParticipants)).max(EXPERT_LIMITS.maxTurns).optional(),
    acceptProfileLimitations: z.boolean().optional(),
    experts: z
      .array(selectionSchema)
      .min(EXPERT_LIMITS.minParticipants)
      .max(EXPERT_LIMITS.maxParticipants),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.turnLimit ?? COLLABORATION_LIMITS.maxTurns) < expertMinimumTurns(input.experts.length)) context.addIssue({code:"custom",message:"专家预算不足以完成调研、互审和原会话汇总"});
    if (
      new Set(input.experts.map((expert) => expert.role)).size !==
      input.experts.length
    )
      context.addIssue({ code: "custom", message: "专家角色不能重复" });
  });
export const peerResultSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    claims: z
      .array(
        z
          .object({
            claimId: z.string().min(1).max(100),
            assessment: z.enum([
              "supported",
              "disputed",
              "insufficientEvidence",
            ]),
            reason: z.string().min(1).max(2000),
            evidence: z.array(evidenceSchema.omit({ hash: true })).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    limitations: z.array(z.string().min(1).max(1000)).max(10),
  })
  .strict();
const refSchema = z
  .object({
    expertId: z.string().uuid(),
    versionId: z.string().uuid(),
    claimId: z.string().min(1),
  })
  .strict();
const conclusionSchema = z
  .object({
    statement: z.string().min(1).max(2000),
    sources: z.array(refSchema).min(1).max(20),
  })
  .strict();
export const expertSummarySchema = z
  .object({
    summary: z.string().min(1).max(2000),
    consensus: z
      .array(
        conclusionSchema.extend({ sources: z.array(refSchema).min(2).max(20) }),
      )
      .max(20),
    disagreements: z.array(conclusionSchema).max(20),
    unverified: z.array(conclusionSchema).max(20),
    limitations: z.array(z.string().min(1).max(1000)).min(1).max(20),
    failedExperts: z
      .array(z.string().uuid())
      .max(EXPERT_LIMITS.maxParticipants),
  })
  .strict();
const participantSchema = selectionSchema
  .extend({
    id: z.string().uuid(),
    sessionKey: z.string().uuid(),
    status: z.enum([
      "queued",
      "researching",
      "reported",
      "failed",
      "interrupted",
    ]),
    versions: z.array(versionSchema),
    profile: profileSnapshotSchema.optional(),
    profileLoads: z.array(profileLoadSchema).optional(),
    resourceReads: z.array(resourceReadSchema).optional(),
    error: z.string().optional(),
    rawResults: z.array(z.string()),
  })
  .strict();
const frozenClaimSchema = peerResultSchema.shape.claims.element.extend({
  evidence: z.array(evidenceSchema).max(8),
});
const peerSchema = z
  .object({
    id: z.string().uuid(),
    assignment: z.enum(["domain","evidence"]).optional(),
    targetId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewerId: z.string().uuid(),
    sessionKey: z.string().uuid(),
    nativeSessionId: z.string().optional(),
    status: z.enum([
      "queued",
      "reviewing",
      "completed",
      "failed",
      "interrupted",
    ]),
    summary: peerResultSchema.shape.summary.optional(),
    claims: z.array(frozenClaimSchema).optional(),
    limitations: peerResultSchema.shape.limitations.optional(),
    error: z.string().optional(),
    rawResults: z.array(z.string()),
  })
  .strict();
export const expertStateSchema = z
  .object({
    participants: z
      .array(participantSchema)
      .min(EXPERT_LIMITS.minParticipants)
      .max(EXPERT_LIMITS.maxParticipants),
    reviews: z.array(peerSchema),
    contextHash: z.string().optional(),
    activeIds: z
      .array(z.string().uuid())
      .min(EXPERT_LIMITS.minParticipants)
      .max(EXPERT_LIMITS.maxParticipants),
    partialAuthorized: z.boolean(),
    summary: expertSummarySchema.optional(),
    rawSummaries: z.array(z.string()),
    turnLimit: z.number().int().min(expertMinimumTurns(EXPERT_LIMITS.minParticipants)).max(EXPERT_LIMITS.maxTurns).optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const experts = new Map(
      state.participants.map((expert) => [expert.id, expert]),
    );
    const invalid = () =>
      context.addIssue({
        code: "custom",
        message: "专家记录的身份、版本或互审关系无效",
      });
    if (
      experts.size !== state.participants.length ||
      new Set(state.participants.map((expert) => expert.sessionKey)).size !==
        experts.size ||
      new Set(state.participants.map((expert) => expert.role)).size !==
        experts.size
    )
      invalid();
    if (
      new Set(state.activeIds).size !== state.activeIds.length ||
      state.activeIds.some((id) => !experts.has(id)) ||
      (!state.partialAuthorized && state.activeIds.length !== experts.size)
    )
      invalid();
    for (const expert of state.participants) {
      if(BUSINESS_EXPERT_TYPES.some(role=>role===expert.role)&&!expert.profile)invalid();
      if (expert.status === "reported" && !expert.versions.length) invalid();
      if (expert.profile && (expert.profile.role!==expert.role || expert.profile.hash!==expert.profileHash || expert.profileLoads?.some(load=>load.hash!==expert.profile!.hash))) invalid();
    }
    if (
      new Set(state.reviews.map((review) => review.id)).size !==
        state.reviews.length ||
      new Set([
        ...state.participants.map((expert) => expert.sessionKey),
        ...state.reviews.map((review) => review.sessionKey),
      ]).size !==
        experts.size + state.reviews.length
    )
      invalid();
    for (const review of state.reviews) {
      const target = experts.get(review.targetId),
        version = target?.versions.find(
          (entry) => entry.id === review.versionId,
        );
      if (
        !version ||
        version.hash !== review.versionHash ||
        !experts.has(review.reviewerId) ||
        review.targetId === review.reviewerId
      )
        invalid();
      if (
        review.status === "completed" &&
        (!review.summary || !review.claims?.length || !review.limitations)
      )
        invalid();
    }
    const refs = state.summary
      ? [
          ...state.summary.consensus,
          ...state.summary.disagreements,
          ...state.summary.unverified,
        ].flatMap((entry) => entry.sources)
      : [];
    if (
      refs.some(
        (ref) =>
          !experts
            .get(ref.expertId)
            ?.versions.some((version) => version.id === ref.versionId),
      )
    )
      invalid();
  });
export const expertResumeSchema = z
  .object({
    action: z.enum(["research", "review", "continuePartial"]),
    expertId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action !== "research" && input.expertId)
      context.addIssue({ code: "custom", message: "此操作不能指定单个专家" });
  });
