// Codex 0.162 原生 dynamicTools 适配：读取能力来自同一宿主边界，不靠 shell 或提示词约束。
import { z } from "zod";
import { researchTools, type ResearchRuntime } from "../../sessions/researchRuntime.js";

const TOOL_PREFIX = "hcode_";

export function codexResearchTools(runtime: ResearchRuntime) {
  return researchTools(runtime).map((definition) => ({ type: "function" as const, name: TOOL_PREFIX + definition.name, description: definition.description, inputSchema: z.toJSONSchema(z.object(definition.schema).strict(), { target: "draft-7" }) }));
}

/** 工具名与参数都校验；失败返回原生 success=false，不能用空内容冒充读取成功。 */
export async function callResearchTool(runtime: ResearchRuntime, params: Record<string, unknown>) {
  try {
    if (params.namespace != null) throw new Error("未授权的工具命名空间");
    const toolName = z.string().parse(params.tool);
    const definition = researchTools(runtime).find((entry) => TOOL_PREFIX + entry.name === toolName);
    if (!definition) throw new Error(`未授权的研究工具：${toolName}`);
    const input = z.object(definition.schema).strict().parse(params.arguments);
    const result = await definition.execute(input);
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
  } catch (error) {
    return { success: false, contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }] };
  }
}
