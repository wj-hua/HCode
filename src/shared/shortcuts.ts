// 菜单栏与页面键盘监听共用的应用快捷键。
export type AppCommand =
  | "settings" | "newChat" | "openProject" | "closeView"
  | "toggleSidebar" | "quickSwitch" | "search" | "focusComposer"
  | "copyLastReply" | "switchView";

export interface ShortcutDefinition {
  command: AppCommand;
  label: string;
  accelerator: string;
  key: string;
  shift?: boolean;
  index?: number;
}

export const APP_SHORTCUTS: readonly ShortcutDefinition[] = [
  { command: "settings", label: "设置…", accelerator: "Command+,", key: "," },
  { command: "newChat", label: "新建会话", accelerator: "Command+N", key: "n" },
  { command: "closeView", label: "关闭当前会话", accelerator: "Command+W", key: "w" },
  { command: "toggleSidebar", label: "切换侧边栏", accelerator: "Command+B", key: "b" },
  { command: "quickSwitch", label: "快速切换…", accelerator: "Command+K", key: "k" },
  { command: "search", label: "搜索会话全文…", accelerator: "Command+F", key: "f" },
  { command: "focusComposer", label: "聚焦输入框", accelerator: "Command+L", key: "l" },
  { command: "copyLastReply", label: "复制最后一条回复", accelerator: "Command+Shift+C", key: "c", shift: true },
  ...Array.from({ length: 9 }, (_, offset) => ({
    command: "switchView" as const,
    label: `切换到会话 ${offset + 1}`,
    accelerator: `Command+${offset + 1}`,
    key: String(offset + 1),
    index: offset,
  })),
];
