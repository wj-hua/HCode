// 应用外壳：结构与样式参照 ZCode WorkspaceShellLayout（侧栏 + 带 4px 留白的圆角主面板）。
import { usePanelWidthPreference } from "../conversation/PanelResizeHandle";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/components/lib/utils.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { CompareView } from "../conversation/CompareView";
import { ConversationView } from "../conversation/ConversationView";
import { hcode, isRemote, remoteBridge } from "../bridge";
import { FilePreviewProvider } from "../conversation/FilePreviewContext";
import { FilePreviewPanel } from "../conversation/FilePreviewPanel";
import { FilePreviewLayout } from "../conversation/FilePreviewLayout";
import { useUiStore } from "../store/uiStore";
import { useActiveConversation, useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { RemoteProjectDialog } from "./RemoteProjectDialog";
import { Header } from "./Header";
import { TerminalResizeHandle } from "../terminal/TerminalResizeHandle";
import { AppBackground } from "./AppBackground";
import { Sidebar } from "./Sidebar";
import { useNarrowRemote } from "../remote/useNarrowRemote";
import { useSidebarSwipe } from "../remote/useSidebarSwipe";
import { SessionSearchDialog } from "./SessionSearchDialog";
import { QuickSwitchDialog } from "./QuickSwitchDialog";
import type { SessionSearchResult } from "@hcode/shared/types";
import { APP_SHORTCUTS, shortcutFromEvent, type AppCommand } from "@hcode/shared/shortcuts";

const SIDEBAR_WIDTH = 272;
const SettingsDialog = lazy(() => import("../settings/SettingsDialog").then(module => ({ default: module.SettingsDialog })));
const TerminalPanel = lazy(() => import("./TerminalPanel").then(module => ({ default: module.TerminalPanel })));
const SideTerminalPanel = lazy(() => import("../terminal/SideTerminalPanel").then(module => ({ default: module.SideTerminalPanel })));

export function AppShell() {
  const panelWidth = usePanelWidthPreference();
  const settingsOpen = useAppStore(state => state.settingsOpen);
  const hasBackground = useAppStore((state) => !!state.settings.background.path);
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const conversation = useActiveConversation();
  const narrow = useNarrowRemote();
  useSidebarSwipe(narrow);
  // 窄屏侧边栏覆盖在内容上：进入页面和切换会话后收起。
  useEffect(() => {
    if (narrow) useAppStore.getState().setSidebarCollapsed(true);
  }, [narrow, conversation?.viewId]);
  const compareMembers = useAppStore(
    useShallow((state) => {
      const id = conversation?.compareId;
      return id ? Object.values(state.conversations).filter((conv) => conv.compareId === id) : [];
    }),
  );
  useEffect(() => {
    remoteBridge?.setViewedSessions((compareMembers.length ? compareMembers : conversation ? [conversation] : []).flatMap(member => member.sessionKey ? [member.sessionKey] : []));
  }, [conversation?.sessionKey, conversation?.compareId, compareMembers]);
  const sidePanel = useUiStore((state) => state.sidePanel);
  const setSidePanel = useUiStore((state) => state.setSidePanel);
  const panelOwnerExists = useAppStore((state) => !sidePanel || !!state.conversations[sidePanel.viewId]);
  const filePreview = sidePanel?.type === "file" && (sidePanel.viewId === conversation?.viewId || compareMembers.some((member) => member.viewId === sidePanel.viewId)) ? sidePanel : null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalProjects, setTerminalProjects] = useState<string[]>([]);
  const [sideTerminalProjects, setSideTerminalProjects] = useState<string[]>([]);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(256);
  const openWorkspacePaths = useAppStore(useShallow(state => [...new Set(Object.values(state.conversations).map(item => item.projectPath))]));
  useEffect(() => {
    setTerminalProjects(current => current.filter(path => openWorkspacePaths.includes(path)));
    setSideTerminalProjects(current => current.filter(path => openWorkspacePaths.includes(path)));
  }, [openWorkspacePaths]);
  useEffect(() => {
    if (!terminalVisible || !conversation) return;
    setTerminalProjects(projects => projects.includes(conversation.projectPath) ? projects : [...projects, conversation.projectPath]);
  }, [terminalVisible, conversation?.projectPath]);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<{ id: string; rowId: number | null; key: number } | null>(null);
  useEffect(() => {
    if (!panelOwnerExists) setSidePanel(null);
  }, [panelOwnerExists, setSidePanel]);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const openQuickSwitch = useCallback(() => setQuickSwitchOpen(true), []);
  const toggleTerminal = useCallback(() => {
    if (isRemote || !useAppStore.getState().activeViewId) return;
    setTerminalVisible(value => !value);
  }, []);
  const terminalEmpty = useCallback((path: string) => {
    setTerminalProjects(current => current.filter(item => item !== path));
    const state = useAppStore.getState();
    if (state.activeViewId && state.conversations[state.activeViewId]?.projectPath === path) setTerminalVisible(false);
  }, []);
  const sideTerminalVisible = sidePanel?.type === "terminal" && sidePanel.workspacePath === conversation?.projectPath;
  const toggleSideTerminal = () => {
    if (!conversation) return;
    if (sideTerminalVisible) { setSidePanel(null); return; }
    setSideTerminalProjects(current => current.includes(conversation.projectPath) ? current : [...current, conversation.projectPath]);
    setSidePanel({ type: "terminal", viewId: conversation.viewId, workspacePath: conversation.projectPath });
  };
  const sideTerminalEmpty = useCallback((path: string) => {
    setSideTerminalProjects(current => current.filter(item => item !== path));
    const panel = useUiStore.getState().sidePanel;
    if (panel?.type === "terminal" && panel.workspacePath === path) useUiStore.getState().setSidePanel(null);
  }, []);
  useGlobalShortcuts(openSearch, openQuickSwitch, toggleTerminal);
  // 切到有未读标记的会话、或窗口重新聚焦时清除未读
  const activeViewId = conversation?.viewId;
  const activeUnread = conversation?.unread;
  useEffect(() => {
    const markViewed = () => {
      if (document.hasFocus()) useAppStore.getState().markViewed();
    };
    markViewed();
    window.addEventListener("focus", markViewed);
    return () => window.removeEventListener("focus", markViewed);
  }, [activeViewId, activeUnread]);

  return (
    <DesktopWindowFrame title="HCode" isDesktop={!isRemote} isMacDesktop={!isRemote}>
      <div className="relative isolate flex h-full min-h-0 w-full overflow-hidden">
        <AppBackground />
        {narrow && !collapsed ? <div className="absolute inset-0 z-30 bg-black/40" aria-hidden onClick={() => useAppStore.getState().setSidebarCollapsed(true)} /> : null}
        <div
          className={cn(
            "overflow-hidden transition-[width,opacity] duration-200 ease-out",
            narrow ? "absolute inset-y-0 left-0 z-40 bg-background-win-alt shadow-xl" : "flex-none",
            collapsed ? "pointer-events-none opacity-0" : "opacity-100",
          )}
          style={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
        >
          <aside className="h-full overflow-hidden select-none" style={{ width: SIDEBAR_WIDTH }}>
            <Sidebar onOpenSearch={openSearch} />
          </aside>
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col", narrow ? "min-w-0" : "min-w-[320px] p-1 pt-0", !collapsed && !narrow && "pl-0")}>
          {!narrow ? <div className="app-drag h-1 w-full" /> : null}
          <section style={{ "--collaboration-preferred-width": `${panelWidth}px` } as React.CSSProperties} id="conversation-panels" className={cn("collaboration-shell relative flex h-full min-h-0 flex-1 flex-col overflow-hidden", !narrow && "rounded-xl border border-border", !hasBackground && "bg-background")}>
            <Header conversation={conversation} terminalVisible={terminalVisible} onToggleTerminal={toggleTerminal} sideTerminalVisible={sideTerminalVisible} onToggleSideTerminal={toggleSideTerminal} />
            {conversation ? (
              <>
                <FilePreviewLayout mobileOverlay={narrow} preview={<>
                  {filePreview ? <FilePreviewProvider viewId={filePreview.viewId} workspacePath={filePreview.source.workspacePath ?? conversation.projectPath}>
                    <FilePreviewPanel key={`${filePreview.viewId}:${filePreview.source.type}:${filePreview.source.path ?? filePreview.source.title}`} source={filePreview.source} onClose={() => setSidePanel(null)} />
                  </FilePreviewProvider> : null}
                  <Suspense fallback={<span role="status">正在加载终端…</span>}>{sideTerminalProjects.map(path => <SideTerminalPanel key={path} cwd={path} visible={!!sideTerminalVisible && path === conversation.projectPath} onHide={() => setSidePanel(null)} onEmpty={sideTerminalEmpty} />)}</Suspense>
                </>}>
                  {compareMembers.length > 1 ? (
                    <CompareView members={compareMembers} active={conversation} />
                  ) : (
                    <ConversationView key={conversation.viewId} conversation={conversation} searchTarget={searchTarget?.id === conversation.sessionId ? searchTarget : null} />
                  )}
                </FilePreviewLayout>
              </>
            ) : (
              <EmptyState />
            )}
            {terminalVisible && conversation ? <TerminalResizeHandle height={terminalHeight} setHeight={setTerminalHeight} /> : null}
            <Suspense fallback={<span role="status">正在加载终端…</span>}>{terminalProjects.map(path => <TerminalPanel key={path} cwd={path} height={terminalHeight} visible={terminalVisible && conversation?.projectPath === path} onHide={() => setTerminalVisible(false)} onEmpty={terminalEmpty} />)}</Suspense>
          </section>
        </div>
      </div>
      {settingsOpen ? <Suspense fallback={<span role="status" className="fixed right-4 bottom-4">正在加载设置…</span>}><SettingsDialog /></Suspense> : null}
      {isRemote ? <RemoteProjectDialog /> : null}
      <QuickSwitchDialog open={quickSwitchOpen} onOpenChange={setQuickSwitchOpen} />
      <SessionSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={(result: SessionSearchResult) => {
          setSearchTarget((previous) => ({ id: result.session.id, rowId: result.rowId, key: (previous?.key ?? 0) + 1 }));
          void useAppStore.getState().openSession(result.session, true);
        }}
      />
    </DesktopWindowFrame>
  );
}

function useGlobalShortcuts(openSearch: () => void, openQuickSwitch: () => void, toggleTerminal: () => void) {
  useEffect(() => {
    const runCommand = (command: AppCommand, index?: number): boolean => {
      const state = useAppStore.getState();
      switch (command) {
        case "settings":
          if (isRemote) return false;
          state.setSettingsOpen(true);
          return true;
        case "newChat": {
          const active = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
          const projectPath = active?.projectPath ?? state.projects.find((project) => project.purpose !== "conversation")?.path;
          if (projectPath) state.newChat(projectPath);
          else void state.workOutsideProject(true);
          return true;
        }
        case "openProject":
          if (isRemote) return false;
          void state.addProject();
          return true;
        case "closeView":
          if (!state.activeViewId) return false;
          void state.closeActiveView();
          return true;
        case "toggleSidebar":
          state.setSidebarCollapsed(!state.sidebarCollapsed);
          return true;
        case "toggleTerminal":
          toggleTerminal();
          return true;
        case "quickSwitch":
          openQuickSwitch();
          return true;
        case "search":
          openSearch();
          return true;
        case "switchView": {
          const viewId = Object.keys(state.conversations)[index ?? -1];
          if (!viewId) return false;
          state.activateView(viewId);
          return true;
        }
        case "focusComposer": {
          const input = document.querySelector<HTMLTextAreaElement>("[data-composer-input]");
          if (!input) return false;
          input.focus();
          return true;
        }
        case "copyLastReply": {
          const active = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
          const rows = active?.rows ?? [];
          const lastAssistant = rows.findLast((row) => row.kind === "assistantText" && row.text.trim());
          if (lastAssistant?.kind !== "assistantText") return false;
          const text = rows.filter((row) => row.kind === "assistantText" && row.turnId === lastAssistant.turnId && row.text.trim())
            .map((row) => row.kind === "assistantText" ? row.text.trim() : "")
            .join("\n\n");
          void hcode.invoke("app:copyText", text);
          return true;
        }
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // macOS 快捷键由原生菜单分发，避免菜单和页面各执行一次。
      if (hcode.platform === "darwin") return;
      if (event.isComposing) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const pressed = shortcutFromEvent(event);
      const shortcut = pressed && APP_SHORTCUTS.find((entry) => (useAppStore.getState().settings.shortcuts[entry.index === undefined ? entry.command : `${entry.command}:${entry.index}`] ?? entry.accelerator.replace("Command+", "Control+")) === pressed);
      if (shortcut && runCommand(shortcut.command, shortcut.index)) event.preventDefault();
    };
    const offMenuCommand = hcode.on("app:menuCommand", ({ command, index, fromAccelerator }) => {
      if (fromAccelerator && document.activeElement instanceof Element && document.activeElement.closest('[role="dialog"]')) return;
      runCommand(command, index);
    });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      offMenuCommand();
    };
  }, [openSearch, openQuickSwitch, toggleTerminal]);
}
