// Mac 端会话标签栏：Android Studio 风格，支持固定分区、横向拖拽、滚轮横向滚动、新建按钮与全部标签下拉菜单。
import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import { CheckIcon, ChevronDownIcon, LoaderIcon, PinIcon, PlusIcon } from "lucide-react";
import { presentationTitle } from "@hcode/shared/collaborationPresentation";
import { AGENTS } from "@hcode/shared/agents";
import type { AgentKind } from "@hcode/shared/types";
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
import { AgentBadge } from "../AgentBadge";
import { usePresentationStore } from "../collaboration/presentationStore";
import { useAppStore, type Conversation } from "../store/appStore";
import { deriveOrderedTabs, tabKeyOf } from "../store/tabModel";
import { ConversationTabItem, type TabStatusKind } from "./ConversationTabItem";

const restrictToHorizontalAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

interface TabItemView {
  key: string;
  pinned: boolean;
  agents: AgentKind[];
  title: string;
  projectName: string;
  projectSuffix?: string;
  tooltip: string;
  status: TabStatusKind;
}

function firstUserLine(conv: Conversation): string | undefined {
  const first = conv.rows.find((row) => row.kind === "userInput");
  if (first?.kind !== "userInput") return undefined;
  return first.text.split("\n").map((item) => item.trim()).find(Boolean);
}

function resolveStatus(conversations: readonly Conversation[]): TabStatusKind {
  if (conversations.some((conv) => conv.runState === "awaitingApproval")) return "approval";
  if (conversations.some((conv) => conv.runState === "running" || Boolean(conv.backgroundTasks))) return "running";
  if (conversations.some((conv) => conv.unread === "error")) return "error";
  if (conversations.some((conv) => conv.unread === "done")) return "done";
  return null;
}

export function openNewTabFromCurrentContext(): void {
  const state = useAppStore.getState();
  const active = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
  const projectPath = active?.projectPath || state.projects.find((project) => project.purpose !== "conversation")?.path;
  if (!projectPath) {
    void state.workOutsideProject(true);
    return;
  }
  const activeIsBlankSameProject = Boolean(
    active
    && active.projectPath === projectPath
    && !active.sessionId
    && !active.sessionKey
    && !active.compareId,
  );
  state.newChat(projectPath, undefined, { forceNew: activeIsBlankSameProject });
}

