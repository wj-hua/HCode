// 应用外壳：结构与样式参照 ZCode WorkspaceShellLayout（侧栏 + 带 4px 留白的圆角主面板）。
import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/components/lib/utils.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { CompareView } from "../conversation/CompareView";
import { ConversationView } from "../conversation/ConversationView";
import { hcode } from "../bridge";
import { TurnDiffPanel } from "../conversation/TurnDiffPanel";
import { FilePreviewPanel } from "../conversation/FilePreviewPanel";
import { useUiStore } from "../store/uiStore";
import { SettingsDialog } from "../settings/SettingsDialog";
import { useActiveConversation, useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { Header } from "./Header";
import { AppBackground } from "./AppBackground";
import { Sidebar } from "./Sidebar";
import { SessionSearchDialog } from "./SessionSearchDialog";
import { QuickSwitchDialog } from "./QuickSwitchDialog";
import type { SessionSearchResult } from "@hcode/shared/types";
import { APP_SHORTCUTS, type AppCommand } from "@hcode/shared/shortcuts";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

const SIDEBAR_WIDTH = 272;

export function AppShell() {
  const isOfficeMode = useIsOfficeMode();
  const hasBackground = useAppStore((state) => !!state.settings.background.path);
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const conversation = useActiveConversation();
  const compareMembers = useAppStore(
    useShallow((state) => {
      const id = conversation?.compareId;
      return id ? Object.values(state.conversations).filter((conv) => conv.compareId === id) : [];
    }),
  );
  const sidePanel = useUiStore((state) => state.sidePanel);
  const setSidePanel = useUiStore((state) => state.setSidePanel);
  const panelOwnerExists = useAppStore((state) => !sidePanel || !!state.conversations[sidePanel.viewId]);
  const diffOpen = !isOfficeMode && sidePanel?.type === "diff" && sidePanel.viewId === conversation?.viewId;
  const filePreview = sidePanel?.type === "file" && (sidePanel.viewId === conversation?.viewId || compareMembers.some((member) => member.viewId === sidePanel.viewId)) ? sidePanel : null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [quickSwitchOpen, setQuickSwitchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<{ id: string; rowId: number | null; key: number } | null>(null);
  useEffect(() => {
    if (!panelOwnerExists || (isOfficeMode && sidePanel?.type === "diff")) setSidePanel(null);
  }, [isOfficeMode, panelOwnerExists, sidePanel, setSidePanel]);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const openQuickSwitch = useCallback(() => setQuickSwitchOpen(true), []);
  useGlobalShortcuts(openSearch, openQuickSwitch);
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
    <DesktopWindowFrame title="HCode" isDesktop isMacDesktop>
      <div className="relative isolate flex h-full min-h-0 w-full overflow-hidden">
        <AppBackground />
        <div
          className={cn(
            "flex-none overflow-hidden transition-[width,opacity] duration-200 ease-out",
            collapsed ? "pointer-events-none opacity-0" : "opacity-100",
          )}
          style={{ width: collapsed ? 0 : SIDEBAR_WIDTH }}
        >
          <aside className="h-full overflow-hidden select-none" style={{ width: SIDEBAR_WIDTH }}>
            <Sidebar onOpenSearch={openSearch} />
          </aside>
        </div>
        <div className={cn("flex min-w-[320px] flex-1 flex-col p-1 pt-0", !collapsed && "pl-0")}>
          <div className="app-drag h-1 w-full" />
          <section className={cn("relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border", !hasBackground && "bg-background")}>
            <Header
              conversation={conversation}
              diffOpen={diffOpen}
              onToggleDiff={() => setSidePanel(diffOpen || !conversation ? null : { type: "diff", viewId: conversation.viewId })}
            />
            {conversation ? (
              <>
                {compareMembers.length > 1 ? (
                  <CompareView members={compareMembers} active={conversation} />
                ) : (
                  <ConversationView key={conversation.viewId} conversation={conversation} searchTarget={searchTarget?.id === conversation.sessionId ? searchTarget : null} />
                )}
                {diffOpen ? (
                  <TurnDiffPanel key={conversation.viewId} conversation={conversation} onClose={() => setSidePanel(null)} />
                ) : null}
                {filePreview ? (
                  <FilePreviewPanel
                    key={`${filePreview.viewId}:${filePreview.source.type}:${filePreview.source.path ?? filePreview.source.title}`}
                    source={filePreview.source}
                    onClose={() => setSidePanel(null)}
                    onViewFile={() => {
                      const { source, viewId } = filePreview;
                      if (source.path) setSidePanel({ type: "file", viewId, source: { type: "file", title: source.title, path: source.path } });
                    }}
                  />
                ) : null}
              </>
            ) : (
              <EmptyState />
            )}
          </section>
        </div>
      </div>
      <SettingsDialog />
      <QuickSwitchDialog open={quickSwitchOpen} onOpenChange={setQuickSwitchOpen} />
      <SessionSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={(result: SessionSearchResult) => {
          setSearchTarget((previous) => ({ id: result.session.id, rowId: result.rowId, key: (previous?.key ?? 0) + 1 }));
          void useAppStore.getState().openSession(result.session);
        }}
      />
    </DesktopWindowFrame>
  );
}

function useGlobalShortcuts(openSearch: () => void, openQuickSwitch: () => void) {
  useEffect(() => {
    const runCommand = (command: AppCommand, index?: number): boolean => {
      const state = useAppStore.getState();
      switch (command) {
        case "settings":
          state.setSettingsOpen(true);
          return true;
        case "newChat": {
          const active = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
          const projectPath = active?.projectPath ?? state.projects[0]?.path;
          if (projectPath) state.newChat(projectPath);
          else void state.addProject();
          return true;
        }
        case "openProject":
          void state.addProject();
          return true;
        case "closeView":
          if (!state.activeViewId) return false;
          void state.closeActiveView();
          return true;
        case "toggleSidebar":
          state.setSidebarCollapsed(!state.sidebarCollapsed);
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
      if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const shortcut = APP_SHORTCUTS.find((entry) => entry.key === event.key.toLowerCase() && !!entry.shift === event.shiftKey);
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
  }, [openSearch, openQuickSwitch]);
}
