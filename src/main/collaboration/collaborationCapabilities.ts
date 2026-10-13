// 后端安装/协议能力与当前线程资格分开核验；旧线程限制不影响其作为执行后端。
import { z } from 'zod';
import type { CollaborationCapabilities, CollaborationSource } from '../../shared/collaboration.js';
import type { AgentRegistry } from '../agents/registry.js';
import { AGY_COLLABORATION_VERSION, GEMINI_MODEL_PREFIX, AGY_SOURCE_LIMITATION } from "../agents/agy/agyResearchSession.js";
import { CODEX_RESEARCH_PROTOCOL_VERSION } from '../sessions/researchRuntime.js';
/** 查询不修改会话，不加载模型，不创建替代线程；元数据 IO 错误由调用方展示。 */
export async function collaborationCapabilities(agents: AgentRegistry, platform: NodeJS.Platform, source?: CollaborationSource): Promise<CollaborationCapabilities[]> {
  if (source) z.object({ agent: z.enum(['claude', 'codex', 'agy', 'cline']), resumeSessionId: z.string().min(1).optional() }).strict().parse(source);
  return Promise.all(agents.all().map(async (provider) => {
    const status = await provider.getStatus(true);
    const nativeSource = status.found && (provider.kind === 'claude' || provider.kind === 'codex' && platform === 'darwin' && status.version?.includes(CODEX_RESEARCH_PROTOCOL_VERSION) === true);
    const agySupported = status.found && provider.kind === 'agy' && platform === 'darwin' && status.version === AGY_COLLABORATION_VERSION;
    let models: Awaited<ReturnType<typeof provider.listModels>> | undefined, modelError: string | undefined;
    if (agySupported) {
      try { models = (await provider.listModels()).filter((entry) => entry.value.startsWith(GEMINI_MODEL_PREFIX)); if (!models.length) modelError = 'agy 未返回可用 Gemini 模型'; }
      catch (error) { modelError = `agy 模型查询失败：${error instanceof Error ? error.message : String(error)}`; }
    }
    const canExecute = nativeSource || agySupported && !modelError;
    const sourceReason = nativeSource && source?.agent === provider.kind && source.resumeSessionId ? await provider.collaborationSourceReason?.(source.resumeSessionId) : undefined;
    return { agent: provider.kind, canExecute, canReview: canExecute, canExecuteCode: nativeSource, canInitiate: nativeSource && !sourceReason, version: status.version, ...(models ? { models } : {}),
      reason: modelError ?? sourceReason ?? (!status.found ? '未安装 CLI' : agySupported ? AGY_SOURCE_LIMITATION + '；登录、额度与实际回合错误会明确返回' : nativeSource ? '支持受限协作；登录、额度与实际回合错误会明确返回' : '该平台、版本或后端尚未验证协作路径') };
  }));
}
