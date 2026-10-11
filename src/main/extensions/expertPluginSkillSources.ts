// 本机插件缓存只提供指令来源；保留所有版本，交由专家目录报告同名冲突。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillEntry } from "../../shared/types.js";
import { skillName } from "../util/skillFrontmatter.js";

async function directories(path: string) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** 仅发现固定组合明确引用的 Skill；不启用插件，也不自动选最新缓存版本。 */
export async function expertPluginSkillSources(
  home: string,
  names: string[],
): Promise<SkillEntry[]> {
  const requested = new Set(names);
  const plugins = new Set(names.map((name) => name.split(":")[0]!));
  const root = join(home, ".codex/plugins/cache");
  const entries: SkillEntry[] = [];
  for (const namespace of await directories(root)) {
    for (const plugin of plugins) {
      const pluginRoot = join(root, namespace.name, plugin);
      for (const version of await directories(pluginRoot)) {
        const skillsRoot = join(pluginRoot, version.name, "skills");
        for (const folder of await directories(skillsRoot)) {
          const path = join(skillsRoot, folder.name, "SKILL.md");
          const parsed = skillName(await readFile(path, "utf8"), folder.name);
          const name = `${plugin}:${parsed.name}`;
          if (!requested.has(name)) continue;
          entries.push({
            name,
            description: parsed.description,
            path,
            scope: "user",
            enabled: true,
            canToggle: false,
          });
        }
      }
    }
  }
  return entries;
}
