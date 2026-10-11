// 验证专家公开准入规则，禁止报告隔离失效和未经选择的 Gemini 模型。
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { expertStartSchema } from "../experts/expertContracts.js";
import {
  assertExpertArtifactIsolation,
  assertExpertBackends,
} from "../experts/expertAdmission.js";

it("允许不同角色使用同一模型，但拒绝少于两位和重复角色", () => {
  const input = {
    mode: "experts",
    initiator: {
      agent: "codex",
      sessionKey: randomUUID(),
      projectPath: "/fixture",
      permissionMode: "default",
    },
    objective: "研究模块",
    experts: [
      { role: "architecture", backend: { agent: "codex", model: "same" } },
      { role: "quality", backend: { agent: "codex", model: "same" } },
    ],
  };
  expect(() => expertStartSchema.parse(input)).not.toThrow();
  expect(() =>
    expertStartSchema.parse({ ...input, experts: input.experts.slice(0, 1) }),
  ).toThrow();
  expect(() =>
    expertStartSchema.parse({
      ...input,
      experts: [input.experts[0], input.experts[0]],
    }),
  ).toThrow("角色不能重复");
});
it("Gemini 必须通过研究与互审准入且明确选择当前账号模型", () => {
  const capabilities = [
    {
      agent: "agy" as const,
      canExecute: true,
      canReview: true,
      canInitiate: false,
      canExecuteCode: false,
      reason: "fixture supported",
      models: [{ value: "selected-gemini", label: "Gemini" }],
    },
  ];
  expect(() =>
    assertExpertBackends(
      [{ role: "quality", backend: { agent: "agy" } }],
      capabilities,
    ),
  ).toThrow("请选择");
  expect(() =>
    assertExpertBackends(
      [{ role: "quality", backend: { agent: "agy", model: "other" } }],
      capabilities,
    ),
  ).toThrow("请选择");
  expect(() =>
    assertExpertBackends(
      [
        {
          role: "quality",
          backend: { agent: "agy", model: "selected-gemini" },
        },
      ],
      capabilities,
    ),
  ).not.toThrow();
});
it("宿主报告目录和其真实路径必须位于研究项目之外", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-expert-isolation-")),
    project = join(root, "project");
  await mkdir(project);
  try {
    await expect(
      assertExpertArtifactIsolation(project, join(project, "records")),
    ).rejects.toThrow("隔离");
    await expect(
      assertExpertArtifactIsolation(project, join(root, "records")),
    ).resolves.toBeUndefined();
    await symlink(project, join(root, "records-link"), "dir");
    await expect(
      assertExpertArtifactIsolation(project, join(root, "records-link")),
    ).rejects.toThrow("隔离");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
