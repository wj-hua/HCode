// 单个可拖拽会话标签：Android Studio 风格高亮条、固定图标、状态指示、中键关闭与完整右键批量关闭菜单。
import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LoaderIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import type { AgentKind } from "@hcode/shared/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { cn } from "@/components/lib/utils.js";
import { AgentBadge } from "../AgentBadge";

export type TabStatusKind = "approval" | "running" | "error" | "done" | null;

export interface ConversationTabItemProps {
  tabKey: string;
  title: string;
  projectSuffix?: string;
  tooltip: string;
  agents: readonly AgentKind[];
  pinned: boolean;
  active: boolean;
  status: TabStatusKind;
  canCloseOthers: boolean;
  canCloseLeft: boolean;
  canCloseRight: boolean;
  canCloseAll: boolean;
  onActivate: (tabKey: string) => void;
  onClose: (tabKey: string, allowPinned: boolean) => void;
  onCloseOthers: (tabKey: string) => void;
  onCloseLeft: (tabKey: string) => void;
  onCloseRight: (tabKey: string) => void;
  onCloseAll: () => void;
  onTogglePin: (tabKey: string) => void;
}

export const ConversationTabItem = memo(function ConversationTabItem({
  tabKey,
  title,
  projectSuffix,
  tooltip,
  agents,
  pinned,
  active,
  status,
  canCloseOthers,
  canCloseLeft,
  canCloseRight,
  canCloseAll,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseLeft,
  onCloseRight,
  onCloseAll,
  onTogglePin,
}: ConversationTabItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tabKey });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={style}
          {...attributes}
          {...listeners}
          role="tab"
          aria-selected={active}
          data-tab-key={tabKey}
          title={tooltip}
          onClick={() => onActivate(tabKey)}
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault();
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              event.stopPropagation();
              if (!pinned) onClose(tabKey, false);
            }
          }}
          className={cn(
            "group/tab relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border/40 px-2.5 text-ui-sm outline-none transition-colors select-none",
            pinned ? "min-w-[84px] max-w-[160px]" : "min-w-[100px] max-w-[200px]",
            active
              ? "bg-surface/65 font-medium text-foreground"
              : "text-foreground-subtle hover:bg-surface-hover/70 hover:text-foreground",
            isDragging && "z-20 bg-background opacity-85 shadow-sm",
          )}
        >
          {/* 左侧图标区：图钉（固定态）+ CLI 徽标 */}
          <span className="flex shrink-0 items-center gap-1">
            {pinned ? <PinIcon aria-hidden="true" className="size-3 text-foreground-subtlest" /> : null}
            <span className="flex items-center -space-x-1">
              {agents.map((agent, index) => (
                <AgentBadge key={`${agent}-${index}`} agent={agent} className="size-3.5" />
              ))}
            </span>
          </span>

          {/* 标题 + 重名项目短后缀 */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1">
            <span className="min-w-0 truncate">{title}</span>
            {projectSuffix ? (
              <span className="max-w-[72px] shrink-0 truncate text-ui-xs font-normal text-foreground-subtlest">
                · {projectSuffix}
              </span>
            ) : null}
          </span>

          {/* 状态指示位（按优先级展示单个） */}
          {status === "approval" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-warning" title="等待审批" />
          ) : status === "running" ? (
            <LoaderIcon className="size-3 shrink-0 animate-spin text-foreground-subtle" />
          ) : status === "error" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" title="运行出错，未查看" />
          ) : status === "done" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary" title="已完成，未查看" />
          ) : null}

          {/* 普通标签关闭按钮；固定标签不显示以防误关 */}
          {!pinned ? (
            <button
              type="button"
              aria-label={`关闭标签 ${title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tabKey, false);
              }}
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-sm text-foreground-subtle transition-opacity hover:bg-surface-hover hover:text-foreground",
                active
                  ? "opacity-70 hover:opacity-100"
                  : "opacity-0 group-hover/tab:opacity-70 focus-visible:opacity-100 hover:!opacity-100",
              )}
            >
              <XIcon className="size-3" />
            </button>
          ) : null}

          {/* Android Studio 风格底部 2px 高亮指示条 */}
          {active ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-primary"
            />
          ) : null}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="min-w-44">
        <ContextMenuItem onSelect={() => onClose(tabKey, true)}>
          关闭
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseOthers} onSelect={() => onCloseOthers(tabKey)}>
          关闭其他标签
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseLeft} onSelect={() => onCloseLeft(tabKey)}>
          关闭左侧标签
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseRight} onSelect={() => onCloseRight(tabKey)}>
          关闭右侧标签
        </ContextMenuItem>
        <ContextMenuItem disabled={!canCloseAll} onSelect={onCloseAll}>
          关闭全部标签
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onTogglePin(tabKey)}>
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
          {pinned ? "取消固定标签" : "固定标签"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});
