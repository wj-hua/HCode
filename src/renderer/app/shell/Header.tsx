// 会话头部：参照 ZCode WorkspaceHeader（项目名 / 会话标题 + 右侧操作）。
import { presentationTitle } from "@hcode/shared/collaborationPresentation";
import { usePresentationStore } from "../collaboration/presentationStore";
import { ExternalLinkIcon, FolderIcon, GitBranchIcon, PaletteIcon, PanelLeftIcon, PanelRightIcon, SquareTerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { AGENTS } from "@hcode/shared/agents";
import { AgentBadge } from "../AgentBadge";
import { hcode, isRemote } from "../bridge";
import { shortenHome } from "../format";
import { useAppStore, type Conversation } from "../store/appStore";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { RefreshConversationButton } from "./RefreshButtons";
import { ComputerBatteryIndicator } from "../remote/ComputerBatteryIndicator";

export function Header({ conversation, onToggleTerminal, terminalVisible, onToggleSideTerminal, sideTerminalVisible }: { conversation: Conversation | undefined; onToggleTerminal: () => void; terminalVisible: boolean; onToggleSideTerminal: () => void; sideTerminalVisible: boolean }) {
  const project = useAppStore((state) => state.projects.find((item) => item.path === conversation?.projectPath));
  const outsideProject = project?.purpose === "conversation";
  const isOfficeMode = useIsOfficeMode();
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const fullscreen = useAppStore((state) => state.fullscreen);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const theme = useAppStore((state) => state.settings.theme);
  const updateSettings = useAppStore((state) => state.updateSettings);
  const summary = useAppStore((state) =>
    conversation?.sessionId
      ? state.sessions[conversation.projectPath]?.find((item) => item.id === conversation.sessionId)
      : undefined,
  );
  const projectName = project?.name ?? conversation?.projectPath.split("/").filter(Boolean).at(-1);
  const entries = usePresentationStore(state => state.entries);
  const rawTitle = summary?.title ?? conversation?.title ?? (conversation ? "新会话" : "");
  const title = conversation ? presentationTitle(rawTitle, conversation, entries) : rawTitle;

  return (
    <header
      className={cn(
        "app-drag flex h-11 shrink-0 items-center gap-2 border-b border-border/60 pr-2",
        collapsed && !fullscreen && !isRemote ? "pl-[84px]" : "pl-3",
      )}
    >
      {collapsed ? (
        <ControlHintTooltip title="展开侧边栏" shortcut="⌘B" side="bottom">
          <Button
            variant="ghost"
            size="icon-md"
            className="app-no-drag text-foreground-subtle"
            aria-label="展开侧边栏"
            onClick={() => setSidebarCollapsed(false)}
          >
            <PanelLeftIcon />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {conversation ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base">
          <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-surface px-1.5 py-0.5 text-ui-sm text-foreground-subtle">
            <AgentBadge agent={conversation.agent} />
            {AGENTS[conversation.agent].name}
          </span>
          <span className="min-w-0 max-w-[40%] truncate text-foreground-subtle" title={shortenHome(conversation.projectPath)}>
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
      {conversation && !isRemote ? (
        <div className="app-no-drag flex shrink-0 items-center gap-0.5">
          {!isOfficeMode ? <ControlHintTooltip title={terminalVisible ? "收起内置终端" : "打开内置终端"} side="bottom"><Button variant="ghost" size="icon-md" className="text-foreground-subtle" aria-label={terminalVisible ? "收起内置终端" : "打开内置终端"} aria-pressed={terminalVisible} onClick={onToggleTerminal}><SquareTerminalIcon /></Button></ControlHintTooltip> : null}
          {!isOfficeMode ? <ControlHintTooltip title={sideTerminalVisible ? "收起侧边终端" : "打开侧边终端"} side="bottom"><Button variant="ghost" size="icon-md" className="text-foreground-subtle" aria-label={sideTerminalVisible ? "收起侧边终端面板" : "打开侧边终端"} aria-pressed={sideTerminalVisible} onClick={onToggleSideTerminal}><PanelRightIcon /></Button></ControlHintTooltip> : null}
          <ControlHintTooltip title="在 Finder 中显示" side="bottom">
            <Button
              variant="ghost"
              size="icon-md"
              className="text-foreground-subtle"
              aria-label="在 Finder 中显示项目"
              onClick={() => void hcode.invoke("app:showInFinder", conversation.projectPath)}
            >
              <FolderIcon />
            </Button>
          </ControlHintTooltip>
          {!isOfficeMode ? (
            <ControlHintTooltip
              title={conversation.sessionId ? "在终端中继续此会话" : outsideProject ? "在终端中打开对话目录" : "在终端中打开项目"}
              side="bottom"
            >
              <Button
                variant="ghost"
                size="icon-md"
                className="text-foreground-subtle"
                aria-label={conversation.sessionId ? "在终端中继续此会话" : "在终端中打开项目目录"}
                onClick={() =>
                  void hcode.invoke(
                    "app:openInTerminal",
                    conversation.projectPath,
                    conversation.sessionId ? { agent: conversation.agent, id: conversation.sessionId } : undefined,
                  )
                }
              >
                <ExternalLinkIcon />
              </Button>
            </ControlHintTooltip>
          ) : null}
        </div>
      ) : null}
      {conversation ? <RefreshConversationButton conversation={conversation} /> : null}
      {isRemote ? <ComputerBatteryIndicator /> : null}
      {isRemote ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-md" className="app-no-drag shrink-0 text-foreground-subtle" aria-label="主题">
              <PaletteIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuRadioGroup value={theme} onValueChange={(value) => {
              if (value === "system" || value === "dark" || value === "light") void updateSettings({ theme: value });
            }}>
              <DropdownMenuRadioItem value="system">跟随系统</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">深色主题</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">浅色主题</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </header>
  );
}
