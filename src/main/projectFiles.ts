import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_RESULTS = 50;
const MAX_SCANNED_FILES = 20_000;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", "dist", "build", "out", "coverage", ".venv", "venv", "target"]);

function matchScore(path: string, query: string): number {
  if (!query) return 0;
  const candidate = path.toLowerCase();
  const needle = query.toLowerCase();
  const basename = candidate.slice(candidate.lastIndexOf("/") + 1);
  let score = 0;
  let at = 0;
  let last = -2;
  for (const char of needle) {
    const next = candidate.indexOf(char, at);
    if (next < 0) return -1;
    score += next === last + 1 ? 3 : 1;
    if (next === 0 || candidate[next - 1] === "/" || candidate[next - 1] === "-" || candidate[next - 1] === "_") score += 3;
    last = next;
    at = next + 1;
  }
  if (basename.includes(needle)) score += 20;
  if (basename.startsWith(needle)) score += 10;
  return score;
}

async function fallbackFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const dirs = [""];
  let scanned = 0;
  while (dirs.length && scanned < MAX_SCANNED_FILES) {
    const relativeDir = dirs.shift()!;
    let entries;
    try {
      entries = await readdir(join(cwd, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) dirs.push(relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }
  return files;
}

/** 返回项目根目录下的相对文件路径；Git 仓库同时包含未被忽略的新文件。 */
export async function listProjectFiles(cwd: string, query: string): Promise<string[]> {
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) return [];
  let files: string[];
  try {
    const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd,
      encoding: "buffer",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    files = stdout.toString("utf8").split("\0").filter(Boolean);
  } catch {
    files = await fallbackFiles(cwd);
  }
  const ranked = [...new Set(files)]
    .map((path) => ({ path, score: matchScore(path, query.trim()) }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  const results: string[] = [];
  for (const item of ranked) {
    // ls-files 也会列出已删除的暂存文件和子模块目录。
    if ((await stat(join(cwd, item.path)).catch(() => null))?.isFile()) results.push(item.path);
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

/** 给不支持原生 @文件 语法的 CLI 附上可读取的绝对路径，消息气泡仍保留用户原文。 */
export async function withProjectFilePaths(text: string, cwd: string): Promise<string> {
  const mentions = [...text.matchAll(/(^|[\s，,、(（])@("(?:\\.|[^"\\])*"|[^\s@，,、。!?;:]*[^\s@，,、。!?;:.])(?=$|\s|[，,、。!?;:])/g)]
    .slice(0, 20)
    .map((match) => {
      const raw = match[2]!;
      if (!raw.startsWith('"')) return raw;
      try { return JSON.parse(raw) as string; } catch { return ""; }
    })
    .filter(Boolean);
  const paths = await Promise.all([...new Set(mentions)].map(async (mention) => {
    const fullPath = resolve(cwd, mention);
    const pathFromProject = relative(cwd, fullPath);
    if (!pathFromProject || pathFromProject === ".." || pathFromProject.startsWith("../") || isAbsolute(pathFromProject)) return null;
    return (await stat(fullPath).catch(() => null))?.isFile()
      ? `${JSON.stringify(`@${mention}`)}：${JSON.stringify(fullPath)}`
      : null;
  }));
  const found = paths.filter((path): path is string => Boolean(path));
  return found.length ? `${text}\n\n项目文件引用（按需读取）：\n${found.map((path) => `- ${path}`).join("\n")}` : text;
}
