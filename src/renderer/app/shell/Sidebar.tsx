// 侧边栏：项目列表 + 会话历史。行样式照 ZCode WorkspaceSidebarItem / TaskListItem。
import {
  FolderPlusIcon,
  PanelLeftIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useAppStore } from "../store/appStore";
import { ProjectItem } from "./ProjectItem";

export function Sidebar() {
  const projects = useAppStore((state) => state.projects);
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const addProject = useAppStore((state) => state.addProject);
  const agentStatus = useAppStore((state) => state.agentStatus);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const fullscreen = useAppStore((state) => state.fullscreen);
  const sessions = useAppStore((state) => state.sessions);
  const activeProjectPath = useAppStore((state) =>
    state.activeViewId ? state.conversations[state.activeViewId]?.projectPath : undefined,
  );
  const newChat = useAppStore((state) => state.newChat);

  const query = search.trim().toLowerCase();
  const visibleProjects = useMemo(() => {
    if (!query) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.path.toLowerCase().includes(query) ||
        (sessions[project.path] ?? []).some((session) => session.title.toLowerCase().includes(query)),
    );
  }, [projects, query, sessions]);

  return (
    <div className="flex h-full flex-col">
      {/* 顶部：给红绿灯留位置，整条可拖动窗口 */}
      <div className={cn("app-drag flex h-12 shrink-0 items-center gap-1 pr-2", fullscreen ? "pl-3" : "pl-[84px]")}>
        <ControlHintTooltip title="收起侧边栏" shortcut="⌘B" side="bottom">
          <Button
            variant="ghost"
            size="icon-md"
            className="app-no-drag text-foreground-subtle"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftIcon />
          </Button>
        </ControlHintTooltip>
        <div className="flex-1" />
        <ControlHintTooltip title="新建会话" shortcut="⌘N" side="bottom">
          <Button
            variant="ghost"
            size="icon-md"
            className="app-no-drag text-foreground-subtle"
            onClick={() => {
              const path = activeProjectPath ?? projects[0]?.path;
              if (path) newChat(path);
              else void addProject();
            }}
          >
            <SquarePenIcon />
          </Button>
        </ControlHintTooltip>
      </div>

      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-lg border border-input-border bg-input px-2.5 focus-within:border-input-border-focused">
          <SearchIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索项目或会话"
            className="min-w-0 flex-1 bg-transparent text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest"
          />
          {search ? (
            <button
              type="button"
              className="text-foreground-subtlest hover:text-foreground"
              onClick={() => setSearch("")}
            >
              <XIcon className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between pl-4 pr-2">
        <span className="text-ui-sm font-medium text-foreground-subtlest">项目</span>
        <ControlHintTooltip title="添加项目文件夹" side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-foreground-subtle"
            onClick={() => void addProject()}
          >
            <FolderPlusIcon />
          </Button>
        </ControlHintTooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [scrollbar-gutter:stable]">
        {visibleProjects.length === 0 ? (
          <div className="px-3 py-6 text-center text-ui-sm text-foreground-subtlest">
            {query ? "没有匹配的项目或会话" : "还没有项目，点击右上角添加文件夹"}
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {visibleProjects.map((project) => (
              <ProjectItem key={project.path} project={project} query={query} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-border/60 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-sm text-foreground-subtle">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              agentStatus === null ? "bg-border" : agentStatus.found ? "bg-success" : "bg-destructive",
            )}
          />
          <span className="truncate">
            {agentStatus === null
              ? "正在检测 Claude Code…"
              : agentStatus.found
                ? `Claude Code ${agentStatus.version ?? ""}`
                : "未找到 Claude Code"}
          </span>
        </div>
        <ControlHintTooltip title="设置" shortcut="⌘," side="top">
          <Button
            variant="ghost"
            size="icon-md"
            className="text-foreground-subtle"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon />
          </Button>
        </ControlHintTooltip>
      </div>
    </div>
  );
}
