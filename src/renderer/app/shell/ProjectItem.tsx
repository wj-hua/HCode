import {
  ChevronRightIcon,
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";
import type { Project } from "@hcode/shared/types";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { hcode } from "../bridge";
import { shortenHome } from "../format";
import { useAppStore } from "../store/appStore";
import { SessionItem } from "./SessionItem";

const PAGE_SIZE = 10;

export function ProjectItem({ project, query }: { project: Project; query: string }) {
  const expanded = useAppStore((state) => state.expanded[project.path] ?? false);
  const sessions = useAppStore((state) => state.sessions[project.path]);
  const toggleProject = useAppStore((state) => state.toggleProject);
  const newChat = useAppStore((state) => state.newChat);
  const setProjectPinned = useAppStore((state) => state.setProjectPinned);
  const removeProject = useAppStore((state) => state.removeProject);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const filtered = query
    ? (sessions ?? []).filter((session) => session.title.toLowerCase().includes(query))
    : (sessions ?? []);
  const isOpen = expanded || (query.length > 0 && filtered.length > 0);
  const visible = filtered.slice(0, limit);

  return (
    <li className="flex flex-col gap-0.5">
      <div className="group flex items-center gap-1 rounded-lg hover:bg-surface-hover">
        <button
          type="button"
          title={shortenHome(project.path)}
          onClick={() => toggleProject(project.path)}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 pr-1 text-left",
            !project.exists && "opacity-50",
          )}
        >
          <span className="relative flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
            <span className="group-hover:hidden">
              {isOpen ? <FolderOpenIcon className="size-4" /> : <FolderIcon className="size-4" />}
            </span>
            <ChevronRightIcon
              className={cn(
                "hidden size-4 transition-transform group-hover:block",
                isOpen && "rotate-90",
              )}
            />
          </span>
          <span className="min-w-0 truncate text-ui-base text-foreground-subtle">{project.name}</span>
          {project.pinned ? <PinIcon className="size-3 shrink-0 text-foreground-subtlest" /> : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5 pr-1 opacity-0 transition-opacity group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-foreground-subtle">
                <EllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              {AGENT_KINDS.map((kind) => (
                <DropdownMenuItem key={kind} onSelect={() => newChat(project.path, kind)} className="gap-2">
                  <AgentBadge agent={kind} />
                  新建 {AGENTS[kind].name} 会话
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void hcode.invoke("app:showInFinder", project.path)}>
                在 Finder 中显示
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void hcode.invoke("app:openInTerminal", project.path)}>
                在终端中打开
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void hcode.invoke("app:copyText", project.path)}>
                复制路径
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void setProjectPinned(project.path, !project.pinned)}>
                {project.pinned ? "取消置顶" : "置顶"}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void removeProject(project.path)}>
                从列表中移除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ControlHintTooltip title="新建会话" side="top">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-foreground-subtle"
              onClick={() => {
                newChat(project.path);
                if (!expanded) toggleProject(project.path, true);
              }}
            >
              <PlusIcon />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>

      {isOpen ? (
        <ul className="flex flex-col gap-0.5 pb-1">
          {sessions === undefined ? (
            <li className="pl-9 text-ui-sm text-foreground-subtlest">加载中…</li>
          ) : visible.length === 0 ? (
            <li className="py-1 pl-9 text-ui-sm text-foreground-subtlest">暂无会话</li>
          ) : (
            visible.map((session) => <SessionItem key={session.id} session={session} />)
          )}
          {filtered.length > visible.length ? (
            <li>
              <button
                type="button"
                className="h-7 w-full rounded-lg pl-9 text-left text-ui-sm text-foreground-subtlest hover:bg-surface-hover hover:text-foreground-subtle"
                onClick={() => setLimit((value) => value + PAGE_SIZE * 2)}
              >
                显示更多（还有 {filtered.length - visible.length} 个）
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
