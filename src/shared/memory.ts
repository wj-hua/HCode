import { z } from 'zod';
import { AGENT_KINDS } from './agents.js';

export const MEMORY_LIMIT = 500;
export const memoryScopeSchema = z.enum(['global', 'project']);
export const memoryContentSchema = z.string().trim().min(1).max(1000);
export const memoryTagsSchema = z.array(z.string().trim().min(1).max(64)).max(8);
export const memorySaveSchema = z.object({
  id: z.string().uuid().optional(),
  scope: memoryScopeSchema,
  projectPath: z.string().min(1).optional(),
  content: memoryContentSchema,
  tags: memoryTagsSchema.default([]),
}).strict();
export const memoryEntrySchema = memorySaveSchema.extend({
  id: z.string().uuid(),
  source: z.object({ agent: z.enum([...AGENT_KINDS, 'user']), sessionId: z.string().optional() }),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
}).superRefine((entry, ctx) => {
  if ((entry.scope === 'project') !== Boolean(entry.projectPath)) {
    ctx.addIssue({ code: 'custom', message: '项目记忆必须提供项目路径；全局记忆不能绑定项目', path: ['projectPath'] });
  }
});

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemorySaveInput = z.input<typeof memorySaveSchema>;
