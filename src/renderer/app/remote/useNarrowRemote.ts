// 远程页面在手机等窄屏上改用覆盖式侧边栏；本机窗口始终返回 false。
import { useSyncExternalStore } from "react";
import { isRemote } from "../bridge";

const QUERY = "(max-width: 767px)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useNarrowRemote(): boolean {
  return useSyncExternalStore(isRemote ? subscribe : () => () => {}, () => isRemote && window.matchMedia(QUERY).matches);
}
