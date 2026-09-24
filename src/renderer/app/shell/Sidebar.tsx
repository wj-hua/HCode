// 侧边栏：项目列表 + 会话历史。行样式照 ZCode WorkspaceSidebarItem / TaskListItem。
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { restrictVerticalDragWithinContainer } from "@/lib/restrictVerticalDragWithinContainer.js";
import { workspaceVerticalListSortingStrategy } from "@/lib/workspaceSidebarDrag.js";
import { useAppStore } from "../store/appStore";
import { SortableProjectItem } from "./ProjectItem";
import { QuotaIndicator } from "./QuotaIndicator";

const SECTION_CHEVRON_CLASS =
  "size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100";

/** 拖动时跟随鼠标的项目头，照 ZCode WorkspaceDragOverlay。 */
function ProjectDragOverlay({ name, width }: { name: string; width: number | null }) {
  return (
    <div
      className="pointer-events-none flex h-8 cursor-grabbing items-center gap-2 rounded-lg border border-border bg-background px-2.5 text-ui-base text-foreground shadow-lg"
      style={width ? { width } : undefined}
    >
      <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1 truncate px-1">{name}</span>
    </div>
  );
}

export function Sidebar() {
  const [sectionOpen, setSectionOpen] = useState(true);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  // 移动 8px 才开始拖动，普通点击仍是展开/收起
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const reorderProjects = useAppStore((state) => state.reorderProjects);
  const projects = useAppStore((state) => state.projects);
  const search = useAppStore((state) => state.search);
  const setSearch = useAppStore((state) => state.setSearch);
  const addProject = useAppStore((state) => state.addProject);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const fullscreen = useAppStore((state) => state.fullscreen);
  const sessions = useAppStore((state) => state.sessions);
  const activeProjectPath = useAppStore((state) =>
    state.activeViewId ? state.conversations[state.activeViewId]?.projectPath : undefined,
  );
  const newChat = useAppStore((state) => state.newChat);

  const query = search.trim().toLowerCase();
  const dragProject = dragPath ? projects.find((project) => project.path === dragPath) : undefined;
  const resetDrag = () => {
    setDragPath(null);
    setDragWidth(null);
  };
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

      {/* 项目分区：照 ZCode WorkspacePurposeSection，标题可折叠，操作按钮悬停时出现。 */}
      <ScrollFadeViewport style={{ overflowAnchor: "none" }}>
        <div className="flex min-h-0 flex-col gap-3 px-2">
          <section aria-label="项目" className="group/purpose-section relative">
            <Collapsible open={sectionOpen} onOpenChange={setSectionOpen}>
              <div className="flex h-7 min-w-0 items-center">
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 min-w-0 flex-1 items-center gap-1 px-2.5 text-left text-ui-base font-medium text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                  >
                    <span className="min-w-0 truncate">项目</span>
                    {sectionOpen ? (
                      <ChevronDownIcon aria-hidden="true" className={SECTION_CHEVRON_CLASS} />
                    ) : (
                      <ChevronRightIcon aria-hidden="true" className={SECTION_CHEVRON_CLASS} />
                    )}
                  </button>
                </CollapsibleTrigger>
                <div className="flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100">
                  <ControlHintTooltip title="添加项目">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-foreground-subtle hover:text-foreground"
                      aria-label="添加项目"
                      onClick={() => void addProject()}
                    >
                      <PlusIcon className="size-3.5" />
                    </Button>
                  </ControlHintTooltip>
                </div>
              </div>
              <CollapsibleContent>
                {visibleProjects.length === 0 ? (
                  <div className="px-3 py-2 text-ui-base text-foreground-subtle">
                    {query ? "没有匹配的项目或会话" : "尚未添加项目"}
                  </div>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    modifiers={[restrictVerticalDragWithinContainer]}
                    onDragStart={(event: DragStartEvent) => {
                      setDragPath(String(event.active.id));
                      setDragWidth(event.active.rect.current.initial?.width ?? null);
                    }}
                    onDragCancel={resetDrag}
                    onDragEnd={(event: DragEndEvent) => {
                      resetDrag();
                      const { active, over } = event;
                      if (over && active.id !== over.id) void reorderProjects(String(active.id), String(over.id));
                    }}
                  >
                    <SortableContext
                      items={visibleProjects.map((project) => project.path)}
                      strategy={workspaceVerticalListSortingStrategy}
                    >
                      <ul className="space-y-2 pb-4">
                        {visibleProjects.map((project) => (
                          <SortableProjectItem
                            key={project.path}
                            project={project}
                            query={query}
                            dragActive={dragPath === project.path}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                    {createPortal(
                      <DragOverlay>
                        {dragProject ? <ProjectDragOverlay name={dragProject.name} width={dragWidth} /> : null}
                      </DragOverlay>,
                      document.body,
                    )}
                  </DndContext>
                )}
              </CollapsibleContent>
            </Collapsible>
          </section>
        </div>
      </ScrollFadeViewport>

      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-t border-border/60 pr-3 pl-2">
        <QuotaIndicator />
        <div className="flex-1" />
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
