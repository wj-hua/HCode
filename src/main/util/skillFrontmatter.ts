/** 读取 SKILL.md 开头 frontmatter 里的 name / description；没有 name 时用目录名。 */
export function skillName(content: string, fallback: string): { name: string; description: string } {
  const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(content)?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  return { name: field("name") || fallback, description: field("description") || "" };
}
