import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionAgent, ExtensionsSnapshot, McpAddParams } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import { hcode } from "../bridge";
import { useAppStore } from "../store/appStore";

const inputClass = "h-8 min-w-0 rounded-lg border border-input-border bg-input px-2.5 text-ui-sm text-foreground outline-none focus:border-input-border-focused";

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
        ...(transport === "http" ? { url: target } : { command: target, args: argsText.split("\n").map((arg) => arg.trim()).filter(Boolean) }),
      });
      setName("");
      setTarget("");
      setArgsText("");
    });
  };

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-5 py-3 text-ui-base">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <select value={agent} disabled={busy} onChange={(event) => setAgent(event.target.value as ExtensionAgent)} className={inputClass} aria-label="CLI">
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <select value={projectPath} disabled={busy} onChange={(event) => setProjectPath(event.target.value)} className={`${inputClass} max-w-full min-w-0 flex-1`} aria-label="项目">
          {projects.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
        </select>
        <Button variant="outline" size="lg" disabled={!projectPath || loading || busy} onClick={() => void refresh()}>刷新</Button>
      </div>

      {error ? <p role="alert" className="min-w-0 break-words rounded-lg bg-destructive/10 p-2 text-ui-sm text-destructive">{error}</p> : null}
      {!projectPath ? <p className="text-foreground-subtle">先添加一个项目，再管理 MCP 和技能。</p> : null}

      <section className="flex min-w-0 max-w-full flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-foreground">MCP 服务器</h3>
          {loading ? <span className="text-ui-sm text-foreground-subtle">正在读取…</span> : null}
        </div>
        {snapshot?.mcp.length === 0 ? <p className="text-ui-sm text-foreground-subtle">暂无服务器</p> : null}
        {snapshot?.mcp.map((item) => (
          <div key={`${item.scope}:${item.name}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">{item.name}</div>
              <div className="truncate text-ui-sm text-foreground-subtle">{item.scope} · {item.status}{item.detail ? ` · ${item.detail}` : ""}</div>
            </div>
            {item.canToggle ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(() => hcode.invoke("extensions:setMcpEnabled", agent, projectPath, item.name, !item.enabled))}>
                {item.enabled ? "停用" : "启用"}
              </Button>
            ) : null}
            {item.canRemove ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
                if (window.confirm(`删除 MCP 服务器“${item.name}”？`)) void mutate(() => hcode.invoke("extensions:removeMcp", agent, projectPath, item.name, item.scope));
              }}>删除</Button>
            ) : null}
          </div>
        ))}
        {projectPath ? (
          <div className="flex min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border p-3">
            <div className="font-medium text-foreground">添加服务器</div>
            <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
              <input className={`${inputClass} w-full sm:col-span-2`} value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" aria-label="服务器名称" />
              <select className={`${inputClass} w-full`} value={transport} onChange={(event) => setTransport(event.target.value as McpAddParams["transport"])} aria-label="传输方式">
                <option value="http">HTTP</option><option value="stdio">本地命令</option>
              </select>
              {agent === "claude" ? (
                <select className={`${inputClass} w-full`} value={scope} onChange={(event) => setScope(event.target.value as McpAddParams["scope"])} aria-label="作用范围">
                  <option value="user">所有项目</option><option value="project">当前项目共享</option><option value="local">当前项目本机</option>
                </select>
              ) : null}
            </div>
            <input className={`${inputClass} w-full max-w-full`} value={target} onChange={(event) => setTarget(event.target.value)} placeholder={transport === "http" ? "https://example.com/mcp" : "启动命令，例如 npx"} aria-label={transport === "http" ? "服务器地址" : "启动命令"} />
            {transport === "stdio" ? <textarea className={`${inputClass} h-16 w-full max-w-full py-1.5`} value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder="命令参数，每行一个" aria-label="命令参数" /> : null}
            <div className="flex justify-end"><Button size="sm" disabled={busy || !name.trim() || !target.trim()} onClick={addMcp}>添加</Button></div>
          </div>
        ) : null}
      </section>

      <section className="flex min-w-0 max-w-full flex-col gap-2">
        <h3 className="font-medium text-foreground">Skills 技能</h3>
        {snapshot?.skills.length === 0 ? <p className="text-ui-sm text-foreground-subtle">暂无技能</p> : null}
        {snapshot?.skills.map((item) => (
          <div key={item.path} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border p-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-foreground">{item.name}</div>
              <div className="truncate text-ui-sm text-foreground-subtle" title={item.path}>{item.scope} · {item.description || item.path}</div>
            </div>
            {item.canToggle ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void mutate(() => hcode.invoke("extensions:setSkillEnabled", agent, projectPath, item.path, item.name, !item.enabled))}>{item.enabled ? "停用" : "启用"}</Button> : null}
          </div>
        ))}
      </section>
      <p className="min-w-0 break-words text-ui-sm text-foreground-subtle">Claude 技能开关作用于当前项目；插件技能随插件管理。Codex 项目配置的 MCP 在此只读。设置更新后，新会话会使用最新配置；已运行的会话可能需要重开。</p>
    </div>
  );
}
