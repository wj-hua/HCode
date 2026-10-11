// 原生动态工具的公开协议边界：参数和能力必须有效，文件读取仍走真实项目范围校验。
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { callResearchTool, codexResearchTools } from "../researchTools.js";

it("暴露受控读取工具并显式拒绝越界、未知工具和错误参数", async () => {
  const root = await mkdtemp(join(tmpdir(), "hcode-native-tools-"));
  const runtime = { root };
  try {
    await writeFile(join(root, "allowed.txt"), "actual source");
    const specs = codexResearchTools(runtime);
    expect(specs.map((spec) => spec.name)).toEqual(["hcode_read_file", "hcode_list_files"]);
    expect(await callResearchTool(runtime, { tool: "hcode_read_file", arguments: { path: "allowed.txt" } })).toEqual(expect.objectContaining({ success: true, contentItems: [{ type: "inputText", text: expect.stringContaining("actual source") }] }));
    const denied = await callResearchTool(runtime, { tool: "hcode_read_file", arguments: { path: "/etc/passwd" } });
    expect(denied.success).toBe(false);
    expect(denied.contentItems[0]!.text).toContain("范围");
    expect((await callResearchTool(runtime, { tool: "exec_command", arguments: {} })).success).toBe(false);
    expect((await callResearchTool(runtime, { tool: "hcode_read_file", arguments: { path: 7 } })).success).toBe(false);
    expect((await callResearchTool(runtime, { tool: "hcode_read_file", namespace: "external", arguments: { path: "allowed.txt" } })).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
