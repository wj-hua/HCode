// 本机窗口订阅远程操控状态（远程页面本身不使用）。
import { useEffect, useState } from "react";
import type { RemoteControlStatus } from "@hcode/shared/remoteControl";
import { hcode, isRemote } from "../bridge";

export function useRemoteStatus(): RemoteControlStatus | null {
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  useEffect(() => {
    if (isRemote) return;
    let alive = true;
    void hcode.invoke("remote:status").then((value) => { if (alive) setStatus(value); });
    const off = hcode.on("remote:status", setStatus);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return status;
}
