import { describe, expect, it, vi } from "vitest";
import { submissionForMode, createWorkModeStore } from "../workMode";
import { drafts, imageDrafts, fileDrafts, consumeSubmittedDraft } from "../drafts";
import { loadDraft, saveDraft, consumePersistedDraft } from "../persist";
const input = { text: "核对 @review-context.md 的两条规则", imageCount: 0, fileCount: 0, busy: false, activeCollaboration: false, canCompare: true, compareCount: 1 };
describe("工作方式的发送边界", () => {
  it("对比提交确认后新会话不恢复已发送草稿，持久化的新编辑仍可恢复", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    try {
      saveDraft('p:compare-project', '已发送内容', []);
      consumePersistedDraft('p:compare-project', '已发送内容', []);
      expect(loadDraft('p:compare-project')).toEqual({ text: '', files: [] });
      saveDraft('p:compare-project', '新编辑', []);
      consumePersistedDraft('p:compare-project', '已发送内容', []);
      expect(loadDraft('p:compare-project').text).toBe('新编辑');
    } finally { vi.unstubAllGlobals(); }
  });
  it("对比入口换挂载后只消费已确认发送的原草稿，发送期间的新编辑保留", () => {
    const images: [] = [], files: [] = [];
    drafts.set('compare-entry', '原输入'); imageDrafts.set('compare-entry', images); fileDrafts.set('compare-entry', files);
    expect(consumeSubmittedDraft('compare-entry', '原输入', images, files)).toEqual({ text: '', images: [], files: [] });
    drafts.set('compare-entry', '发送期间的新文字');
    expect(consumeSubmittedDraft('compare-entry', '原输入', images, files).text).toBe('发送期间的新文字');
  });
  it("切换方式及会话保留选择且不调用发送", () => {
    const store = createWorkModeStore();
    store.getState().select("first", "collaboration");
    store.getState().toggleCompare("first", "claude", true);
    store.getState().select("second", "experts");
    store.getState().select("first", "compare");
    expect(store.getState().views.first).toEqual({ mode: "compare", agents: ["claude"] });
    expect(store.getState().views.second?.mode).toBe("experts");
    expect(input.text).toContain("@review-context.md");
  });
  it("同题对比只走对比发送，普通聊天不会沿用隐藏的对比选择", () => {
    expect(submissionForMode("compare", input)).toEqual({ action: "compare" });
    expect(submissionForMode("chat", input)).toEqual({ action: "chat" });
    expect(submissionForMode("compare", { ...input, compareCount: 0 }).reason).toContain("选择");
    expect(submissionForMode("compare", { ...input, canCompare: false }).reason).toContain("新会话");
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
