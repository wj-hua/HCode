// 主窗口：macOS 视觉参数沿用 ZCode（packages/desktop/src/main/desktopWindowChrome.ts）。
import { BrowserWindow, screen, shell } from "electron";
import { fileURLToPath } from "node:url";
import type { AppStore } from "./appStore.js";

// ZCode desktopWindowButtonPosition.ts 的基准红绿灯位置
const MACOS_TRAFFIC_LIGHT_POSITION = { x: 22, y: 23 };

export function createMainWindow(store: AppStore): BrowserWindow {
  const saved = store.readWindowState();
  const visible = screen.getAllDisplays().some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      saved.x !== undefined &&
      saved.y !== undefined &&
      saved.x >= x - 50 &&
      saved.y >= y - 50 &&
      saved.x < x + width &&
      saved.y < y + height
    );
  });

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(visible ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "HCode",
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION,
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (saved.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const saveBounds = () => {
    if (win.isDestroyed() || win.isFullScreen()) return;
    const bounds = win.getNormalBounds();
    store.writeWindowState({ ...bounds, maximized: win.isMaximized() });
  };
  win.on("close", saveBounds);

  const sendFullscreen = (fullscreen: boolean) =>
    win.webContents.send("window:fullscreen", { fullscreen });
  win.on("enter-full-screen", () => sendFullscreen(true));
  win.on("leave-full-screen", () => sendFullscreen(false));

  // 页面内链接一律用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.HCODE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  const devUrl = process.env.HCODE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  return win;
}
