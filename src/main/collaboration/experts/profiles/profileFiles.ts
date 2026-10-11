// 有界 UTF-8 源文件和技能资源读取；实际路径必须留在已选 Skill 包内，脚本仅作为文本。
import { readFile, stat, realpath, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  dirname,
  join,
  relative,
  isAbsolute,
  extname,
  basename,
  resolve,
} from "node:path";
import { EXPERT_PROFILE_LIMITS } from "../../../../shared/expertProfiles.js";
import type { ExpertResourceRef } from "../../../../shared/expertProfiles.js";
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".sh",
  ".js",
  ".mjs",
  ".ts",
  ".css",
  ".html",
  ".svg",
]);
export function contentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}
export function declaredResources(content: string) {
  return [
    ...new Set(
      [
        ...content.matchAll(
          /(?:\.\.\/)*(?:references|scripts|assets)\/[\w./-]+\.(?:md|py|sh|js|ts|json)/g,
        ),
      ].map((match) => match[0]),
    ),
  ];
}
export async function profileText(path: string) {
  const sourcePath = await realpath(path),
    info = await stat(sourcePath);
  if (!info.isFile() || info.size > EXPERT_PROFILE_LIMITS.maxFileBytes)
    throw new Error(`专家源文件非文本或超过读取上限：${path}`);
  const data = await readFile(sourcePath);
  if (data.length > EXPERT_PROFILE_LIMITS.maxFileBytes || data.includes(0))
    throw new Error(`专家源文件过大或含二进制内容：${path}`);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
  return { sourcePath, hash: contentHash(content), content };
}
export async function skillResources(
  skill: string,
  sourcePath: string,
  content: string,
) {
  const root = await realpath(dirname(sourcePath)),
    refs: ExpertResourceRef[] = [],
    contents = new Map<string, string>(),
    limitations: string[] = [];
  let bytes = 0;
  const visit = async (directory: string) => {
    const canonical = await realpath(directory),
      offset = relative(root, canonical);
    if (offset === ".." || offset.startsWith("../") || isAbsolute(offset))
      throw new Error(`Skill 资源符号链接越界：${directory}`);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isSymbolicLink())
        throw new Error(`Skill 资源含符号链接，无法保证冻结边界：${path}`);
      if (!TEXT_EXTENSIONS.has(extname(entry.name))) {
        limitations.push(
          `关联非文本资源未开放：${skill}/${relative(root, path)}`,
        );
        continue;
      }
      const file = await profileText(path);
      bytes += Buffer.byteLength(file.content);
      if (
        bytes > EXPERT_PROFILE_LIMITS.maxResourceBytes ||
        refs.length >= EXPERT_PROFILE_LIMITS.maxResources
      )
        throw new Error(`Skill 关联资源超过冻结上限：${skill}`);
      refs.push({
        name: relative(root, path),
        skill,
        sourcePath: file.sourcePath,
        hash: file.hash,
      });
      contents.set(file.hash, file.content);
    }
  };
  for (const folder of ["references", "scripts", "assets"]) {
    const path = join(root, folder);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    await visit(path);
  }
  // 插件技能可显式引用包级 references；仅冻结清单文件且必须在同一插件版本内。
  const packageRoot = dirname(dirname(root));
  if (
    basename(dirname(root)) === "skills" &&
    root.includes("/plugins/cache/")
  ) {
    await stat(join(packageRoot, ".codex-plugin"));
    for (const name of declaredResources(content).filter((path) =>
      path.startsWith("../"),
    )) {
      const path = await realpath(resolve(root, name)),
        offset = relative(packageRoot, path);
      if (offset === ".." || offset.startsWith("../") || isAbsolute(offset))
        throw new Error(`Skill 包资源越界：${name}`);
      const file = await profileText(path);
      bytes += Buffer.byteLength(file.content);
      if (
        bytes > EXPERT_PROFILE_LIMITS.maxResourceBytes ||
        refs.length >= EXPERT_PROFILE_LIMITS.maxResources
      )
        throw new Error(`Skill 关联资源超过冻结上限：${skill}`);
      refs.push({ name, skill, sourcePath: file.sourcePath, hash: file.hash });
      contents.set(file.hash, file.content);
    }
  }
  return {
    refs: refs.sort((left, right) => left.name.localeCompare(right.name)),
    contents,
    limitations,
  };
}
