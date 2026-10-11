// 专家后端和产物目录的准入规则；首轮专家不能从项目目录读取其他专家的宿主产物。
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { realpath } from "node:fs/promises";
import type { CollaborationCapabilities } from "../../../shared/collaboration.js";
import type { ExpertSelection } from "../../../shared/experts.js";

export function assertExpertBackends(
  experts: ExpertSelection[],
  capabilities: CollaborationCapabilities[],
) {
  for (const expert of experts) {
    const capability = capabilities.find(
      (entry) => entry.agent === expert.backend.agent,
    );
    if (!capability?.canExecute || !capability.canReview)
      throw new Error(`${expert.backend.agent} 未通过研究和互审能力检查`);
    if (
      expert.backend.agent === "agy" &&
      (!expert.backend.model ||
        !capability.models?.some(
          (model) => model.value === expert.backend.model,
        ))
    )
      throw new Error("请选择当前账号模型列表中的 Gemini 模型，不自动换模型");
  }
}
export async function assertExpertArtifactIsolation(
  project: string,
  records: string,
) {
  let output: string;
  try {
    output = await realpath(records);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    output = join(await realpath(dirname(records)), basename(records));
  }
  const offset = relative(await realpath(project), output);
  if (
    !offset ||
    (!isAbsolute(offset) && offset !== ".." && !offset.startsWith("../"))
  )
    throw new Error(
      "专家项目包含协作产物目录，无法保证首轮报告隔离；请选择独立项目目录",
    );
}
