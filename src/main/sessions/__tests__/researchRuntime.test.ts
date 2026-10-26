// 验证实际文件读取边界，包括外部链接、二进制与超限，而不是只验证提示词。
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexResearchConfig, isCodexResearchVersion, readResearchFile } from "../researchRuntime.js";

it.each([
  ['0.162.0', true], ['0.163.0', true], ['0.163.42', true], ['0.164.0', true],
  ['0.164.1', false], ['0.165.0', false], ['0.161.0', false], ['0.164.0-preview', false],
  ['10.164.0', false], [undefined, false],
] as const)('Codex %s 仅在已验证版本范围内启用实验工具', (version, expected) => {
  expect(isCodexResearchVersion(version)).toBe(expected);
});

describe("研究文件边界", () => {
  it("返回真实文本/hash，并拒绝越界、外部符号链接、二进制和大文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "hcode-research-"));
    const outside = await mkdtemp(join(tmpdir(), "hcode-outside-"));
    try {
      await writeFile(join(root, "allowed.txt"), "evidence");
      await writeFile(join(outside, "secret.txt"), "outside");
      await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
      await writeFile(join(root, "binary"), Buffer.from([0, 1]));
      await writeFile(join(root, "large"), Buffer.alloc(256 * 1024 + 1, 65));
      expect(await readResearchFile(root, "allowed.txt")).toEqual(expect.objectContaining({ content: "evidence", hash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
      await expect(readResearchFile(root, join(outside, "secret.txt"))).rejects.toThrow("范围");
      await expect(readResearchFile(root, "escape.txt")).rejects.toThrow("范围");
      await expect(readResearchFile(root, "binary")).rejects.toThrow("二进制");
      await expect(readResearchFile(root, "large")).rejects.toThrow("256");
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("线程配置关闭已发现的 MCP/插件，不修改输入的用户配置", () => {
    const source = { mcp_servers: { external: { command: "external" } }, plugins: { installed: { enabled: true } } };
    const config = codexResearchConfig("/project", source);
    expect(config.mcp_servers).toEqual({ external: { enabled: false } });
    expect(config.plugins).toEqual({ installed: { enabled: false } });
    expect(source.plugins.installed.enabled).toBe(true);
    expect(config.permissions.hcode_research.filesystem).toEqual({ ":minimal": "read", "/project": "read" });
  });
});
