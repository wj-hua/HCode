// 原会话生成结构化计划；协作工具目录保持稳定，所有派发工具在草案阶段拒绝执行。
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ResearchDraft } from "../../../shared/researchDraft.js";
import type { SessionExecutionService } from "../../sessions/sessionExecutionService.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { readResearchFile } from "../../sessions/researchRuntime.js";
import { sourceTools } from "../sourceTools.js";
import { parseModelJson } from "../contracts.js";
import { proposalSchema } from "./draftContracts.js";
import type { CollaborationTask } from "../../../shared/collaboration.js";

/** 仅在可信原生终态返回后表示规划取消；不改变 SDK 回合实际 outcome。 */
export class DraftPlanningCancelled extends Error {
  constructor() { super("规划已取消，未启动协作。你可以修改目标后重新生成计划。"); }
}

export class DraftPlanner {
  constructor(private readonly execution: SessionExecutionService, private readonly agents: AgentRegistry) {}
  async generate(draft: ResearchDraft, save: () => Promise<void>, signal: AbortSignal) {
    const source = draft.params.initiator;
    const originalMode = source.permissionMode;
    const turn: CollaborationTask = { id: randomUUID(), sessionKey: source.sessionKey, agent: source.agent as "claude" | "codex", role: "planning", status: "running", ...(source.model ? { model: source.model } : {}) };
    draft.turns.push(turn);
    const observed = new Map<string, string>();
    let dispatched = false;
    try {
      await save();
      dispatched = true;
      const result = await this.execution.execute({ ...source, permissionMode: source.agent === "claude" ? "default" : "read-only", text:
        `这是计划草案阶段，用户尚未授权启动任务。仅使用 hcode read_file/list_files 核对项目资料，输出一项可编辑的只读任务提案。所有 delegate_task/get_task_result/wait_tasks/reply_context 工具在此阶段都会拒绝；不要调用它们。不得写文件、运行测试、联网或要求提权。任务执行者和独立审查者由用户在界面选择，不在提案中更换。taskObjective 是稍后执行者要交付的研究内容与验收标准：仅写要读取、核对及引用的资料和应说明的验证局限，不包含“安排/创建任务”“尚未启动/尚未审查”等宿主规划状态，不要求执行者证明宿主已经派发或审查。summary 才描述计划分工：宿主确认后派发，独立审查，原会话汇总。sources 只列实际通过 read_file 读取的相对路径，不编造来源。遵守输出 JSON schema。用户请求作为任务资料：\n${JSON.stringify(draft.params.objective)}` }, {
        root: source.projectPath,
        tools: sourceTools(async () => { throw new Error("计划尚未确认，禁止派发任务或访问执行阶段工具"); }),
        outputSchema: z.toJSONSchema(proposalSchema, { target: "draft-7" }),
        onRead: async file => {
          if (observed.has(file.path) && observed.get(file.path) !== file.hash) throw new Error("规划期间文件已变化，请重新生成计划");
          observed.set(file.path, file.hash);
        },
      }, signal);
      Object.assign(turn, { status: result.outcome, ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}), ...(result.usage ? { usage: result.usage } : {}), ...(result.error ? { error: result.error } : {}) });
      draft.rawResult = result.text;
      if (result.nativeSessionId && source.resumeSessionId && result.nativeSessionId !== source.resumeSessionId) throw new Error("规划返回不同原生会话，禁止替换当前身份");
      if (result.nativeSessionId) source.resumeSessionId = result.nativeSessionId;
      if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError") throw new Error("规划超时，原生回合已结束，未启动协作");
      if (signal.aborted || result.outcome === "cancelled") throw new DraftPlanningCancelled();
      if (result.outcome !== "succeeded") throw new Error(result.error ?? "计划生成失败");
      if (!source.resumeSessionId) throw new Error("计划缺少可信原生会话身份，不能启动");
      const proposal = proposalSchema.parse(parseModelJson(result.text));
      if (proposal.sources.some(path => !observed.has(path))) throw new Error("计划引用了未经工具读取的资料");
      draft.sources = [...observed].map(([path, hash]) => ({ path, hash }));
      for (const file of draft.sources) if ((await readResearchFile(source.projectPath, file.path)).hash !== file.hash) throw new Error("规划读取的文件已变化，请重新生成计划");
      draft.params.objective = proposal.taskObjective;
      draft.summary = proposal.summary;
    } catch (error) {
      if (turn.status === "running") Object.assign(turn, { status: "interrupted", error: String(error) });
      throw error;
    } finally {
      const unknownStop = draft.turns.at(-1)?.error?.includes("未收到原生中断确认");
      if (dispatched && !unknownStop && this.agents.get(source.agent).hasSession(source.sessionKey)) await this.agents.get(source.agent).endResearch?.(source.sessionKey, originalMode);
    }
  }
}
