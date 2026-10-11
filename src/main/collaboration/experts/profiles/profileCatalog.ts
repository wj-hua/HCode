// 按固定职责组合解析本机 TOML 和 SKILL.md；同名不同来源显式冲突，不静默覆盖。
import { join } from "node:path";
import { parse } from "smol-toml";
import type { SkillEntry } from "../../../../shared/types.js";
import {
  BUSINESS_EXPERT_TYPES,
  EXPERT_PROFILE_LIMITS,
  type BusinessExpertType,
  type ExpertProfilePreview,
} from "../../../../shared/expertProfiles.js";
import { PROFILE_DEFINITIONS, PROFILE_SCOPE } from "./profileDefinitions.js";
import {
  contentHash,
  profileText,
  skillResources,
  declaredResources,
} from "./profileFiles.js";
export interface ProfileBundle {
  profile: ExpertProfilePreview;
  contents: Map<string, string>;
}
export function roleInstructions(text: string, name: string) {
  const data = parse(text);
  if (
    data.name !== name ||
    typeof data.developer_instructions !== "string" ||
    !data.developer_instructions.trim()
  )
    throw new Error(`Agent 职责 TOML 无效或名称不符：${name}`);
  return data.developer_instructions;
}
/** 组装全部固定职责、方法及资源清单，缺内容直接失败；预览和实际任务共用大小检查。 */
export function profileInstructions(
  profile: Omit<ExpertProfilePreview, "hash" | "issues">,
  contents: Map<string, string>,
) {
  const content = (hash: string) => {
    const text = contents.get(hash);
    if (text === undefined) throw new Error("专家指令内容缺失");
    return text;
  };
  const sections = [PROFILE_SCOPE, ...profile.limitations];
  for (const role of profile.roles)
    sections.push(
      `角色 ${role.name} / ${role.hash}\n${roleInstructions(content(role.hash), role.name)}`,
    );
  for (const skill of profile.skills)
    sections.push(
      `Skill ${skill.name} / ${skill.hash} / 指令加载\n${content(skill.hash)}`,
    );
  sections.push(
    `关联资源按需通过 read_expert_resource(skill,path) 读取，只有以下已冻结资源可用：${JSON.stringify(profile.resources.map((ref) => ({ skill: ref.skill, path: ref.name, hash: ref.hash })))}`,
  );
  const instructions = sections.join("\n\n");
  if (
    Buffer.byteLength(instructions) > EXPERT_PROFILE_LIMITS.maxInstructionBytes
  )
    throw new Error("组合指令超过上下文预设上限，不能截断固定组合");
  return instructions;
}
export function profileHash(
  profile: Omit<ExpertProfilePreview, "hash" | "issues">,
) {
  const refs = (
    items: { name: string; sourcePath: string; hash: string; skill?: string }[],
  ) =>
    items.map((ref) => [ref.name, ref.sourcePath, ref.hash, ref.skill ?? null]);
  return contentHash(
    JSON.stringify({
      role: profile.role,
      loading: profile.loading,
      roles: refs(profile.roles),
      skills: refs(profile.skills),
      resources: refs(profile.resources),
      limitations: profile.limitations,
    }),
  );
}
export async function profileCatalog(
  rolesRoot: string,
  skills: SkillEntry[],
): Promise<ProfileBundle[]> {
  return Promise.all(
    BUSINESS_EXPERT_TYPES.map((role) => buildProfile(role, rolesRoot, skills)),
  );
}
async function buildProfile(
  role: BusinessExpertType,
  rolesRoot: string,
  entries: SkillEntry[],
): Promise<ProfileBundle> {
  const definition = PROFILE_DEFINITIONS[role],
    contents = new Map<string, string>(),
    issues: string[] = [];
  const base: Omit<ExpertProfilePreview, "hash" | "issues"> = {
    role,
    loading: "instruction",
    roles: [],
    skills: [],
    resources: [],
    limitations: [...definition.limitations],
  };
  for (const name of definition.roles) {
    try {
      const file = await profileText(join(rolesRoot, `${name}.toml`));
      roleInstructions(file.content, name);
      base.roles.push({ name, sourcePath: file.sourcePath, hash: file.hash });
      contents.set(file.hash, file.content);
    } catch (error) {
      issues.push(`${name}：${String(error)}`);
    }
  }
  for (const name of definition.skills) {
    const matches = entries.filter((entry) => entry.name === name);
    if (!matches.length) {
      issues.push(`缺少 Skill：${name}`);
      continue;
    }
    try {
      const candidates = await Promise.all(
        matches
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(async (entry) => {
            const file = await profileText(entry.path),
              resources = await skillResources(
                name,
                file.sourcePath,
                file.content,
              );
            return {
              file,
              resources,
              fingerprint: contentHash(
                JSON.stringify([
                  file.hash,
                  resources.refs.map((ref) => [ref.name, ref.hash]),
                  resources.limitations,
                ]),
              ),
            };
          }),
      );
      if (
        new Set(candidates.map((candidate) => candidate.fingerprint)).size !== 1
      ) {
        issues.push(
          `Skill 同名冲突：${name}（${matches.map((entry) => entry.path).join("；")}）`,
        );
        continue;
      }
      const { file, resources } = candidates[0]!;
      if (candidates.length > 1)
        base.limitations.push(
          `Skill ${name} 有 ${candidates.length} 份内容及关联资源一致的副本；指令导入采用 ${file.sourcePath}，未启用任何插件。`,
        );
      const declared = declaredResources(file.content);
      for (const path of new Set(declared))
        if (!resources.refs.some((ref) => ref.name === path))
          issues.push(`Skill 引用资源缺失：${name}/${path}`);
      base.skills.push({ name, sourcePath: file.sourcePath, hash: file.hash });
      base.resources.push(...resources.refs);
      base.limitations.push(...resources.limitations);
      contents.set(file.hash, file.content);
      resources.contents.forEach((value, key) => contents.set(key, value));
    } catch (error) {
      issues.push(`${name}：${String(error)}`);
    }
  }
  try {
    profileInstructions(base, contents);
  } catch (error) {
    issues.push(String(error));
  }
  return { profile: { ...base, hash: profileHash(base), issues }, contents };
}
