// 工作方式只决定输入动作；不拥有输入、不发送模型请求，也不改变权限或协作业务状态。
import { create } from "zustand";
export const WORK_MODES = {
  chat: { label: "普通对话", description: "与当前 AI 对话", action: "发送" },
  collaboration: { label: "协作执行", description: "当前 AI 制定计划，其他 AI 执行并独立审查", action: "查看协作计划" },
  experts: { label: "专家评审", description: "推荐并调整专家团队，独立研究、互审后汇总", action: "查看专家计划" },
} as const;
export type WorkMode = keyof typeof WORK_MODES;
interface WorkModeState {
  views: Record<string, { mode: WorkMode }>;
  select(viewId: string, mode: WorkMode): void;
}
export function createWorkModeStore() {
  return create<WorkModeState>(set => ({
    views: {},
    select: (viewId, mode) => set(state => ({ views: { ...state.views, [viewId]: { mode } } })),
  }));
}
export const useWorkMode = createWorkModeStore();
interface SubmissionInput {
  text: string;
  imageCount: number;
  fileCount: number;
  busy: boolean;
  activeCollaboration: boolean;
}
/** UI 准入只阻止错误的输入动作；实际线程资格、版本和预算仍由主进程校验。 */
export function submissionForMode(mode: WorkMode, input: SubmissionInput): { action: "chat" | "plan"; reason?: string } {
  const action = mode === "chat" ? "chat" : "plan";
  if (input.activeCollaboration) return { action, reason: "当前会话由协作占用，请在任务面板查看进度或暂停接管。输入草稿已保留。" };
  if (action !== "plan") return { action };
  if (input.imageCount || input.fileCount) return { action, reason: "协作暂不支持输入附件。附件和文字已保留；请移除附件，使用 @项目文件 引用，或切回普通对话。" };
  if (input.busy) return { action, reason: "请先完成当前回合和消息队列，再制定计划。输入草稿已保留。" };
  if (!input.text.trim()) return { action, reason: "请在当前输入框填写任务目标。" };
  return { action };
}
