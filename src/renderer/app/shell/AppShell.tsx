// 应用外壳：结构与样式参照 ZCode WorkspaceShellLayout（侧栏 + 带 4px 留白的圆角主面板）。
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { ConversationView } from "../conversation/ConversationView";
import { TurnDiffPanel } from "../conversation/TurnDiffPanel";
import { SettingsDialog } from "../settings/SettingsDialog";
import { useActiveConversation, useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";
import { SessionSearchDialog } from "./SessionSearchDialog";
import type { SessionSearchResult } from "@hcode/shared/types";

const SIDEBAR_WIDTH = 272;

export function AppShell() {
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const conversation = useActiveConversation();
  const [diffViewId, setDiffViewId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<{ id: string; rowId: number | null; key: number } | null>(null);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useGlobalShortcuts(openSearch);

  return (
    <DesktopWindowFrame title="HCode" isDesktop isMacDesktop>
      <div className="relative flex h-full min-h-0 w-full overflow-hidden">
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
          <section className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            <Header
              conversation={conversation}
              diffOpen={!!conversation && diffViewId === conversation.viewId}
              onToggleDiff={() => setDiffViewId(diffViewId === conversation?.viewId ? null : conversation?.viewId ?? null)}
            />
            {conversation ? (
              <>
                <ConversationView key={conversation.viewId} conversation={conversation} searchTarget={searchTarget?.id === conversation.sessionId ? searchTarget : null} />
                {diffViewId === conversation.viewId ? (
                  <TurnDiffPanel conversation={conversation} onClose={() => setDiffViewId(null)} />
                ) : null}
              </>
            ) : (
              <EmptyState />
            )}
          </section>
        </div>
      </div>
      <SettingsDialog />
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

function useGlobalShortcuts(openSearch: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const state = useAppStore.getState();
      if ((event.key.toLowerCase() === "k" || event.key.toLowerCase() === "f") && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        openSearch();
      } else if (event.key === ",") {
        event.preventDefault();
        state.setSettingsOpen(true);
      } else if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        const active = state.activeViewId ? state.conversations[state.activeViewId] : undefined;
        const projectPath = active?.projectPath ?? state.projects[0]?.path;
        if (projectPath) state.newChat(projectPath);
        else void state.addProject();
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        state.setSidebarCollapsed(!state.sidebarCollapsed);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearch]);
}
