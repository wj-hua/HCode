// U2 原会话真实推荐、确认、独立研究、互审与汇总；所有模型结果和原生身份保持原样。
import { mkdir, writeFile, readFile, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
vi.mock("../../util/trash.js", () => ({ trashPaths: async () => { throw new Error("专家验收禁止删除历史"); } }));
import { nativeFixture } from "./nativeFixture.js";
import { ExpertDraftService } from "../drafts/expertDraftService.js";
const cases = [
  { name: "ios", file: "App.swift", text: "import SwiftUI\n// 规则一：报告逐字引用本文件。\n// 规则二：只核对原文，不运行测试，不修改代码。\n", goal: "用 iOS 和测试两位专家核对 App.swift 的第2、3行两条规则。只逐字引用这两行并标注行号，不解释代码行为，不扩展推论，不构建、不运行测试或设备工具；独立研究和互审都只核对规则原文，最终汇总说明未运行测试。不要额外推荐设计或服务端。" },
  { name: "frontend", file: "Form.tsx", text: "import React from 'react';\nexport const Form = () => <form />;\n", goal: "只读评审 Form.tsx 的前端表单与测试验证缺口；不改代码，不运行浏览器或测试。" },
  { name: "java", file: "Controller.java", text: "import org.springframework.web.bind.annotation.RestController;\n@RestController class Controller {}\n", goal: "只读评审 Controller.java 的 Java Spring 服务与测试验证缺口，不改代码、不运行 JDK 或测试。" },
  { name: "unknown", file: "notes.md", text: "目前仅有待澄清的项目目标，没有技术平台或实现资料。\n", goal: "查看项目资料，尚未给出具体功能或平台目标。不要推测平台；若没有证据，请保持待用户选择团队。" },
] as const;
it.skipIf(process.env.HCODE_NATIVE_EXPERT_DRAFT !== "1").each(cases)("U2 $name 实际资料上的专家推荐与隔离", async scenario => {
  const data = await nativeFixture(`hcode-u2-${scenario.name}-`), project = join(data.root, "project");
  const drafts = new ExpertDraftService(join(data.root, "plans"), data.service, data.execution, data.agents);
  try {
    await mkdir(project); await writeFile(join(project, scenario.file), scenario.text);
    const created = await drafts.create({ initiator: { agent: "claude", sessionKey: randomUUID(), projectPath: project, permissionMode: "bypassPermissions", model: "sonnet" }, objective: scenario.goal, backendPreferences: [{ agent: "claude", model: "sonnet" }, { agent: "codex" }], turnLimit: 24 });
    const planned = await drafts.prepare(created.id, created.revision);
    expect(planned.status, JSON.stringify(planned)).toBe(scenario.name === "unknown" ? "editing" : "ready");
    expect(planned.sources.map(source => source.path)).toContain(scenario.file);
    expect(await data.repository.list()).toEqual([]);
    expect(await readdir(project)).toEqual([scenario.file]);
    if (scenario.name === "unknown") expect(planned.params.experts).toEqual([]);
    else expect(planned.params.experts.some(expert => expert.role === scenario.name)).toBe(true);
    let final;
    if (scenario.name === "ios") {
      expect(planned.params.experts.map(expert => expert.role).sort()).toEqual(["ios", "testing"]);
      const accepted = await drafts.update(planned.id, planned.revision, { objective: planned.params.objective, experts: planned.params.experts, turnLimit: planned.params.turnLimit, acceptProfileLimitations: true });
      const [run, duplicate] = await Promise.all([drafts.confirm(accepted.id, accepted.revision), drafts.confirm(accepted.id, accepted.revision)]);
      expect(duplicate.id).toBe(run.id);
      await vi.waitFor(async () => expect((await data.service.get(run.id)).stage).toBe("finished"), { timeout: 360_000, interval: 1000 });
      final = await data.service.get(run.id);
      expect(final.status, JSON.stringify(final)).toBe("completed");
      expect(final.experts!.participants.every(expert => expert.status === "reported" && expert.profile && expert.objective && expert.profileLoads?.some(load => load.stage === "research"))).toBe(true);
      expect(final.experts!.reviews.every(review => review.status === "completed" && review.nativeSessionId)).toBe(true);
      expect(final.experts!.summary).toBeTruthy();
      const source = final.tasks.filter(turn => turn.sessionKey === accepted.params.initiator.sessionKey);
      expect(source.length).toBeGreaterThanOrEqual(2);
      expect(source.every(turn => turn.nativeSessionId === planned.params.initiator.resumeSessionId)).toBe(true);
      expect((await drafts.confirm(accepted.id, accepted.revision)).id).toBe(run.id);
    }
    expect(await readFile(join(project, scenario.file), "utf8")).toBe(scenario.text);
    if (process.env.HCODE_NATIVE_EVIDENCE_DIR) {
      const evidence = process.env.HCODE_NATIVE_EVIDENCE_DIR; await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, `u2-${scenario.name}.json`), JSON.stringify({ planned, final, sourceHash: createHash("sha256").update(scenario.text).digest("hex"), unchanged: true }, null, 2));
      await cp(join(data.root, "plans"), join(evidence, `plans-${scenario.name}`), { recursive: true });
    }
  } finally { drafts.dispose(); await data.cleanup(); }
}, 480_000);
