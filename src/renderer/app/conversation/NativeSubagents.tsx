import { useEffect, useState } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { NativeSubagent } from "@hcode/shared/types";
import { hcode } from "../bridge";
import { Timeline } from "./Timeline";

/** 原生子代理使用各 CLI 自己的独立会话；按需读取，打开时持续刷新。 */
export function NativeSubagents({ agent, sessionId, projectPath }: { agent: "claude" | "codex" | "agy"; sessionId: string; projectPath: string }) {
  const [agents, setAgents] = useState<NativeSubagent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setAgents([]);
    setSelected(null);
    setRows(null);
    setError(null);
    setDetailError(null);
    const refresh = async () => {
      try {
        const result = agent === "claude"
          ? (await hcode.invoke("claude:subagents", sessionId, projectPath)).map(id => ({ id, parentId: sessionId }))
          : agent === "codex" ? await hcode.invoke("codex:subagents", sessionId, projectPath)
          : await hcode.invoke("agy:subagents", sessionId, projectPath);
        if (!stopped) { setAgents(result); setError(null); }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agent, sessionId, projectPath]);

  useEffect(() => {
    if (!selected || !expanded) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    setRows(null);
    setDetailError(null);
    const refresh = async () => {
      try {
        const result = agent === "claude"
          ? await hcode.invoke("claude:subagentMessages", sessionId, projectPath, selected)
          : agent === "codex" ? await hcode.invoke("codex:subagentMessages", sessionId, projectPath, selected)
          : await hcode.invoke("agy:subagentMessages", sessionId, projectPath, selected);
        if (!stopped) { setRows(result); setDetailError(null); }
      } catch (err) {
        if (!stopped) setDetailError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(refresh, 2000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agent, sessionId, projectPath, selected, expanded]);

  // 新会话在 CLI 写入记录前读取会失败；没读到子代理时不显示卡片，失败只在已有列表时提示。
  if (!agents.length) return null;
  return (
    <details onToggle={event => setExpanded(event.currentTarget.open)} className="mb-2 rounded-lg border border-border p-3">
      <summary className="cursor-pointer text-ui-sm font-medium">{agent === "claude" ? "Claude" : agent === "codex" ? "Codex" : "Antigravity"} 子代理记录（{agents.length}）</summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2" aria-label="子代理列表">
          {agents.map((child, index) => (
            <button key={child.id} type="button" aria-pressed={selected === child.id} onClick={() => setSelected(child.id)}
              className="rounded-md border border-border px-2 py-1 text-ui-sm aria-pressed:bg-accent">
              {child.nickname || child.role || `子代理 ${index + 1}`} · {child.id.slice(0, 8)}
            </button>
          ))}
        </div>
        {error ? <p role="alert" className="text-ui-sm text-destructive">读取子代理记录失败：{error}</p> : null}
        {detailError ? <p role="alert" className="text-ui-sm text-destructive">读取所选记录失败：{detailError}</p> : null}
        {selected ? rows === null ? !detailError && <p className="text-ui-sm text-foreground-subtle">正在读取记录…</p>
          : rows.length ? <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border p-3">
            <Timeline rows={rows} workspacePath={projectPath} permissions={{}} running={false} canFork={false} canResend={false} highlightedRowId={null} />
          </div> : <p className="text-ui-sm text-foreground-subtle">暂无可读取的记录，运行时会自动刷新。</p>
          : <p className="text-ui-sm text-foreground-subtle">选择子代理查看记录。记录会自动刷新。</p>}
      </div>
    </details>
  );
}
