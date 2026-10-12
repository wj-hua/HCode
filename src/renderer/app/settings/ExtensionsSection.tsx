import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionAgent, ExtensionsSnapshot, McpAddParams } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { hcode } from "../bridge";
import { useAppStore } from "../store/appStore";
import {
  Boxes,
  Cpu,
  RefreshCw,
  Plus,
  Trash2,
  AlertCircle,
  FolderGit2,
  CheckCircle2,
  Info,
  ChevronDown,
  Sparkles,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";

const MCP_PRESETS = [
  {
    name: "fetch",
    label: "Fetch 网页",
    transport: "stdio" as const,
    target: "uvx",
    args: "mcp-server-fetch",
  },
  {
    name: "filesystem",
    label: "Filesystem 文件",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-filesystem\n.",
  },
  {
    name: "git",
    label: "Git 仓库",
    transport: "stdio" as const,
    target: "uvx",
    args: "mcp-server-git",
  },
  {
    name: "memory",
    label: "Memory 记忆",
    transport: "stdio" as const,
    target: "npx",
    args: "-y\n@modelcontextprotocol/server-memory",
  },
];

const inputClass =
  "h-8 min-w-0 rounded-lg border border-input-border bg-input px-2.5 text-ui-sm text-foreground outline-none transition-colors hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused";

function StyledSelect<T extends string>({
  value,
  onChange,
  disabled,
  children,
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (val: T) => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className={cn("relative inline-block", className)}>
      <select
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full appearance-none rounded-lg border border-input-border bg-input pl-3 pr-8 text-ui-sm text-foreground transition-colors hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused outline-none disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-subtle" />
    </div>
  );
}

export function ExtensionsSection({ open }: { open: boolean }) {
  const projects = useAppStore((state) => state.projects);
  const conversations = useAppStore((state) => state.conversations);
  const activeViewId = useAppStore((state) => state.activeViewId);
  const [agent, setAgent] = useState<ExtensionAgent>("claude");
  const [projectPath, setProjectPath] = useState("");
  const [snapshot, setSnapshot] = useState<ExtensionsSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpAddParams["scope"]>("user");
  const [transport, setTransport] = useState<McpAddParams["transport"]>("http");
  const [target, setTarget] = useState("");
  const [argsText, setArgsText] = useState("");
  const requestId = useRef(0);

  useEffect(() => {
    if (!projectPath || !projects.some((project) => project.path === projectPath)) {
      setProjectPath(conversations[activeViewId ?? ""]?.projectPath ?? projects[0]?.path ?? "");
    }
  }, [activeViewId, conversations, projectPath, projects]);

  const refresh = useCallback(async () => {
    if (!projectPath) return;
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError("");
    setSnapshot(null);
    try {
      const result = await hcode.invoke("extensions:list", agent, projectPath);
      if (requestId.current === currentRequest) setSnapshot(result);
    } catch (cause) {
      if (requestId.current === currentRequest) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  }, [agent, projectPath]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const addMcp = () => {
    void mutate(async () => {
      await hcode.invoke("extensions:addMcp", {
        agent,
        projectPath,
        name,
        scope: agent === "codex" ? "user" : scope,
        transport,
        ...(transport === "http"
          ? { url: target }
          : { command: target, args: argsText.split("\n").map((arg) => arg.trim()).filter(Boolean) }),
      });
      setName("");
      setTarget("");
      setArgsText("");
    });
  };

  const scopeLabel: Record<string, string> = {
    user: "全局所有项目",
    project: "当前项目共享",
    local: "当前项目本机专用",
  };

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-6 text-ui-base">
      {/* 顶部目标上下文选择条 */}
      <div className="rounded-xl border border-border/70 bg-card/40 p-3.5 shadow-2xs flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 min-w-0 items-center gap-2.5">
          <StyledSelect
            value={agent}
            disabled={busy}
            onChange={(val) => setAgent(val)}
            className="w-36 shrink-0"
            ariaLabel="智能体 CLI"
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </StyledSelect>

          <div className="flex flex-1 min-w-[200px] items-center gap-2">
            <StyledSelect
              value={projectPath}
              disabled={busy}
              onChange={(val) => setProjectPath(val)}
              className="flex-1"
              ariaLabel="目标项目"
            >
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.name} ({project.path})
                </option>
              ))}
            </StyledSelect>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={!projectPath || loading || busy}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("size-3.5 mr-1.5", loading && "animate-spin")} />
          刷新配置
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-destructive/20 bg-destructive/10 p-3.5 text-ui-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1 break-words">{error}</div>
        </div>
      )}

      {!projectPath && (
        <div className="rounded-xl border border-dashed border-border/70 p-6 text-center text-foreground-subtle">
          <FolderGit2 className="size-8 mx-auto mb-2 opacity-50" />
          <p>请先在侧边栏中添加或选择一个项目，再管理 MCP 与技能。</p>
        </div>
      )}

      {/* MCP 服务器列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Boxes className="size-4 text-primary" />
            <h3 className="text-ui-base font-semibold text-foreground">MCP 服务器</h3>
            {snapshot?.mcp && (
              <span className="rounded-full bg-surface border border-border/60 px-2 py-0.2 text-ui-xs text-foreground-subtle">
                {snapshot.mcp.length}
              </span>
            )}
          </div>
          {loading && <span className="text-ui-xs text-foreground-subtle">正在读取配置…</span>}
        </div>

        {snapshot?.mcp.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/60 bg-surface/10 p-6 text-center text-ui-sm text-foreground-subtle">
            当前暂未配置任何 MCP 服务器
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {snapshot?.mcp.map((item) => (
            <div
              key={`${item.scope}:${item.name}`}
              className="flex min-w-0 max-w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/40 p-3.5 shadow-2xs transition-all hover:border-border"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground truncate">{item.name}</span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle border border-border/60">
                    {scopeLabel[item.scope] || item.scope}
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.2 text-ui-xs",
                      item.enabled
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"
                        : "bg-surface text-foreground-subtle border border-border/60",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        item.enabled ? "bg-emerald-500" : "bg-foreground-subtle",
                      )}
                    />
                    {item.status || (item.enabled ? "已启用" : "已停用")}
                  </span>
                </div>
                {item.detail && (
                  <div className="mt-1 truncate font-mono text-ui-xs text-foreground-subtle" title={item.detail}>
                    {item.detail}
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {item.canToggle && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void mutate(() =>
                        hcode.invoke("extensions:setMcpEnabled", agent, projectPath, item.name, !item.enabled),
                      )
                    }
                  >
                    {item.enabled ? "停用" : "启用"}
                  </Button>
                )}
                {item.canRemove && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`确认删除 MCP 服务器“${item.name}”？`)) {
                        void mutate(() =>
                          hcode.invoke("extensions:removeMcp", agent, projectPath, item.name, item.scope),
                        );
                      }
                    }}
                    className="text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 添加 MCP 服务器表单卡片 */}
        {projectPath && (
          <div className="rounded-xl border border-border/70 bg-card/40 p-4 shadow-2xs flex flex-col gap-3.5 mt-1">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2.5">
              <div className="flex items-center gap-2 font-medium text-foreground text-ui-base">
                <Plus className="size-4 text-primary" />
                <span>添加 MCP 服务器</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-ui-xs text-foreground-subtle">
                <Sparkles className="size-3 text-amber-500" />
                <span>快捷模板：</span>
                {MCP_PRESETS.map((preset) => (
                  <button
                    key={preset.name}
                    type="button"
                    onClick={() => {
                      setName(preset.name);
                      setTransport(preset.transport);
                      setTarget(preset.target);
                      setArgsText(preset.args);
                    }}
                    className="rounded-md border border-border/60 bg-surface/40 px-2 py-0.5 text-ui-xs text-foreground-subtle transition-colors hover:border-border hover:bg-surface hover:text-foreground cursor-pointer"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="服务器名称（如 fetch, git）"
                aria-label="服务器名称"
              />
              <StyledSelect
                value={transport}
                onChange={(val) => setTransport(val as McpAddParams["transport"])}
                ariaLabel="传输协议"
              >
                <option value="http">HTTP / SSE</option>
                <option value="stdio">本地命令 (stdio)</option>
              </StyledSelect>
              {agent === "claude" ? (
                <StyledSelect
                  value={scope}
                  onChange={(val) => setScope(val as McpAddParams["scope"])}
                  ariaLabel="生效范围"
                >
                  <option value="user">全局所有项目</option>
                  <option value="project">当前项目共享</option>
                  <option value="local">当前项目本机专用</option>
                </StyledSelect>
              ) : (
                <div className="flex items-center text-ui-xs text-foreground-subtle px-2">
                  Codex 固定作用于全局
                </div>
              )}
            </div>

            <input
              className={inputClass}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              placeholder={transport === "http" ? "https://example.com/mcp" : "启动命令（例如 npx）"}
              aria-label={transport === "http" ? "服务器地址" : "启动命令"}
            />

            {transport === "stdio" && (
              <textarea
                className={cn(inputClass, "h-20 w-full py-2 font-mono text-ui-xs leading-relaxed")}
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                placeholder="命令行参数（每行一个参数，例如：&#10;-y&#10;@modelcontextprotocol/server-everything"
                aria-label="命令行参数"
              />
            )}

            <div className="flex justify-end pt-1">
              <Button size="sm" disabled={busy || !name.trim() || !target.trim()} onClick={addMcp}>
                <Plus className="size-3.5 mr-1" />
                添加服务器
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Skills 技能列表 */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-primary" />
            <h3 className="text-ui-base font-semibold text-foreground">Skills 技能</h3>
            {snapshot?.skills && (
              <span className="rounded-full bg-surface border border-border/60 px-2 py-0.2 text-ui-xs text-foreground-subtle">
                {snapshot.skills.length}
              </span>
            )}
          </div>
        </div>

        {snapshot?.skills.length === 0 && (
          <div className="rounded-xl border border-dashed border-border/60 bg-surface/10 p-6 text-center text-ui-sm text-foreground-subtle">
            当前暂未配置或检测到任何技能
          </div>
        )}

        <div className="flex flex-col gap-2.5">
          {snapshot?.skills.map((item) => (
            <div
              key={item.path}
              className="flex min-w-0 max-w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/40 p-3.5 shadow-2xs transition-all hover:border-border"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground truncate">{item.name}</span>
                  <span className="rounded bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtle border border-border/60">
                    {item.scope}
                  </span>
                </div>
                <div className="mt-1 truncate text-ui-sm text-foreground-subtle" title={item.path}>
                  {item.description || item.path}
                </div>
              </div>

              {item.canToggle && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void mutate(() =>
                      hcode.invoke("extensions:setSkillEnabled", agent, projectPath, item.path, item.name, !item.enabled),
                    )
                  }
                >
                  {item.enabled ? "停用" : "启用"}
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 底部说明 Callout */}
      <div className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-surface/30 p-3 text-ui-xs text-foreground-subtle leading-relaxed">
        <Info className="size-4 shrink-0 text-foreground-subtle mt-0.5" />
        <p>
          Claude 技能开关作用于当前项目；插件技能随插件统一管理。Codex 项目配置的 MCP
          在此仅作只读展示。设置修改后，新启动的会话将自动生效最新配置；当前已运行中的会话需重启以加载新扩展。
        </p>
      </div>
    </div>
  );
}
