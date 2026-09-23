// 应用外壳：结构与样式参照 ZCode WorkspaceShellLayout（侧栏 + 带 4px 留白的圆角主面板）。
import { useEffect } from "react";
import { cn } from "@/components/lib/utils.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { ConversationView } from "../conversation/ConversationView";
import { SettingsDialog } from "../settings/SettingsDialog";
import { useActiveConversation, useAppStore } from "../store/appStore";
import { EmptyState } from "./EmptyState";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

const SIDEBAR_WIDTH = 272;

export function AppShell() {
  const collapsed = useAppStore((state) => state.sidebarCollapsed);
  const conversation = useActiveConversation();
  useGlobalShortcuts();

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
            <Sidebar />
          </aside>
        </div>
        <div className={cn("flex min-w-[320px] flex-1 flex-col p-1 pt-0", !collapsed && "pl-0")}>
          <div className="app-drag h-1 w-full" />
          <section className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background">
            <Header conversation={conversation} />
            {conversation ? (
              <ConversationView key={conversation.viewId} conversation={conversation} />
            ) : (
              <EmptyState />
            )}
          </section>
        </div>
      </div>
      <SettingsDialog />
    </DesktopWindowFrame>
  );
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const state = useAppStore.getState();
      if (event.key === ",") {
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
  }, []);
}
