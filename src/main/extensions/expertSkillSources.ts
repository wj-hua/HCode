// 专家导入需要保留所有同名来源；复用技能 frontmatter，不使用普通补全的名称覆盖规则。
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, basename } from "node:path";
import type { SkillEntry } from "../../shared/types.js";
import { skillName } from "../util/skillFrontmatter.js";
import { expertPluginSkillSources } from "./expertPluginSkillSources.js";
export async function discoverExpertSkillSources(
  home: string,
  project: string,
  managed: SkillEntry[] = [],
  pluginNames: string[] = [],
): Promise<SkillEntry[]> {
  const entries = [
    ...managed,
    ...(await expertPluginSkillSources(home, pluginNames)),
  ];
  for (const parent of [home, project])
    for (const folder of [".codex", ".agents", ".claude"]) {
      const root = join(parent, folder, "skills");
      let dirs;
      try {
        dirs = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const dir of dirs) {
        if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
        const path = join(root, dir.name, "SKILL.md");
        let text;
        try {
          text = await readFile(path, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const parsed = skillName(text.slice(0, 8192), dir.name);
        entries.push({
          name: parsed.name,
          description: parsed.description,
          path,
          scope: parent === home ? "user" : "project",
          enabled: true,
          canToggle: false,
        });
      }
    }
  const unique = new Map<string, SkillEntry>();
  for (const entry of entries) {
    const path = await realpath(entry.path);
    if (unique.has(path)) continue;
    const parts = path.split("/"),
      at = parts.lastIndexOf("cache");
    const prefix =
      at >= 0 && parts[at + 3] === "skills"
        ? parts[at + 1]
        : at >= 0 && parts[at + 4] === "skills"
          ? parts[at + 2]
          : undefined;
    const parsed = skillName(
      await readFile(path, "utf8"),
      basename(join(path, "..")),
    );
    unique.set(path, {
      ...entry,
      path,
      name: prefix
        ? `${prefix}:${parsed.name}`
        : entry.name.includes(":")
          ? entry.name
          : parsed.name,
    });
  }
  return [...unique.values()];
}
