import { expect, it, vi } from "vitest";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExpertDraft } from "../../../shared/expertDraft.js";
const editable = (draft: ExpertDraft) => ({ objective: draft.params.objective, experts: draft.params.experts, turnLimit: draft.params.turnLimit, acceptProfileLimitations: true });
import { expertDraftFixture } from "./expertDraftFixture.js";
it.each(["ios", "frontend", "java", "unknown"] as const)("原会话按 %s 上下文生成可核对团队，确认前没有专家或 Run", async kind => {
  const data = await expertDraftFixture();
  try {
    const roles = kind === "unknown" ? [] : [kind, "testing"];
    data.setProposal({ confidence: kind === "unknown" ? "needsSelection" : "identified", summary: kind === "unknown" ? "资料不足，请选择团队，不能推测平台" : `依据用户目标与实际来源，推荐 ${kind}`, sources: ["source.ts"], experts: roles.map(role => ({ role, objective: `核对 ${role} 范围的证据`, reason: `目标要求 ${role} 视角` })) });
    const created = await data.drafts.create({ ...data.input, objective: kind === "unknown" ? "评估项目，尚无平台资料" : `评审 ${kind} 功能` });
    expect(data.send).not.toHaveBeenCalled();
    const plan = await data.drafts.prepare(created.id, created.revision);
    expect(plan.status, plan.error).toBe(kind === "unknown" ? "editing" : "ready");
    expect(plan.params.experts.map(value => value.role)).toEqual(roles);
    expect(plan.sources).toHaveLength(1);
    expect(plan.profiles).toHaveLength(7);
    expect(await data.repository.list()).toEqual([]);
    expect(await readdir(data.project)).toEqual(["source.ts"]);
  } finally { await data.cleanup(); }
});
it("保存分工撤销能力确认，旧版本、无 Gemini 模型及预算不足不能执行", async () => {
  const data = await expertDraftFixture();
  try {
    const created = await data.drafts.create(data.input), plan = await data.drafts.prepare(created.id, created.revision);
    const edit = { objective: plan.params.objective, experts: plan.params.experts, turnLimit: 24, acceptProfileLimitations: true };
    const accepted = await data.drafts.update(plan.id, plan.revision, edit);
    const modified = await data.drafts.update(plan.id, accepted.revision, { ...edit, acceptProfileLimitations: false, experts: edit.experts.map(value => ({ ...value, objective: value.objective + "；标注未运行测试" })) });
    expect(modified.params.acceptProfileLimitations).toBe(false);
    await expect(data.drafts.confirm(plan.id, accepted.revision)).rejects.toThrow("版本");
    await expect(data.drafts.confirm(plan.id, modified.revision)).rejects.toThrow("能力限制");
    await expect(data.drafts.update(plan.id, modified.revision, { ...edit, turnLimit: 5 })).rejects.toThrow("预算");
    const gemini = await data.drafts.update(plan.id, modified.revision, { ...edit, acceptProfileLimitations: false, experts: edit.experts.map((value, index) => index ? value : { ...value, backend: { agent: "agy" as const } }) });
    const geminiAccepted = await data.drafts.update(plan.id, gemini.revision, editable(gemini));
    await expect(data.drafts.confirm(plan.id, geminiAccepted.revision)).rejects.toThrow("Gemini");
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
it.each(["skills", "capability", "file"] as const)("%s 变化拒绝旧计划启动，保留证据且不创建 Run", async change => {
  const data = await expertDraftFixture();
  try {
    const created = await data.drafts.create(data.input), plan = await data.drafts.prepare(created.id, created.revision);
    const accepted = await data.drafts.update(plan.id, plan.revision, editable(plan));
    if (change === "skills") await writeFile(join(data.root, ".codex/skills/apple-design/SKILL.md"), "变更的 UI 方法");
    if (change === "capability") data.setVersion("fixture-2");
    if (change === "file") await writeFile(join(data.project, "source.ts"), "export const answer = 43;\n");
    await expect(data.drafts.confirm(plan.id, accepted.revision)).rejects.toThrow(/变化/);
    expect(await data.repository.list()).toEqual([]);
    expect(data.send).toHaveBeenCalledTimes(1);
  } finally { await data.cleanup(); }
});
it("同版本并发确认只启动一组分工、独立研究、互审及原会话汇总，重载不重发", async () => {
  const data = await expertDraftFixture();
  try {
    const created = await data.drafts.create(data.input), plan = await data.drafts.prepare(created.id, created.revision);
    const accepted = await data.drafts.update(plan.id, plan.revision, editable(plan));
    const [run, repeat] = await Promise.all([data.drafts.confirm(plan.id, accepted.revision), data.drafts.confirm(plan.id, accepted.revision)]);
    expect(repeat.id).toBe(run.id);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).status).toBe("completed"));
    const result = await data.collaboration.get(run.id);
    expect(result.tasks).toHaveLength(6);
    expect(result.experts!.reviews.every(value => value.status === "completed")).toBe(true);
    expect(result.experts!.participants.map(value => value.objective)).toEqual(accepted.params.experts.map(value => value.objective));
    expect(result.tasks[0]!.nativeSessionId).toBe(result.tasks.at(-1)!.nativeSessionId);
    expect(result.experts!.summary!.consensus).toHaveLength(1);
    await data.drafts.confirm(plan.id, accepted.revision);
    expect(await data.repository.list()).toHaveLength(1);
    expect(await readFile(join(data.project, "source.ts"), "utf8")).toBe("export const answer = 42;\n");
  } finally { await data.cleanup(); }
});
it("无效模型推荐即使编辑团队也不能变成有效 AI 计划", async () => {
  const data = await expertDraftFixture();
  try {
    data.setProposal("invalid JSON");
    const created = await data.drafts.create(data.input), failed = await data.drafts.prepare(created.id, created.revision);
    expect(failed.status).toBe("blocked");
    const edited = await data.drafts.update(failed.id, failed.revision, { ...editable(failed), acceptProfileLimitations: false });
    await expect(data.drafts.confirm(failed.id, edited.revision)).rejects.toThrow("有效计划");
    expect(await data.repository.list()).toEqual([]);
  } finally { await data.cleanup(); }
});
it("七位团队的规划、研究、互审和汇总共享十六回合，预览不冻结产物", async () => {
  const data = await expertDraftFixture();
  try {
    const roles = ["ios", "android", "frontend", "java", "requirements", "design", "testing"];
    data.setProposal({ confidence: "identified", summary: "本次目标明确涉及七个视角", sources: ["source.ts"], experts: roles.map(role => ({ role, objective: "只读核对 source.ts 的值", reason: "用户指定视角" })) });
    const created = await data.drafts.create({ ...data.input, turnLimit: 16 }), plan = await data.drafts.prepare(created.id, created.revision);
    expect(plan.params.experts).toHaveLength(7);
    expect(await data.repository.list()).toEqual([]);
    const accepted = await data.drafts.update(plan.id, plan.revision, editable(plan));
    const run = await data.drafts.confirm(plan.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).status).toBe("completed"));
    const completed = await data.collaboration.get(run.id);
    expect(completed.tasks).toHaveLength(16);
    expect(completed.experts!.participants.every(expert => expert.profileHash === expert.profile?.hash)).toBe(true);
  } finally { await data.cleanup(); }
});
it("未知项目经用户明确选两位专家、保存及接受限制后才允许开始", async () => {
  const data = await expertDraftFixture();
  try {
    data.setProposal({ confidence: "needsSelection", summary: "平台资料缺失，请选择团队", sources: ["source.ts"], experts: [] });
    const created = await data.drafts.create(data.input), plan = await data.drafts.prepare(created.id, created.revision);
    await expect(data.drafts.confirm(plan.id, plan.revision)).rejects.toThrow("有效计划");
    const experts = (["requirements", "testing"] as const).map(role => ({ role, objective: "核对原文的值和验证缺口", reason: "用户选择的视角", backend: { agent: "claude" as const }, profileHash: plan.profiles.find(profile => profile.role === role)!.hash }));
    const selected = await data.drafts.update(plan.id, plan.revision, { ...editable(plan), experts, acceptProfileLimitations: false });
    const accepted = await data.drafts.update(plan.id, selected.revision, editable(selected));
    const run = await data.drafts.confirm(plan.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).status).toBe("completed"));
    expect((await data.collaboration.get(run.id)).experts!.participants.map(expert => expert.role)).toEqual(["requirements", "testing"]);
  } finally { await data.cleanup(); }
});
it("已开始 Run 的确认回执丢失后，能力变化也只能找回原结果，不能重发", async () => {
  const data = await expertDraftFixture();
  try {
    const created = await data.drafts.create(data.input), plan = await data.drafts.prepare(created.id, created.revision);
    const accepted = await data.drafts.update(plan.id, plan.revision, editable(plan));
    const run = await data.drafts.confirm(plan.id, accepted.revision);
    await vi.waitFor(async () => expect((await data.collaboration.get(run.id)).status).toBe("completed"));
    const saved = await data.drafts.get(plan.id);
    // 文件系统回放最后成功的 starting 记录，模拟 Run 已保存而草案回执尚未落盘。
    saved.status = "starting"; delete saved.runId;
    await data.drafts.repository.save(saved);
    data.setVersion("fixture-2");
    await writeFile(join(data.project, "source.ts"), "export const answer = 43;\n");
    const restored = await data.drafts.confirm(plan.id, saved.revision);
    expect(restored.id).toBe(run.id);
    expect(restored.tasks).toHaveLength(6);
    expect(await data.repository.list()).toHaveLength(1);
  } finally { await data.cleanup(); }
});
