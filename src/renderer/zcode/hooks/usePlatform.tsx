// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
// ZCode 的 IPlatformService 很大；这里只实现卡片与 markdown 用到的几项。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Platform = any;

const platform: Platform = {
  openExternal(url: string) {
    void window.hcode.invoke("app:openExternal", url);
  },
  async getInstalledEditors() {
    return [];
  },
  async openInEditor(_editorId: string, path: string) {
    await window.hcode.invoke("app:openPath", path);
    return { success: true };
  },
  async openInFileManager(path: string) {
    await window.hcode.invoke("app:showInFinder", path);
    return { success: true };
  },
};

export function usePlatform(): Platform {
  return platform;
}

export function useOptionalPlatform(): Platform | null {
  return platform;
}
