// 应用请求及恢复日志严格校验，历史 S5a 不要求存在采纳字段。
import { z } from "zod";
export const adoptionHash = z.string().regex(/^[a-f0-9]{64}$/);
export const adoptionPath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path
        .split("/")
        .every(
          (part) =>
            part &&
            part !== "." &&
            part !== ".." &&
            part !== ".git" &&
            part !== "node_modules" &&
            part !== ".hcode-apply-lock",
        ),
    "路径不属于可采纳范围",
  );
export const adoptionRequestSchema = z
  .object({ versionId: z.string().uuid(), previewHash: adoptionHash })
  .strict();
export const adoptionStateSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    versionId: z.string().uuid(),
    versionHash: adoptionHash,
    previewHash: adoptionHash,
    status: z.enum([
      "prepared",
      "applying",
      "applied",
      "needsRecovery",
      "rolledBack",
    ]),
    cleanupPending: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
    changedPaths: z.array(adoptionPath),
    error: z.string().optional(),
  })
  .strict();
export const adoptionEntrySchema = z
  .object({
    path: adoptionPath,
    hash: adoptionHash,
    mode: z.number().int().min(0).max(0o777),
    bytes: z.number().int().nonnegative(),
    binary: z.boolean(),
    link: z.string().optional(),
  })
  .strict();
export const adoptionJournalSchema = z
  .object({
    state: adoptionStateSchema,
    originalPath: z.string().min(1),
    rootDevice: z.number(),
    rootInode: z.number(),
    createdDirectories: z.array(
      z
        .object({
          path: adoptionPath,
          device: z.number().optional(),
          inode: z.number().optional(),
        })
        .strict(),
    ),
    operations: z.array(
      z
        .object({
          path: adoptionPath,
          before: adoptionEntrySchema.nullable(),
          after: adoptionEntrySchema.nullable(),
          started: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((journal, context) => {
    const paths = journal.operations.map((op) => op.path);
    if (
      new Set(paths).size !== paths.length ||
      JSON.stringify(paths) !== JSON.stringify(journal.state.changedPaths) ||
      journal.operations.some(
        (op) =>
          (op.before?.path !== op.path && op.before !== null) ||
          (op.after?.path !== op.path && op.after !== null) ||
          op.before?.link ||
          op.after?.link,
      )
    )
      context.addIssue({
        code: "custom",
        message: "采纳日志路径或链接状态不一致",
      });
  });
export type AdoptionJournal = z.infer<typeof adoptionJournalSchema>;
