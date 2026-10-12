import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@hcode/shared/types";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: vi.fn() } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
import { useAppStore } from "./appStore";

beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ settings: DEFAULT_SETTINGS, models: {}, modelsLoading: {}, modelErrors: {} });
});

describe("模型列表读取与重试", () => {
  it("失败原因可见，失败不缓存为默认列表；重试可以成功读取", async () => {
    invoke.mockRejectedValueOnce(new Error("Cline 尚未登录"));
    await useAppStore.getState().loadModels("cline");
    expect(useAppStore.getState().modelErrors.cline).toBe("Cline 尚未登录");
    expect(useAppStore.getState().models.cline).toBeUndefined();
    expect(useAppStore.getState().modelsLoading.cline).toBe(false);
    const models = [{ value: "cline-model:custom/model", label: "提供商 · 模型" }];
    invoke.mockResolvedValueOnce(models);
    await useAppStore.getState().loadModels("cline");
    expect(useAppStore.getState().models.cline).toEqual(models);
    expect(useAppStore.getState().modelErrors.cline).toBeUndefined();
  });
  it("成功列表复用缓存，显式刷新能够更新新配置", async () => {
    invoke.mockResolvedValueOnce([{ value: "old", label: "旧模型" }]);
    await useAppStore.getState().loadModels("cline");
    await useAppStore.getState().loadModels("cline");
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValueOnce([{ value: "new", label: "新模型" }]);
    await useAppStore.getState().loadModels("cline", true);
    expect(useAppStore.getState().models.cline?.[0]?.value).toBe("new");
  });
  it("CLI 路径改变时丢弃旧请求结果并读取新路径的模型", async () => {
    let complete!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const loading = useAppStore.getState().loadModels("cline");
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, agentPaths: { ...DEFAULT_SETTINGS.agentPaths, cline: "/new/cline" } } });
    invoke.mockResolvedValueOnce([{ value: "new", label: "新模型" }]);
    complete([{ value: "old", label: "旧模型" }]);
    await loading;
    await vi.waitFor(() => expect(useAppStore.getState().models.cline?.[0]?.value).toBe("new"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
