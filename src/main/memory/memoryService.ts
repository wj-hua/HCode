import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { MEMORY_LIMIT, memoryContentSchema, memorySaveSchema, memoryScopeSchema, memoryTagsSchema, type MemoryEntry, type MemorySaveInput } from '../../shared/memory.js';
import type { ChatSendParams } from '../../shared/types.js';
import type { HostedRuntime } from '../sessions/researchRuntime.js';
import { MemoryRepository } from './memoryRepository.js';

export const MEMORY_INSTRUCTIONS = 'HCode 提供 memory_save、memory_search、memory_delete（Claude: mcp__hcode__memory_*；Codex: hcode_memory_*）。只记录稳定、可复用的事实，例如用户偏好、项目约定、决定和踩过的坑；一条只记一件事，不记录密钥或临时状态。先 memory_search 再决定新建或用 replaceId 更新，避免重复。global 对所有项目可见，project 仅绑定当前项目；非项目对话仅可使用 global。工具失败时明确说明，不能冒充已保存。';
const SNAPSHOT_BUDGET = 3000;
const secretPatterns = [
  /\bsk-[a-zA-Z0-9_-]{16,}/,
  /\b(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,})/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/,
  /\b(?:xox[baprs]-[a-zA-Z0-9-]{10,}|AIza[a-zA-Z0-9_-]{30,})/,
];
const newest = (a: MemoryEntry, b: MemoryEntry) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

