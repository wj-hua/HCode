// 会话头部：参照 ZCode WorkspaceHeader（项目名 / 会话标题 + 右侧操作）。
import { FolderIcon, GitBranchIcon, PanelLeftIcon, SquareTerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { hcode } from "../bridge";
import { shortenHome } from "../format";
import { useAppStore, type Conversation } from "../store/appStore";

export function Header({ conversation }: { conversation: Conversation | undefined }) {
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const fullscreen = useAppStore((state) => state.fullscreen);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const summary = useAppStore((state) =>
    conversation?.sessionId
      ? state.sessions[conversation.projectPath]?.find((item) => item.id === conversation.sessionId)
      : undefined,
  );
  const projectName = conversation?.projectPath.split("/").filter(Boolean).at(-1);
  const title = summary?.title ?? conversation?.title ?? (conversation ? "新会话" : "");

  return (
    <header
      className={cn(
        "app-drag flex h-11 shrink-0 items-center gap-2 border-b border-border/60 pr-2",
        collapsed && !fullscreen ? "pl-[84px]" : "pl-3",
      )}
    >
      {collapsed ? (
        <ControlHintTooltip title="展开侧边栏" shortcut="⌘B" side="bottom">
          <Button
            variant="ghost"
            size="icon-md"
            className="app-no-drag text-foreground-subtle"
            onClick={() => setSidebarCollapsed(false)}
          >
            <PanelLeftIcon />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {conversation ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base">
          <span className="shrink-0 text-foreground-subtle" title={shortenHome(conversation.projectPath)}>
            {projectName}
          </span>
          <span className="shrink-0 text-foreground-subtlest">/</span>
          <span className="min-w-0 truncate text-foreground">{title}</span>
          {summary?.gitBranch && summary.gitBranch !== "HEAD" ? (
            <span className="ml-1 flex shrink-0 items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
              <GitBranchIcon className="size-3" />
              {summary.gitBranch}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {conversation ? (
        <div className="app-no-drag flex shrink-0 items-center gap-0.5">
          <ControlHintTooltip title="在 Finder 中显示" side="bottom">
            <Button
              variant="ghost"
              size="icon-md"
              className="text-foreground-subtle"
              onClick={() => void hcode.invoke("app:showInFinder", conversation.projectPath)}
            >
              <FolderIcon />
            </Button>
          </ControlHintTooltip>
          <ControlHintTooltip
            title={conversation.sessionId ? "在终端中继续此会话" : "在终端中打开项目"}
            side="bottom"
          >
            <Button
              variant="ghost"
              size="icon-md"
              className="text-foreground-subtle"
              onClick={() =>
                void hcode.invoke("app:openInTerminal", conversation.projectPath, conversation.sessionId)
              }
            >
              <SquareTerminalIcon />
            </Button>
          </ControlHintTooltip>
        </div>
      ) : null}
    </header>
  );
}
