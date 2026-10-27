import { describe, expect, it } from "vitest";
import { submissionForMode, createWorkModeStore } from "../workMode";
const input = { text: "核对 @review-context.md 的两条规则", imageCount: 0, fileCount: 0, busy: false, activeCollaboration: false };
describe("工作方式的发送边界", () => {
  it("切换方式及会话保留选择且不调用发送", () => {
    const store = createWorkModeStore();
    store.getState().select("first", "collaboration");
    store.getState().select("second", "experts");
    expect(store.getState().views.first).toEqual({ mode: "collaboration" });
    expect(store.getState().views.second?.mode).toBe("experts");
    expect(input.text).toContain("@review-context.md");
  });
  it.each(["collaboration", "experts"] as const)("%s 拒绝未接入附件和忙碌源会话，保留草稿", mode => {
    expect(submissionForMode(mode, { ...input, imageCount: 1 }).reason).toContain("附件");
    expect(submissionForMode(mode, { ...input, fileCount: 1 }).reason).toContain("附件");
    expect(submissionForMode(mode, { ...input, busy: true }).reason).toContain("当前回合");
    expect(submissionForMode(mode, input).action).toBe("plan");
  });
  it("协作占用时普通输入不能排队或重复启动", () => {
    expect(submissionForMode("chat", { ...input, activeCollaboration: true }).reason).toContain("任务面板");
    expect(submissionForMode("collaboration", { ...input, text: "" }).reason).toContain("目标");
  });
});
