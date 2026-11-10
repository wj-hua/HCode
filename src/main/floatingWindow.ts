// 悬浮窗：HCode 在后台且有任务运行或等待审批时，浮在其他 App 和全屏 Space 之上。
import { app, BrowserWindow, screen, type Rectangle } from "electron";
import { fileURLToPath } from "node:url";
import type { FloatingState, FloatingTask, Settings } from "../shared/types.js";

/** 用户拖动后记住右上角，展开 / 收起时右上角保持不动。 */
export interface FloatingAnchor {
  right: number;
  top: number;
}

interface FloatingOptions {
  enabled(): boolean;
  theme(): Settings["theme"];
  readAnchor(): FloatingAnchor | undefined;
  writeAnchor(anchor: FloatingAnchor): void;
  openView(viewId: string): void;
}

const MARGIN = 12;
/** 快速切换 App 时不闪现。 */
const SHOW_DELAY = 800;
/** 后台任务全部结束后，保留“已完成”提示的时间。 */
const DONE_LINGER = 3000;

export class FloatingIndicator {
  private win: BrowserWindow | null = null;
  private ready = false;
  private tasks: FloatingTask[] = [];
  private size = { width: 220, height: 40 };
  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private userMoving = false;

  constructor(private readonly options: FloatingOptions) {
    app.on("browser-window-focus", () => this.sync());
    app.on("browser-window-blur", () => this.sync());
  }

  state(): FloatingState {
    return { tasks: this.tasks, theme: this.options.theme() };
  }

  setTasks(tasks: FloatingTask[]) {
    this.tasks = tasks;
    this.refresh();
  }

  /** 任务、设置或主题变化后重新推送并判断显隐。 */
  refresh() {
    this.publish();
    this.sync();
  }

  open(viewId: string) {
    this.options.openView(viewId);
  }

  resize(size: { width: number; height: number }) {
    const width = Math.round(Math.min(Math.max(size.width, 120), 420));
    const height = Math.round(Math.min(Math.max(size.height, 32), 480));
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    if (!this.win || this.win.isDestroyed()) return;
    const bounds = this.win.getBounds();
    this.win.setBounds({ x: bounds.x + bounds.width - width, y: bounds.y, width, height });
    // 透明窗口的阴影按内容轮廓计算，尺寸变化后要重算
    this.win.invalidateShadow();
  }

  dispose() {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  /** 点击悬浮窗会让它自己获得焦点，这时仍算 HCode 在后台。 */
  private inBackground() {
    const focused = BrowserWindow.getFocusedWindow();
    return focused === null || focused === this.win;
  }

  private wanted() {
    return this.options.enabled() && this.tasks.length > 0 && this.inBackground();
  }

  private visible() {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  private sync() {
    if (this.wanted()) {
      clearTimeout(this.hideTimer);
      this.hideTimer = undefined;
      if (this.visible() || this.showTimer) return;
      this.showTimer = setTimeout(() => {
        this.showTimer = undefined;
        if (this.wanted()) this.show();
      }, SHOW_DELAY);
      return;
    }
    clearTimeout(this.showTimer);
    this.showTimer = undefined;
    if (!this.visible()) return;
    if (!this.inBackground() || !this.options.enabled()) {
      this.hide();
      return;
    }
    // 仍在后台、任务都结束了：先显示“已完成”，稍后再隐藏
    this.hideTimer ??= setTimeout(() => {
      this.hideTimer = undefined;
      if (!this.wanted()) this.hide();
    }, DONE_LINGER);
  }

  private show() {
    const win = this.ensureWindow();
    if (!this.options.readAnchor()) win.setBounds(this.defaultBounds());
    if (this.ready) win.showInactive();
    else win.once("ready-to-show", () => this.wanted() && win.showInactive());
  }

  private hide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
    if (this.visible()) this.win!.hide();
  }

  private publish() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send("floating:state", this.state());
  }

  /** 没拖动过时放在鼠标所在屏幕的右上角。 */
  private defaultBounds(): Rectangle {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return { ...this.size, x: area.x + area.width - this.size.width - MARGIN, y: area.y + MARGIN };
  }

  private initialBounds(): Rectangle {
    const anchor = this.options.readAnchor();
    if (!anchor) return this.defaultBounds();
    const onScreen = screen.getAllDisplays().some(({ workArea: area }) =>
      anchor.right > area.x + 40 && anchor.right <= area.x + area.width + 40
      && anchor.top >= area.y - 20 && anchor.top < area.y + area.height - 20);
    return onScreen ? { ...this.size, x: anchor.right - this.size.width, y: anchor.top } : this.defaultBounds();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...this.initialBounds(),
      // macOS NSPanel：不激活 App，可浮在全屏 App 之上
      type: "panel",
      frame: false,
      // 卡片由页面按 HCode 主题绘制；系统 vibrancy 只跟随系统外观，和应用主题可能不一致
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: true,
      alwaysOnTop: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // 不可聚焦时点击会让系统把焦点交给主窗口，主窗口随之被带到前台；
      // 允许悬浮窗自己接收焦点，点击只作用于悬浮窗。显示时仍用 showInactive，不抢焦点。
      focusable: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      show: false,
      webPreferences: {
        preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.once("ready-to-show", () => { this.ready = true; });
    win.on("will-move", () => { this.userMoving = true; });
    win.on("moved", () => {
      if (!this.userMoving) return;
      this.userMoving = false;
      const bounds = win.getBounds();
      this.options.writeAnchor({ right: bounds.x + bounds.width, top: bounds.y });
    });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
      this.ready = false;
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());

    const devUrl = process.env.HCODE_DEV_SERVER_URL;
    if (devUrl) void win.loadURL(new URL("floating.html", devUrl).toString());
    else void win.loadFile(fileURLToPath(new URL("../renderer/floating.html", import.meta.url)));
    this.win = win;
    return win;
  }
}
