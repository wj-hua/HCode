// 普通委派的 CLI 准入与模型发现；读取 Provider 元数据，不启动模型回合或替换用户选定的模型。
import { INVOCATION_AGENTS, type AgentInvocationInput, type InvocationAgent } from '../../shared/agentInvocation.js';
import { AGENTS } from '../../shared/agents.js';
import type { AgentRegistry } from '../agents/registry.js';
import { AGY_COLLABORATION_VERSION, GEMINI_MODEL_PREFIX } from '../agents/agy/agyResearchSession.js';

const AGY_READ_ONLY_VERSIONS: readonly string[] = [AGY_COLLABORATION_VERSION, '1.4.3'];
const AGY_LIMITATION = 'agy/Gemini 无头模式不支持交互审批，需要确认的操作会被拒绝；只读调用使用隔离研究角色，仅支持已验证版本。';

/** 只读角色的 CLI 协议单独准入；普通执行继续使用 Provider 的原生权限与生命周期。 */
function agyReadOnlySupported(version: string | undefined, platform: NodeJS.Platform) {
  return platform === 'darwin' && version !== undefined && AGY_READ_ONLY_VERSIONS.includes(version);
}

/** 模型列表失败作为目标不可用原因展示，不把失败伪装为没有模型。 */
export async function listInvocationTargets(agents: AgentRegistry, platform: NodeJS.Platform = process.platform) {
  return Promise.all(INVOCATION_AGENTS.map(async agent => {
    try {
      const provider = agents.get(agent);
      const status = await provider.getStatus();
      if (!status.found) return { agent, available: false, reason: status.error ?? `未安装 ${AGENTS[agent].name} CLI` };
      const models = await provider.listModels();
      const selectableModels = agent === 'agy' ? models.filter(model => model.value.startsWith(GEMINI_MODEL_PREFIX)) : models;
      if (agent === 'agy' && !selectableModels.length) return { agent, available: false, reason: 'agy 未返回可用 Gemini 模型', limitation: AGY_LIMITATION };
      return {
        agent, available: true, version: status.version,
        canReadOnly: agent !== 'agy' || agyReadOnlySupported(status.version, platform), canExecute: true,
        models: selectableModels,
        ...(agent === 'agy' ? { limitation: AGY_LIMITATION } : {}),
      };
    } catch (error) {
      return { agent, available: false, reason: `CLI 能力读取失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }));
}

/** 发送前重核对目标与 Gemini 模型；不自动降级、换模型或扩大权限。 */
export async function validateInvocationTarget(agents: AgentRegistry, input: AgentInvocationInput, platform: NodeJS.Platform = process.platform) {
  const provider = agents.get(input.agent);
  const status = await provider.getStatus();
  if (!status.found) throw new Error(status.error ?? `未安装 ${AGENTS[input.agent].name} CLI`);
  if (input.agent !== 'agy') return;
  if (input.mode === 'read-only' && !agyReadOnlySupported(status.version, platform)) throw new Error(`agy ${status.version ?? '未知版本'} 在当前平台尚未验证只读委派，不能改用普通执行`);
  const models = (await provider.listModels()).filter(model => model.value.startsWith(GEMINI_MODEL_PREFIX));
  if (!input.model || !models.some(model => model.value === input.model)) throw new Error(`请选择 agy 返回的可用 Gemini 模型；先调用 list_agent_targets。可用模型：${models.map(model => model.value).join('、') || '无'}`);
}

/** 保存实际发送的模型，使调用卡片和续聊使用同一选择。 */
export function invocationWithModel(input: AgentInvocationInput, previous: AgentInvocationInput | undefined, defaultModel: (agent: InvocationAgent) => string): AgentInvocationInput {
  const model = input.model ?? previous?.model ?? defaultModel(input.agent);
  return { ...input, ...(model ? { model } : {}) };
}
