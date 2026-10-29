// 工具详情归属单个卡片：仅显式展开时读取，切换引用或卸载会取消旧请求。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { isRemoteToolRow } from "@hcode/shared/remoteControl";
import { remoteBridge } from "../bridge";

export function useRemoteToolDetails(row: ToolCallRow) {
  const reference = isRemoteToolRow(row) ? row.remoteDetails.ref : undefined;
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ ref?: string; row?: ToolCallRow; loading: boolean; error?: string }>({ loading: false });
  useEffect(() => {
    setState({ ref: reference, loading: false });
    return () => { request.current?.abort(); request.current = null; };
  }, [reference]);
  const loaded = state.ref === reference ? state.row : undefined;
  const load = useCallback(async () => {
    if (!reference || !remoteBridge || request.current || loaded) return;
    const controller = new AbortController();
    request.current = controller;
    setState({ ref: reference, loading: true });
    try {
      const detail = await remoteBridge.loadToolDetails(reference, controller.signal);
      if (!controller.signal.aborted) setState({ ref: reference, row: detail, loading: false });
    } catch (error) {
      if (!controller.signal.aborted) setState({ ref: reference, loading: false, error: error instanceof Error ? error.message : String(error) });
    } finally { if (request.current === controller) request.current = null; }
  }, [reference, loaded]);
  return { row: loaded ?? row, details: reference ? {
    toolId: row.toolCallId, ready: !!loaded, loading: state.ref === reference && state.loading,
    error: state.ref === reference ? state.error : undefined, load,
  } : null };
}
