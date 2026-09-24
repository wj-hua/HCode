// 项目行 + 会话列表，结构与样式照 ZCode WorkspaceSidebarItem / TaskList。
import {
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  HouseIcon,
  MessageCirclePlusIcon,
  PinIcon,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import type { Project } from "@hcode/shared/types";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Spinner } from "@/components/ui/spinner.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { AGENT_KINDS, AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { hcode } from "../bridge";
import { shortenHome } from "../format";
import { useAppStore } from "../store/appStore";
import { SessionItem } from "./SessionItem";

const PAGE_SIZE = 5;

function isHomePath(path: string): boolean {
  return /^\/Users\/[^/]+\/?$/.test(path);
}

// 行内操作按钮位于 CollapsibleTrigger 内部（下拉菜单内容经 Portal 渲染，React 事件仍沿组件树冒泡），
// 截断点击避免误触发项目展开/收起。
function stopPropagation(event: MouseEvent) {
  event.stopPropagation();
}

type SortableBindings = Pick<ReturnType<typeof useSortable>, "attributes" | "listeners">;

/** 可拖动排序的项目行，照 ZCode SortableWorkspaceSidebarItem。 */
export function SortableProjectItem({
  project,
  query,
  dragActive,
}: {
  project: Project;
  query: string;
  /** 正在拖动的是本项目：拖动期间收起会话列表，只保留项目头。 */
  dragActive: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.path,
  });
  const style = useMemo<CSSProperties>(
    () => ({
      // 项目行展开后高度不一，钳住缩放只保留位移，避免拖到其他项目上方时被压扁/拉长
      transform: transform ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 }) : undefined,
      transition,
      zIndex: isDragging ? 10 : undefined,
      // 拖动时由 DragOverlay 显示项目头，真实节点隐藏
      opacity: isDragging ? 0 : 1,
    }),
    [isDragging, transform, transition],
  );
  return (
    <ProjectItem
      project={project}
      query={query}
      collapsed={dragActive}
      itemRef={setNodeRef}
      itemStyle={style}
      sortableBindings={{ attributes, listeners }}
      isDragging={isDragging}
    />
  );
}

export function ProjectItem({
  project,
  query,
  collapsed = false,
  itemRef,
  itemStyle,
  sortableBindings,
  isDragging = false,
}: {
  project: Project;
  query: string;
  collapsed?: boolean;
  itemRef?: (node: HTMLLIElement | null) => void;
  itemStyle?: CSSProperties;
  sortableBindings?: SortableBindings;
  isDragging?: boolean;
}) {
  const expanded = useAppStore((state) => state.expanded[project.path] ?? false);
  const sessions = useAppStore((state) => state.sessions[project.path]);
  const toggleProject = useAppStore((state) => state.toggleProject);
  const newChat = useAppStore((state) => state.newChat);
  const setProjectPinned = useAppStore((state) => state.setProjectPinned);
  const removeProject = useAppStore((state) => state.removeProject);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const filtered = query
    ? (sessions ?? []).filter((session) => session.title.toLowerCase().includes(query))
    : (sessions ?? []);
  const isOpen = !collapsed && (expanded || (query.length > 0 && filtered.length > 0));
  const visible = filtered.slice(0, limit);
  // 与 ZCode 一致：操作按钮只在交互时挂载，菜单打开时保活。
  const showActions = hovered || focusWithin || menuOpen;
  const FolderGlyph = isHomePath(project.path) ? HouseIcon : isOpen ? FolderOpenIcon : FolderIcon;

  return (
    <li ref={itemRef} style={itemStyle} className="space-y-2">
      <Collapsible
        className="flex flex-col gap-1"
        open={isOpen}
        onOpenChange={(open) => toggleProject(project.path, open)}
      >
        <div
          className={cn(
            "group flex items-center gap-2 rounded-lg transition-[background-color,box-shadow]",
            isDragging && "bg-selected shadow-xl",
          )}
        >
          <CollapsibleTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              title={shortenHome(project.path)}
              className={cn(
                buttonVariants({ variant: "ghost", size: "default" }),
                "flex h-8 min-w-0 flex-1 justify-start gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground aria-expanded:bg-transparent aria-expanded:text-foreground",
                "hover:bg-surface-hover hover:text-foreground",
                !project.exists && "opacity-50",
                sortableBindings && "cursor-grab active:cursor-grabbing",
              )}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  toggleProject(project.path, !isOpen);
                }
              }}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onFocusCapture={() => setFocusWithin(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setFocusWithin(false);
                }
              }}
              {...(sortableBindings?.attributes ?? {})}
              {...(sortableBindings?.listeners ?? {})}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="relative flex size-4 shrink-0 items-center justify-center">
                  <FolderGlyph className="size-4 text-foreground-subtle" />
                </span>
                <div className="min-w-0 truncate text-ui-base text-foreground-subtle">{project.name}</div>
                {project.pinned ? <PinIcon className="size-3 shrink-0 text-foreground-subtlest" /> : null}
              </div>

              {showActions ? (
                <div className="flex shrink-0 items-center gap-1" onClick={stopPropagation}>
                  <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                    <ControlHintTooltip title="更多">
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                          aria-label="更多"
                        >
                          <EllipsisIcon className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                    </ControlHintTooltip>
                    <DropdownMenuContent align="end" className="min-w-44" onClick={stopPropagation}>
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
                  <ControlHintTooltip title="新建会话">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
                      aria-label="新建会话"
                      onClick={() => {
                        newChat(project.path);
                        if (!expanded) toggleProject(project.path, true);
                      }}
                    >
                      <MessageCirclePlusIcon className="size-3.5" />
                    </Button>
                  </ControlHintTooltip>
                </div>
              ) : null}
            </div>
          </CollapsibleTrigger>
        </div>

        <CollapsibleContent>
          <div className="flex flex-col gap-2">
            <div>
              <div className="space-y-1">
                {sessions === undefined ? (
                  <div className="flex items-center gap-2 px-2.5 py-1 text-ui-base text-foreground-subtlest">
                    <Spinner className="size-4 text-foreground-subtlest" />
                    <span>正在获取会话...</span>
                  </div>
                ) : visible.length === 0 ? (
                  <div className="px-8.5 py-2 text-ui-base text-foreground-subtlest">暂无会话</div>
                ) : (
                  <ul className="space-y-0.5">
                    {visible.map((session) => (
                      <SessionItem key={session.id} session={session} />
                    ))}
                  </ul>
                )}
              </div>
              {filtered.length > visible.length ? (
                <div className="cursor-pointer pl-8.5">
                  <span
                    className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
                    onClick={() => setLimit((value) => value + PAGE_SIZE * 2)}
                  >
                    显示更多
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
