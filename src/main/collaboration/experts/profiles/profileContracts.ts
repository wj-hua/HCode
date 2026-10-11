// 冻结配置由宿主生成；恢复时校验引用和内容摘要，禁止客户端注入职责正文。
import { z } from "zod";
import {
  BUSINESS_EXPERT_TYPES,
  EXPERT_PROFILE_LIMITS,
} from "../../../../shared/expertProfiles.js";
export const profileHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const fileRefSchema = z
  .object({
    name: z.string().min(1),
    sourcePath: z.string().min(1),
    hash: profileHashSchema,
  })
  .strict();
export const profileSnapshotSchema = z
  .object({
    role: z.enum(BUSINESS_EXPERT_TYPES),
    hash: profileHashSchema,
    loading: z.literal("instruction"),
    roles: z.array(fileRefSchema).min(1).max(8),
    skills: z.array(fileRefSchema).min(1).max(8),
    resources: z
      .array(fileRefSchema.extend({ skill: z.string() }))
      .max(EXPERT_PROFILE_LIMITS.maxResources * 8),
    limitations: z.array(z.string()),
  })
  .strict();
export const profileLoadSchema = z
  .object({
    hash: profileHashSchema,
    loading: z.literal("instruction"),
    stage: z.enum(["research", "review"]),
    sessionKey: z.string().uuid(),
  })
  .strict();
export const resourceReadSchema = z
  .object({
    skill: z.string(),
    path: z.string(),
    hash: profileHashSchema,
    stage: z.enum(["research", "review"]),
    sessionKey: z.string().uuid(),
  })
  .strict();
