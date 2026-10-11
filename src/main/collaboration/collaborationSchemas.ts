// 协作输入、源码报告和版本的共享运行时契约；不含流程编排或 IO。
import { z } from "zod";
import {
  COLLABORATION_LIMITS,
  COLLABORATION_WORKER_AGENTS,
} from "../../shared/collaboration.js";
import { codeStartSchema } from "./workspaces/codeContracts.js";
export const backendSchema = z
  .object({
    agent: z.enum(COLLABORATION_WORKER_AGENTS),
    model: z.string().optional(),
  })
  .strict();
export const startSchema = z
  .object({
    mode: z.literal("delegation").optional(),
    initiator: z
      .object({
        agent: z.enum(["claude", "codex"]),
        sessionKey: z.string().uuid(),
        resumeSessionId: z.string().optional(),
        projectPath: z.string().min(1),
        permissionMode: z.enum([
          "default",
          "plan",
          "acceptEdits",
          "bypassPermissions",
          "dontAsk",
          "read-only",
          "on-request",
          "untrusted",
          "full-access",
        ]),
        model: z.string().optional(),
        effort: z.string().optional(),
      })
      .strict(),
    executor: backendSchema,
    reviewer: backendSchema.optional(),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(COLLABORATION_LIMITS.maxContextLength),
    code: codeStartSchema.optional(),
  })
  .strict();

export const reportSchema = z
  .object({
    summary: z.string().min(1).max(2000),
    findings: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            title: z.string().min(1).max(200),
            detail: z.string().min(1).max(4000),
            evidence: z
              .array(
                z
                  .object({
                    path: z.string().min(1),
                    startLine: z.number().int().positive(),
                    endLine: z.number().int().positive(),
                    quote: z
                      .string()
                      .min(1)
                      .max(COLLABORATION_LIMITS.maxContextLength),
                  })
                  .strict(),
              )
              .max(8),
          })
          .strict(),
      )
      .max(20),
    limitations: z.array(z.string().min(1).max(1000)).max(10),
  })
  .strict();

export const reviewSchema = z
  .object({
    verdict: z.enum(["approved", "changesRequested", "inconclusive"]),
    summary: z.string().min(1).max(2000),
    issues: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            blocking: z.boolean(),
            location: z.string().min(1),
            reason: z.string().min(1).max(2000),
            evidence: z.string().min(1).max(2000),
            suggestion: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.verdict === "approved" &&
      result.issues.some((issue) => issue.blocking)
    )
      context.addIssue({
        code: "custom",
        message: "存在阻塞问题，不能审查通过",
      });
    if (
      result.verdict === "changesRequested" &&
      !result.issues.some((issue) => issue.blocking)
    )
      context.addIssue({
        code: "custom",
        message: "修订请求必须有具体阻塞问题",
      });
    if (
      new Set(result.issues.map((issue) => issue.id)).size !==
      result.issues.length
    )
      context.addIssue({ code: "custom", message: "审查问题 id 重复" });
  });

export const evidenceSchema = z
  .object({
    path: z.string(),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const versionSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    summary: z.string(),
    evidence: z.array(evidenceSchema),
  })
  .strict();
