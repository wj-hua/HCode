import { expect, it } from "vitest";
import type { ExpertDraft } from "@hcode/shared/expertDraft";
import type { CollaborationCapabilities } from "@hcode/shared/collaboration";
import { expertPlanIssues } from "./expertDraftPresentation";
const capabilities: CollaborationCapabilities[] = [{ agent: "claude", canInitiate: true, canExecute: true, canExecuteCode: true, canReview: true, reason: "原生检查通过" }, { agent: "agy", canInitiate: false, canExecute: true, canExecuteCode: false, canReview: true, reason: "只读检查通过", models: [{ value: "gemini-current", label: "Gemini" }] }];
const draft: ExpertDraft = { id: "plan", revision: 2, createdAt: 0, status: "ready", confidence: "identified", turns: [], sources: [], capabilities: [], profiles: ["ios", "testing"].map(role => ({ role, hash: "hash", loading: "instruction", roles: [], skills: [], resources: [], issues: [], limitations: ["未运行测试"] })), params: { initiator: { agent: "claude", sessionKey: "source", projectPath: "/project", permissionMode: "default" }, objective: "核对原文", experts: [{ role: "ios", objective: "核对 iOS 文本", reason: "目标", backend: { agent: "claude" }, profileHash: "hash" }, { role: "testing", objective: "核对验收", reason: "风险", backend: { agent: "claude" }, profileHash: "hash" }], backendPreferences: [{ agent: "claude" }], turnLimit: 24, acceptProfileLimitations: false } };
it("能力确认和未保存修改分别说明下一步，不假称可开始", () => {
  expect(expertPlanIssues(draft, draft.params, capabilities, true)).toEqual(expect.arrayContaining([expect.stringContaining("保存"), expect.stringContaining("能力限制")]));
  expect(expertPlanIssues(draft, { ...draft.params, acceptProfileLimitations: true }, capabilities, false)).toEqual([]);
});
it("Gemini 模型、角色缺失、预算与团队数量各自有可定位原因", () => {
  const edit = { ...draft.params, experts: [{ ...draft.params.experts[0]!, backend: { agent: "agy" as const } }], turnLimit: 1 };
  const issues = expertPlanIssues(draft, edit, capabilities, false);
  expect(issues).toEqual(expect.arrayContaining([expect.stringContaining("Gemini"), expect.stringContaining("预算"), expect.stringContaining("2–7")]));
  expect(expertPlanIssues({ ...draft, profiles: [] }, draft.params, capabilities, false)).toEqual(expect.arrayContaining([expect.stringContaining("组合不可用")]));
});
it("当前会话占用或附件不支持的原因始终显示", () => {
  expect(expertPlanIssues(draft, draft.params, capabilities, false, "附件暂不支持")).toContain("附件暂不支持");
});