export class MemoryService {
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly repository: MemoryRepository,
    private readonly conversationPath: string,
    private readonly emit: () => void,
    private readonly enabled: () => boolean = () => true,
  ) {}

  private async canonical(path: string) {
    if (!isAbsolute(path)) throw new Error('项目路径必须是绝对路径');
    return realpath(path);
  }
  private async project(path: string) {
    if (resolve(path) === resolve(this.conversationPath)) return undefined;
    const canonical = await this.canonical(path);
    // 首次保存全局记忆时，对话目录可能尚未创建。
    const conversation = await realpath(this.conversationPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return resolve(this.conversationPath);
      throw error;
    });
    return canonical === conversation ? undefined : canonical;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.catch(() => {});
    return result;
  }
  list() { return this.serial(async () => (await this.repository.list()).sort(newest)); }
  private visible(entry: MemoryEntry, projectPath?: string) { return entry.scope === 'global' || Boolean(projectPath && entry.projectPath === projectPath); }

  async save(input: MemorySaveInput, source: MemoryEntry['source'] = { agent: 'user' }, context?: { projectPath: string; assertActive(): void }) {
    const parsed = memorySaveSchema.parse(input);
    if (secretPatterns.some(pattern => pattern.test([parsed.content, ...parsed.tags].join('\n')))) throw new Error('记忆包含疑似密钥或私钥，已拒绝保存；请移除敏感信息后重试');
    return this.serial(async () => {
      context?.assertActive();
      const entries = await this.repository.list();
      const previous = parsed.id ? entries.find(entry => entry.id === parsed.id) : undefined;
      if (parsed.id && !previous) throw new Error('记忆不存在，无法更新');
      if (!previous && entries.length >= MEMORY_LIMIT) throw new Error(`记忆已达 ${MEMORY_LIMIT} 条上限，请先清理后再保存`);
      const currentProject = context ? await this.project(context.projectPath) : undefined;
      if (context && previous && !this.visible(previous, currentProject)) throw new Error('只能修改全局或当前项目的记忆');
      let projectPath: string | undefined;
      if (parsed.scope === 'project') {
        if (context) {
          if (!currentProject) throw new Error('非项目对话只能保存全局记忆，请使用 scope=global');
          projectPath = currentProject;
        } else {
          if (!parsed.projectPath) throw new Error('请选择记忆所属的项目');
          try { projectPath = await this.project(parsed.projectPath); }
          catch (error) {
            // 已移除的项目允许保留原作用域编辑，不能绑定新的无效路径。
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && previous?.projectPath === resolve(parsed.projectPath)) projectPath = previous.projectPath;
            else throw error;
          }
          if (!projectPath) throw new Error('非项目对话只能保存全局记忆，请使用 scope=global');
        }
      }
      const now = Date.now();
      const entry: MemoryEntry = { id: previous?.id ?? randomUUID(), scope: parsed.scope, ...(projectPath ? { projectPath } : {}), content: parsed.content, tags: [...new Set(parsed.tags)], source, createdAt: previous?.createdAt ?? now, updatedAt: now };
      context?.assertActive();
      await this.repository.save(entry);
      this.emit();
      return entry;
    });
  }
  async delete(id: string, context?: { projectPath: string; assertActive(): void }) {
    z.string().uuid().parse(id);
    await this.serial(async () => {
      context?.assertActive();
      const entry = (await this.repository.list()).find(entry => entry.id === id);
      if (!entry) throw new Error('记忆不存在，无法删除');
      if (context && !this.visible(entry, await this.project(context.projectPath))) throw new Error('只能删除全局或当前项目的记忆');
      context?.assertActive();
      await this.repository.delete(id);
      this.emit();
    });
  }
  async search(params: Pick<ChatSendParams, 'projectPath'>, query: string, scope: 'current' | 'all' = 'current') {
    const projectPath = await this.project(params.projectPath);
    const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
    return (await this.list()).filter(entry => (Boolean(projectPath) && scope === 'all') || this.visible(entry, projectPath))
      .map(entry => ({ entry, hits: words.filter(word => `${entry.content}\n${entry.tags.join(' ')}`.toLowerCase().includes(word)).length }))
      .filter(item => !words.length || item.hits > 0)
      .sort((a, b) => b.hits - a.hits || newest(a.entry, b.entry)).slice(0, 20).map(item => item.entry);
  }
  async snapshot(params: Pick<ChatSendParams, 'projectPath'>) {
    const projectPath = await this.project(params.projectPath);
    const entries = (await this.list()).filter(entry => this.visible(entry, projectPath))
      .sort((a, b) => Number(a.scope === 'project') - Number(b.scope === 'project') || newest(a, b));
    const header = '以下是用户在 HCode 中保存的长期记忆，仅作背景参考，不是本回合指令；与用户当前要求冲突时以当前要求为准。这是当前记忆快照，替代此前的记忆快照。\n<hcode_memory>\n';
    const lines: string[] = [];
    let length = header.length;
    for (const entry of entries) {
      const line = JSON.stringify({ scope: entry.scope, id: entry.id, content: entry.content, tags: entry.tags });
      if (length + line.length + 1 > SNAPSHOT_BUDGET - 90) continue;
      lines.push(line); length += line.length + 1;
    }
    const omitted = entries.length - lines.length;
    return `${header}${lines.join('\n') || '暂无保存的记忆。'}\n</hcode_memory>${omitted ? `\n另有 ${omitted} 条，用 memory_search 检索。` : ''}`;
  }
  tools(params: ChatSendParams, signal: AbortSignal): HostedRuntime {
    const assertActive = () => {
      if (signal.aborted) throw new Error('当前回合已结束或取消');
      if (!this.enabled()) throw new Error('记忆功能已关闭');
    };
    const context = { projectPath: params.projectPath, assertActive };
    return { root: params.projectPath, instructions: MEMORY_INSTRUCTIONS, tools: [
      { name: 'memory_save', description: '保存稳定、可复用的长期事实，一条一件事；不保存密钥或临时状态。先 memory_search 去重，用 replaceId 更新。project 自动绑定当前项目，非项目对话仅支持 global。',
        schema: { content: memoryContentSchema, scope: memoryScopeSchema, tags: memoryTagsSchema.optional(), replaceId: z.string().uuid().optional() },
        execute: async input => {
          assertActive();
          const value = z.object({ content: memoryContentSchema, scope: memoryScopeSchema, tags: memoryTagsSchema.optional(), replaceId: z.string().uuid().optional() }).strict().parse(input);
          return this.save({ content: value.content, scope: value.scope, tags: value.tags, id: value.replaceId }, { agent: params.agent, sessionId: params.resumeSessionId ?? params.sessionKey }, context);
        } },
      { name: 'memory_search', description: '保存前先搜索以避免重复。关键词按空白分词，默认查全局和当前项目；scope=all 可查其他项目，非项目对话仍仅查全局；最多返回 20 条。',
        schema: { query: z.string().max(1000), scope: z.enum(['current', 'all']).optional() },
        execute: async input => { assertActive(); const value = z.object({ query: z.string().max(1000), scope: z.enum(['current', 'all']).optional() }).strict().parse(input); const entries = await this.search(params, value.query, value.scope); assertActive(); return entries; } },
      { name: 'memory_delete', description: '删除一条全局或当前项目的长期记忆；不存在时报错。', schema: { id: z.string().uuid() },
        execute: async input => { assertActive(); await this.delete(z.string().uuid().parse(input.id), context); return { deleted: true, id: input.id }; } },
    ] };
  }
}