export function ConversationTabBar() {
  const conversations = useAppStore((state) => state.conversations);
  const tabOrder = useAppStore((state) => state.tabOrder);
  const pinnedTabKeys = useAppStore((state) => state.pinnedTabKeys);
  const lastCompareViewIds = useAppStore((state) => state.lastCompareViewIds);
  const activeViewId = useAppStore((state) => state.activeViewId);
  const projects = useAppStore((state) => state.projects);
  const sessions = useAppStore((state) => state.sessions);
  const presentationEntries = usePresentationStore((state) => state.entries);

  const activateTab = useAppStore((state) => state.activateTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const closeOtherTabs = useAppStore((state) => state.closeOtherTabs);
  const closeAllTabs = useAppStore((state) => state.closeAllTabs);
  const closeTabsToLeft = useAppStore((state) => state.closeTabsToLeft);
  const closeTabsToRight = useAppStore((state) => state.closeTabsToRight);
  const toggleTabPinned = useAppStore((state) => state.toggleTabPinned);
  const reorderTabs = useAppStore((state) => state.reorderTabs);

  const scrollRef = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const activeTabKey = useMemo(() => {
    const active = activeViewId ? conversations[activeViewId] : undefined;
    return active ? tabKeyOf(active) : null;
  }, [activeViewId, conversations]);

  const tabViews = useMemo<TabItemView[]>(() => {
    const descriptors = deriveOrderedTabs(conversations, tabOrder, pinnedTabKeys, lastCompareViewIds);
    const projectMap = new Map(projects.map((project) => [project.path, project.name]));

    const rawItems = descriptors.map((tab) => {
      const primary = tab.conversations.find((conv) => conv.viewId === tab.primaryViewId) ?? tab.conversations[0]!;
      const summary = primary.sessionId
        ? sessions[primary.projectPath]?.find((item) => item.id === primary.sessionId && item.agent === primary.agent)
        : undefined;
      const baseTitle = summary?.title ?? primary.title ?? firstUserLine(primary) ?? "新会话";
      const title = presentationTitle(baseTitle, primary, presentationEntries, !summary?.title && primary.title === undefined);
      const projectName = projectMap.get(primary.projectPath)
        ?? primary.projectPath.split("/").filter(Boolean).at(-1)
        ?? "未选择项目";
      const agents = tab.conversations.map((conv) => conv.agent);
      const agentNames = [...new Set(agents)].map((agent) => AGENTS[agent].name).join(" / ");
      const branch = summary?.gitBranch && summary.gitBranch !== "HEAD" ? ` · ${summary.gitBranch}` : "";
      const tooltip = `${title}\n${projectName} · ${agentNames}${branch}`;
      return {
        key: tab.key,
        pinned: tab.pinned,
        agents,
        title,
        projectName,
        projectPath: primary.projectPath,
        tooltip,
        status: resolveStatus(tab.conversations),
      };
    });

    // 同名标题分属不同项目时，追加灰色短项目名消歧
    const titleProjects = new Map<string, Set<string>>();
    for (const item of rawItems) {
      const set = titleProjects.get(item.title) ?? new Set<string>();
      set.add(item.projectPath);
      titleProjects.set(item.title, set);
    }

    return rawItems.map((item) => ({
      key: item.key,
      pinned: item.pinned,
      agents: item.agents,
      title: item.title,
      projectName: item.projectName,
      projectSuffix: (titleProjects.get(item.title)?.size ?? 0) > 1 ? item.projectName : undefined,
      tooltip: item.tooltip,
      status: item.status,
    }));
  }, [conversations, tabOrder, pinnedTabKeys, lastCompareViewIds, projects, sessions, presentationEntries]);

  const pinnedCount = useMemo(
    () => tabViews.reduce((count, item) => count + (item.pinned ? 1 : 0), 0),
    [tabViews],
  );
  const regularCount = tabViews.length - pinnedCount;
  const tabKeys = useMemo(() => tabViews.map((item) => item.key), [tabViews]);

  // 鼠标滚轮垂直转横向滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        el.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // 激活标签自动滚入可视区域
  useEffect(() => {
    if (!activeTabKey || !scrollRef.current) return;
    const target = scrollRef.current.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(activeTabKey)}"]`);
    target?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabKey, tabViews.length]);

  const handleClose = useCallback((key: string, allowPinned: boolean) => {
    void closeTab(key, { allowPinned });
  }, [closeTab]);

  const handleCloseOthers = useCallback((key: string) => {
    void closeOtherTabs(key);
  }, [closeOtherTabs]);

  const handleCloseLeft = useCallback((key: string) => {
    void closeTabsToLeft(key);
  }, [closeTabsToLeft]);

  const handleCloseRight = useCallback((key: string) => {
    void closeTabsToRight(key);
  }, [closeTabsToRight]);

  const handleCloseAll = useCallback(() => {
    void closeAllTabs();
  }, [closeAllTabs]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      reorderTabs(String(active.id), String(over.id));
    }
  }, [reorderTabs]);

  return (
    <div
      role="tablist"
      aria-label="已打开的会话标签页"
      className="app-no-drag flex h-9 shrink-0 items-center border-b border-border/60 select-none"
    >
      <div
        ref={scrollRef}
        className="scrollbar-hide flex min-w-0 flex-1 items-center overflow-x-auto"
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToHorizontalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={tabKeys} strategy={horizontalListSortingStrategy}>
            {tabViews.map((item, index) => {
              const canCloseLeft = tabViews.slice(0, index).some((other) => !other.pinned);
              const canCloseRight = tabViews.slice(index + 1).some((other) => !other.pinned);
              const canCloseOthers = canCloseLeft || canCloseRight;
              const canCloseAll = regularCount > 0;
              return (
                <Fragment key={item.key}>
                  {pinnedCount > 0 && regularCount > 0 && index === pinnedCount ? (
                    <div aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border/80" />
                  ) : null}
                  <ConversationTabItem
                    tabKey={item.key}
                    title={item.title}
                    projectSuffix={item.projectSuffix}
                    tooltip={item.tooltip}
                    agents={item.agents}
                    pinned={item.pinned}
                    active={item.key === activeTabKey}
                    status={item.status}
                    canCloseOthers={canCloseOthers}
                    canCloseLeft={canCloseLeft}
                    canCloseRight={canCloseRight}
                    canCloseAll={canCloseAll}
                    onActivate={activateTab}
                    onClose={handleClose}
                    onCloseOthers={handleCloseOthers}
                    onCloseLeft={handleCloseLeft}
                    onCloseRight={handleCloseRight}
                    onCloseAll={handleCloseAll}
                    onTogglePin={toggleTabPinned}
                  />
                </Fragment>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {/* 右侧固定操作区：新建标签 + 全部标签下拉 */}
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border/60 px-1.5">
        <ControlHintTooltip title="新建会话" shortcut="⌘T" side="bottom">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="新建会话标签"
            className="text-foreground-subtle hover:text-foreground"
            onClick={openNewTabFromCurrentContext}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        </ControlHintTooltip>

        {tabViews.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`全部已打开标签（共 ${tabViews.length} 个）`}
                title="全部已打开标签"
                className="h-6 gap-1 px-1.5 text-ui-xs text-foreground-subtle hover:text-foreground"
              >
                <ChevronDownIcon className="size-3.5" />
                <span className="tabular-nums">{tabViews.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-72 overflow-y-auto">
              {tabViews.map((item, index) => (
                <Fragment key={item.key}>
                  {pinnedCount > 0 && regularCount > 0 && index === pinnedCount ? (
                    <DropdownMenuSeparator />
                  ) : null}
                  <DropdownMenuItem
                    onSelect={() => activateTab(item.key)}
                    className="flex items-center gap-2"
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      {item.key === activeTabKey ? <CheckIcon className="size-3.5 text-primary" /> : null}
                    </span>
                    {item.pinned ? <PinIcon className="size-3 shrink-0 text-foreground-subtlest" /> : null}
                    <span className="flex shrink-0 items-center -space-x-1">
                      {item.agents.map((agent, agentIdx) => (
                        <AgentBadge key={`${agent}-${agentIdx}`} agent={agent} className="size-3.5" />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {item.title}
                      {item.projectSuffix ? (
                        <span className="ml-1 text-ui-xs text-foreground-subtlest">· {item.projectSuffix}</span>
                      ) : null}
                    </span>
                    {item.status === "approval" ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-warning" />
                    ) : item.status === "running" ? (
                      <LoaderIcon className="size-3 shrink-0 animate-spin text-foreground-subtle" />
                    ) : item.status === "error" ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
                    ) : item.status === "done" ? (
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                    ) : null}
                  </DropdownMenuItem>
                </Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}
