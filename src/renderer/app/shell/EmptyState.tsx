import { FolderIcon, FolderPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { formatRelativeTime, shortenHome } from "../format";
import { useAppStore } from "../store/appStore";

export function EmptyState() {
  const projects = useAppStore((state) => state.projects);
  const newChat = useAppStore((state) => state.newChat);
  const toggleProject = useAppStore((state) => state.toggleProject);
  const addProject = useAppStore((state) => state.addProject);
  const agentStatuses = useAppStore((state) => state.agentStatuses);
  const noAgent = agentStatuses !== null && agentStatuses.every((status) => !status.found);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const recent = projects.filter((project) => project.exists).slice(0, 6);

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-ui-xl font-semibold text-foreground">开始一个新会话</h1>
          <p className="text-ui-base text-foreground-subtle">
            选择项目后用 Claude Code、Codex、StepCode、Antigravity 或 pi 开始对话，或者从左侧打开历史会话继续。
          </p>
        </div>
        {noAgent ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-ui-base">
            <span className="text-foreground">没有找到 claude、codex、step、agy 或 pi 命令。请先安装，或在设置里指定路径。</span>
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              打开设置
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-1">
          {recent.map((project) => (
            <button
              key={project.path}
              type="button"
              onClick={() => {
                toggleProject(project.path, true);
                newChat(project.path);
              }}
              className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-hover"
            >
              <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-base text-foreground">{project.name}</span>
                <span className="truncate text-ui-sm text-foreground-subtlest">{shortenHome(project.path)}</span>
              </span>
              {project.lastActiveAt ? (
                <span className="shrink-0 text-ui-sm text-foreground-subtlest">
                  {formatRelativeTime(project.lastActiveAt)}
                </span>
              ) : null}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void addProject()}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-left text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
          >
            <FolderPlusIcon className="size-4 shrink-0" />
            <span className="text-ui-base">添加项目文件夹…</span>
          </button>
        </div>
      </div>
    </div>
  );
}
