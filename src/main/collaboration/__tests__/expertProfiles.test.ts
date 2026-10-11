// 本机职责与技能通过公开目录和冻结接口验证；文件读取与存储使用真实临时目录。
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ExpertProfileService } from "../experts/profiles/expertProfileService.js";
it("完整组合冻结后不受本机改动影响，关联资源只读且不可逃逸", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-profile-"));
  const roles = join(root, ".codex/agents"),
    skills = join(root, ".codex/skills");
  await mkdir(roles, { recursive: true });
  for (const name of ["frontend-developer", "react-specialist"])
    await writeFile(
      join(roles, `${name}.toml`),
      `name = "${name}"\nmodel = "ignored"\nsandbox_mode = "workspace-write"\ndeveloper_instructions = """\nAnalyze ${name} state ownership.\n"""\n`,
    );
  for (const name of [
    "apple-design",
    "frontend-skill",
    "architecture-deepening",
  ]) {
    const folder = join(skills, name);
    await mkdir(join(folder, "references"), { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: local method\n---\nOriginal ${name} method. Read references/rules.md.\n`,
    );
    await writeFile(join(folder, "references/rules.md"), "frozen resource");
  }
  const service = new ExpertProfileService(join(root, "records"), {
    home: root,
  });
  try {
    const catalog = await service.catalog(root);
    const profile = catalog.find((x) => x.role === "frontend")!;
    expect(profile.issues).toEqual([]);
    expect(profile.roles.map((x) => x.name)).toEqual([
      "frontend-developer",
      "react-specialist",
    ]);
    expect(profile.skills.map((x) => x.name)).toEqual([
      "apple-design",
      "frontend-skill",
      "architecture-deepening",
    ]);
    const frozen = await service.freeze(
      "11111111-1111-4111-8111-111111111111",
      root,
      [
        {
          role: "frontend",
          backend: { agent: "codex" },
          profileHash: profile.hash,
        },
      ],
      true,
    );
    await writeFile(
      join(skills, "apple-design/SKILL.md"),
      "changed live skill",
    );
    const packet = await service.packet(
      "11111111-1111-4111-8111-111111111111",
      frozen[0]!,
    );
    expect(packet.instructions).toContain("Original apple-design method");
    expect(packet.instructions).toContain("Analyze frontend-developer");
    expect(packet.instructions).not.toContain("workspace-write");
    expect(
      await packet.readResource("apple-design", "references/rules.md"),
    ).toMatchObject({ content: "frozen resource" });
    await expect(
      packet.readResource("apple-design", "../../outside"),
    ).rejects.toThrow();
    await expect(
      service.freeze(
        "22222222-2222-4222-8222-222222222222",
        root,
        [
          {
            role: "frontend",
            backend: { agent: "codex" },
            profileHash: profile.hash,
          },
        ],
        true,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function frontendFixture() {
  const root = await mkdtemp(join(tmpdir(), "hcode-profile-errors-"));
  const roles = join(root, ".codex/agents"),
    skills = join(root, ".codex/skills");
  await mkdir(roles, { recursive: true });
  for (const name of ["frontend-developer", "react-specialist"])
    await writeFile(
      join(roles, `${name}.toml`),
      `name = "${name}"\ndeveloper_instructions = "Analyze ${name}."\n`,
    );
  for (const name of [
    "apple-design",
    "frontend-skill",
    "architecture-deepening",
  ]) {
    const folder = join(skills, name);
    await mkdir(join(folder, "references"), { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\n---\nRead references/rules.md.\n`,
    );
    await writeFile(join(folder, "references/rules.md"), "same method");
  }
  return {
    root,
    roles,
    skills,
    service: new ExpertProfileService(join(root, "records"), { home: root }),
  };
}

it.each([
  "missing",
  "toml",
  "oversize",
  "aggregate",
  "missingResource",
  "symlink",
  "resourceConflict",
] as const)("缺失、无效及冲突来源显式阻止启动：%s", async (scenario) => {
  const fixture = await frontendFixture();
  try {
    if (scenario === "missing")
      await rm(join(fixture.roles, "react-specialist.toml"));
    if (scenario === "toml")
      await writeFile(
        join(fixture.roles, "react-specialist.toml"),
        "name = [broken",
      );
    if (scenario === "oversize")
      await writeFile(
        join(fixture.skills, "apple-design/SKILL.md"),
        "x".repeat(256 * 1024 + 1),
      );
    if (scenario === "aggregate") {
      await writeFile(
        join(fixture.skills, "apple-design/SKILL.md"),
        "a".repeat(70 * 1024),
      );
      await writeFile(
        join(fixture.skills, "frontend-skill/SKILL.md"),
        "b".repeat(70 * 1024),
      );
    }
    if (scenario === "missingResource")
      await rm(join(fixture.skills, "apple-design/references/rules.md"));
    if (scenario === "symlink") {
      const { symlink } = await import("node:fs/promises");
      await symlink(
        join(fixture.root, ".codex/agents"),
        join(fixture.skills, "apple-design/references/escape"),
      );
    }
    if (scenario === "resourceConflict") {
      const copy = join(fixture.root, ".agents/skills/apple-design");
      await mkdir(join(copy, "references"), { recursive: true });
      await writeFile(
        join(copy, "SKILL.md"),
        "---\nname: apple-design\n---\nRead references/rules.md.\n",
      );
      await writeFile(join(copy, "references/rules.md"), "different method");
    }
    const profile = (await fixture.service.catalog(fixture.root)).find(
      (entry) => entry.role === "frontend",
    )!;
    expect(profile.issues.length).toBeGreaterThan(0);
    if (scenario === "resourceConflict")
      expect(profile.issues.join()).toContain("同名冲突");
    await expect(
      fixture.service.freeze(
        "11111111-1111-4111-8111-111111111111",
        fixture.root,
        [
          {
            role: "frontend",
            backend: { agent: "codex" },
            profileHash: profile.hash,
          },
        ],
        true,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("同正文但不同资源属于冲突；等价副本显示来源，冻结损坏不会沿用成功内容", async () => {
  const fixture = await frontendFixture();
  try {
    const copy = join(fixture.root, ".agents/skills/apple-design");
    await mkdir(join(copy, "references"), { recursive: true });
    await writeFile(
      join(copy, "SKILL.md"),
      "---\nname: apple-design\n---\nRead references/rules.md.\n",
    );
    await writeFile(join(copy, "references/rules.md"), "same method");
    const profile = (await fixture.service.catalog(fixture.root)).find(
      (entry) => entry.role === "frontend",
    )!;
    expect(profile.issues).toEqual([]);
    expect(profile.limitations.join()).toContain("2 份");
    const runId = "11111111-1111-4111-8111-111111111111";
    await expect(
      fixture.service.freeze(
        runId,
        fixture.root,
        [
          {
            role: "frontend",
            backend: { agent: "codex" },
            profileHash: profile.hash,
          },
        ],
        false,
      ),
    ).rejects.toThrow("确认");
    const [frozen] = await fixture.service.freeze(
      runId,
      fixture.root,
      [
        {
          role: "frontend",
          backend: { agent: "codex" },
          profileHash: profile.hash,
        },
      ],
      true,
    );
    await writeFile(
      join(
        fixture.root,
        "records",
        runId,
        "artifacts/expert-profiles",
        `${frozen!.skills[0]!.hash}.txt`,
      ),
      "corrupt frozen",
    );
    await expect(fixture.service.packet(runId, frozen!)).rejects.toThrow(
      "hash",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

it("整个选择在落盘前校验；后续专家缺源时不留下已冻结的前序配置", async () => {
  const fixture = await frontendFixture();
  try {
    const profile = (await fixture.service.catalog(fixture.root)).find(
      (entry) => entry.role === "frontend",
    )!;
    const runId = "11111111-1111-4111-8111-111111111111";
    await expect(
      fixture.service.freeze(
        runId,
        fixture.root,
        [
          {
            role: "frontend",
            backend: { agent: "codex" },
            profileHash: profile.hash,
          },
          {
            role: "java",
            backend: { agent: "claude" },
            profileHash: profile.hash,
          },
        ],
        true,
      ),
    ).rejects.toThrow();
    const { access } = await import("node:fs/promises");
    await expect(
      access(join(fixture.root, "records", runId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
