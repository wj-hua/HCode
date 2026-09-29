import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAgent, ExtensionsSnapshot, McpAddParams, McpEntry, SkillEntry } from "../shared/types.js";
import type { ClaudeAgent } from "./agents/claude/claudeAgent.js";
import type { CodexAgent } from "./agents/codex/codexAgent.js";
import { skillName } from "./util/skillFrontmatter.js";

const execFile = promisify(execFileCallback);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function readObject(path: string): Promise<Record<string, unknown>> {
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeObject(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/** Claude CLI 自己创建 settings.local.json 时会忽略它；HCode 创建时也保持同样效果。 */
async function ignoreClaudeLocalSettings(projectPath: string): Promise<void> {
  const target = join(projectPath, ".claude", "settings.local.json");
  const git = (args: string[]) => execFile("git", args, { cwd: projectPath, timeout: 10_000 });
  try {
    await git(["rev-parse", "--is-inside-work-tree"]);
    try {
      await git(["check-ignore", "-q", "--", target]);
      return;
    } catch {
      // 尚未被忽略，继续检查是否已被用户跟踪。
    }
    try {
      await git(["ls-files", "--error-unmatch", "--", target]);
      return;
    } catch {
      // 未跟踪，可写入当前仓库的本机排除规则。
    }
    const { stdout } = await git(["rev-parse", "--git-path", "info/exclude"]);
    const exclude = resolve(projectPath, stdout.trim());
    const existing = await readFile(exclude, "utf8").catch(() => "");
    const rule = "**/.claude/settings.local.json";
    if (existing.split("\n").includes(rule)) return;
    await mkdir(dirname(exclude), { recursive: true });
    await appendFile(exclude, `${existing && !existing.endsWith("\n") ? "\n" : ""}${rule}\n`);
  } catch {
    // 非 Git 目录或仓库只读时，设置本身仍可保存。
  }
}

async function claudeSkills(projectPath: string): Promise<SkillEntry[]> {
  const userSettings = await readObject(join(homedir(), ".claude", "settings.json"));
  const projectSettings = await readObject(join(projectPath, ".claude", "settings.json"));
  const localSettings = await readObject(join(projectPath, ".claude", "settings.local.json"));
  const overrides = {
    ...record(userSettings.skillOverrides),
    ...record(projectSettings.skillOverrides),
    ...record(localSettings.skillOverrides),
  };
  const enabledPlugins = {
    ...record(userSettings.enabledPlugins),
    ...record(projectSettings.enabledPlugins),
    ...record(localSettings.enabledPlugins),
  };
  const roots: { path: string; scope: string; canToggle: boolean; enabled: boolean; prefix: string }[] = [
    { path: join(homedir(), ".claude", "skills"), scope: "user", canToggle: true, enabled: true, prefix: "" },
    { path: join(projectPath, ".claude", "skills"), scope: "project", canToggle: true, enabled: true, prefix: "" },
  ];
  const installed = await readObject(join(homedir(), ".claude", "plugins", "installed_plugins.json"));
  for (const [pluginId, versions] of Object.entries(record(installed.plugins))) {
    const active = Array.isArray(versions) ? versions[0] : versions;
    const installPath = record(active).installPath;
    if (typeof installPath !== "string") continue;
    roots.push({
      path: join(installPath, "skills"),
      scope: "plugin",
      canToggle: false,
      enabled: enabledPlugins[pluginId] !== false,
      prefix: `${pluginId.split("@")[0]}:`,
    });
  }
  const skills: SkillEntry[] = [];
  for (const root of roots) {
    const dirs = await readdir(root.path, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
      const path = join(root.path, dir.name, "SKILL.md");
      const content = await readFile(path, "utf8").catch(() => null);
      if (content === null) continue;
      const parsed = skillName(content.slice(0, 8192), dir.name);
      const name = `${root.prefix}${parsed.name}`;
      skills.push({ name, description: parsed.description, path, scope: root.scope, enabled: root.enabled && (root.scope === "plugin" || overrides[name] !== "off"), canToggle: root.canToggle });
    }
  }
  // Claude 对重名技能只加载优先级更高的一份；用户技能优先于项目技能。
  return [...new Map(skills.reverse().map((skill) => [skill.name, skill])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class ExtensionsService {
  constructor(
    private readonly claude: ClaudeAgent,
    private readonly codex: CodexAgent,
    private readonly getEnv: () => Record<string, string>,
  ) {}

  private async cli(agent: ExtensionAgent, projectPath: string, args: string[]): Promise<string> {
    const status = await (agent === "claude" ? this.claude : this.codex).getStatus();
    if (!status.found || !status.path) throw new Error(`未找到 ${agent} 命令，请在设置中指定路径`);
    const { stdout } = await execFile(status.path, args, {
      cwd: projectPath,
      env: this.getEnv(),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  }

  async list(agent: ExtensionAgent, projectPath: string): Promise<ExtensionsSnapshot> {
    if (agent === "codex") {
      const [mcp, skills] = await Promise.all([
        this.codex.listManagedMcp(projectPath),
        this.codex.listManagedSkills(projectPath),
      ]);
      return { mcp, skills };
    }

    const [skills, statuses, projectConfig, localSettings, sharedSettings, userSettings, claudeConfig] = await Promise.all([
      claudeSkills(projectPath),
      this.claude.listMcpStatus(projectPath).catch(() => []),
      readObject(join(projectPath, ".mcp.json")),
      readObject(join(projectPath, ".claude", "settings.local.json")),
      readObject(join(projectPath, ".claude", "settings.json")),
      readObject(join(homedir(), ".claude", "settings.json")),
      readObject(join(homedir(), ".claude.json")),
    ]);
    const disabled = new Set([userSettings, sharedSettings, localSettings].flatMap((settings) =>
      Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers : [],
    ));
    const lockedDisabled = new Set([userSettings, sharedSettings].flatMap((settings) =>
      Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers : [],
    ));
    const projectNames = Object.keys(record(projectConfig.mcpServers));
    const localNames = Object.keys(record(record(record(claudeConfig.projects)[projectPath]).mcpServers));
    const userNames = Object.keys(record(claudeConfig.mcpServers));
    const mcp = statuses.map((item): McpEntry => {
      const source = item.source ?? item.scope;
      const project = projectNames.includes(item.name) && (!source || source === "project");
      return {
        name: item.name,
        scope: project ? "project" : item.scope ?? source ?? "user",
        status: item.status === "failed" ? `连接失败${item.error ? `：${item.error}` : ""}` : item.status,
        enabled: item.status !== "disabled" && !(project && disabled.has(item.name)),
        canToggle: project && !lockedDisabled.has(item.name),
        canRemove: ["user", "local", "project"].includes(source ?? ""),
      };
    });
    for (const name of projectNames) {
      if (mcp.some((item) => item.name === name)) continue;
      mcp.push({ name, scope: "project", status: disabled.has(name) ? "已停用" : "待授权", enabled: !disabled.has(name), canToggle: !lockedDisabled.has(name), canRemove: true });
    }
    for (const { names, scope } of [{ names: localNames, scope: "local" }, { names: userNames, scope: "user" }]) {
      for (const name of names) {
        if (mcp.some((item) => item.name === name)) continue;
        mcp.push({ name, scope, status: "已配置", enabled: true, canToggle: false, canRemove: true });
      }
    }
    return { mcp, skills };
  }

  async setMcpEnabled(agent: ExtensionAgent, projectPath: string, name: string, enabled: boolean): Promise<void> {
    if (agent === "codex") {
      const server = (await this.codex.listManagedMcp(projectPath)).find((item) => item.name === name);
      if (!server?.canToggle) throw new Error("此 Codex MCP 配置不可切换");
      return this.codex.setMcpEnabled(name, enabled);
    }
    const projectConfig = await readObject(join(projectPath, ".mcp.json"));
    if (!(name in record(projectConfig.mcpServers))) throw new Error("仅能切换项目 .mcp.json 中的服务器");
    const path = join(projectPath, ".claude", "settings.local.json");
    const settings = await readObject(path);
    const current = Array.isArray(settings.disabledMcpjsonServers) ? settings.disabledMcpjsonServers.filter((x): x is string => typeof x === "string") : [];
    settings.disabledMcpjsonServers = enabled ? current.filter((x) => x !== name) : [...new Set([...current, name])];
    await ignoreClaudeLocalSettings(projectPath);
    await writeObject(path, settings);
  }

  async setSkillEnabled(agent: ExtensionAgent, projectPath: string, path: string, name: string, enabled: boolean): Promise<void> {
    if (agent === "codex") return this.codex.setSkillEnabled(path, enabled);
    const skills = await claudeSkills(projectPath);
    const skill = skills.find((item) => item.path === path && item.name === name);
    if (!skill) throw new Error("技能不存在或已移动");
    // 项目本机设置优先级最高，用户和项目技能都可在当前项目单独切换。
    const settingsPath = join(projectPath, ".claude", "settings.local.json");
    const settings = await readObject(settingsPath);
    const overrides = record(settings.skillOverrides);
    overrides[name] = enabled ? "on" : "off";
    settings.skillOverrides = overrides;
    await ignoreClaudeLocalSettings(projectPath);
    await writeObject(settingsPath, settings);
  }

  async addMcp(params: McpAddParams): Promise<void> {
    const { agent, projectPath, scope, transport } = params;
    const name = params.name.trim();
    if (!/^[\w-]+$/.test(name)) throw new Error("名称只能包含字母、数字、下划线和连字符");
    if (agent === "codex" && scope !== "user") throw new Error("Codex MCP 添加目前只支持用户范围");
    let args: string[];
    if (transport === "http") {
      const url = params.url?.trim() ?? "";
      if (!/^https?:\/\/\S+$/.test(url)) throw new Error("请输入有效的 HTTP 地址");
      args = agent === "codex" ? ["mcp", "add", name, "--url", url] : ["mcp", "add", "--scope", scope, "--transport", "http", name, url];
    } else {
      const command = params.command?.trim() ?? "";
      if (!command) throw new Error("请输入启动命令");
      args = agent === "codex"
        ? ["mcp", "add", name, "--", command, ...(params.args ?? [])]
        : ["mcp", "add", "--scope", scope, name, "--", command, ...(params.args ?? [])];
    }
    await this.cli(agent, projectPath, args);
  }

  async removeMcp(agent: ExtensionAgent, projectPath: string, name: string, scope: string): Promise<void> {
    if (agent === "codex") {
      const server = (await this.codex.listManagedMcp(projectPath)).find((item) => item.name === name);
      if (!server?.canRemove) throw new Error("此 Codex MCP 配置不可删除");
    }
    if (agent === "claude" && !["user", "local", "project"].includes(scope)) throw new Error("此服务器不支持删除");
    await this.cli(agent, projectPath, agent === "codex"
      ? ["mcp", "remove", name]
      : ["mcp", "remove", "--scope", scope, name]);
  }
}
