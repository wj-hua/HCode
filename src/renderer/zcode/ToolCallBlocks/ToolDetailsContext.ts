// 宿主提供可选的延迟详情能力；工具组件保持与远程协议和传输层解耦。
import { createContext, useContext } from "react";
export interface ToolDetailsState {
  toolId: string;
  ready: boolean;
  loading: boolean;
  error?: string;
  load(): void;
}
export const ToolDetailsContext = createContext<ToolDetailsState | null>(null);
export function useToolDetails(toolId: string) {
  const state = useContext(ToolDetailsContext);
  return state?.toolId === toolId ? state : null;
}
