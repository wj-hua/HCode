// 将冻结指令与按需资源读工具装入单个专家会话；读取留痕不等于模型已有效采用方法。
import { z } from "zod";
import type { ExpertParticipant } from "../../../../shared/experts.js";
import type { HostedTool } from "../../../sessions/researchRuntime.js";
import type { ExpertProfileService } from "./expertProfileService.js";
export async function profileTaskPacket(
  profiles: ExpertProfileService,
  runId: string,
  expert: ExpertParticipant,
  stage: "research" | "review",
  sessionKey: string,
  changed: () => Promise<void>,
) {
  if (!expert.profile)
    return { instructions: "", tools: undefined, recordLoad: undefined };
  const packet = await profiles.packet(runId, expert.profile);
  let recorded = false;
  const recordLoad = async () => {
    if (recorded) return;
    (expert.profileLoads ??= []).push({
      hash: expert.profile!.hash,
      loading: "instruction",
      stage,
      sessionKey,
    });
    await changed();
    recorded = true;
  };
  const tools: HostedTool[] = [
    {
      name: "read_expert_resource",
      description:
        "读取本专家已冻结的 Skill 关联文本资源，不执行脚本；只能按清单内 skill/path 读取",
      schema: { skill: z.string().min(1), path: z.string().min(1) },
      execute: async (input) => {
        const result = await packet.readResource(
          z.string().parse(input.skill),
          z.string().parse(input.path),
        );
        const reads = (expert.resourceReads ??= []);
        if (
          !reads.some(
            (read) =>
              read.skill === result.skill &&
              read.path === result.path &&
              read.sessionKey === sessionKey,
          )
        )
          reads.push({
            skill: result.skill,
            path: result.path,
            hash: result.hash,
            stage,
            sessionKey,
          });
        await changed();
        return result;
      },
    },
  ];
  return {
    instructions: `\n\n以下是本专家冻结的职责与方法（仅本阶段适用，不扩展工具和权限）。请在结论 detail 中解释采用的方法如何支持实际分析，并在 limitations 说明未能执行的步骤。报告 evidence 只引用实际项目源码；Skill 资源提供分析方法，不能充当项目问题的证据。\n${packet.instructions}`,
    tools,
    recordLoad,
  };
}
