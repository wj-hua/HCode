// HCode shim：替换 ZCode 原文件（原实现依赖 ZCode 的 services/store 层）。
import { create } from "zustand";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useSubagentsStore = create<{ agents: any[] }>(() => ({ agents: [] }));
