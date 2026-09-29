import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { APP_SHORTCUTS, type AppCommand, type ShortcutDefinition } from "../shared/shortcuts.js";

export function installApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const send = (command: AppCommand, index?: number, fromAccelerator?: boolean) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.webContents.send("app:menuCommand", { command, index, fromAccelerator });
  };
  const item = (shortcut: ShortcutDefinition): MenuItemConstructorOptions => ({
    label: shortcut.label,
    accelerator: shortcut.accelerator,
    click: (_item, _window, event) => send(shortcut.command, shortcut.index, event.triggeredByAccelerator),
  });
  const shortcut = (command: AppCommand) => item(APP_SHORTCUTS.find((entry) => entry.command === command)!);
  const switchViews = APP_SHORTCUTS.filter((entry) => entry.command === "switchView").map(item);

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about", label: `关于 ${app.name}` },
        { type: "separator" },
        shortcut("settings"),
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: `隐藏 ${app.name}` },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: `退出 ${app.name}` },
      ],
    },
    {
      label: "文件",
      submenu: [
        shortcut("newChat"),
        { label: "添加项目…", click: () => send("openProject") },
        { type: "separator" },
        shortcut("closeView"),
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴并匹配样式" },
        { role: "delete", label: "删除" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        shortcut("toggleSidebar"),
        shortcut("quickSwitch"),
        shortcut("search"),
        shortcut("focusComposer"),
        shortcut("copyLastReply"),
        { type: "separator" },
        { label: "切换会话", submenu: switchViews },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "将所有窗口移到前面" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
