import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@hcode/shared/types";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../bridge", () => ({ hcode: { invoke, on: vi.fn() } }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
import { useAppStore } from "./appStore";

beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ settings: DEFAULT_SETTINGS, models: {}, modelsLoading: {}, modelErrors: {}, conversations: {}, activeViewId: null });
});

describe("沿用上次手动选择的模型", () => {
  beforeEach(() => {
    invoke.mockImplementation(async (channel, patch) => {
      if (channel === "settings:set") {
        const { settings } = useAppStore.getState();
        return { ...settings, lastSelectedModels: { ...settings.lastSelectedModels, ...patch.lastSelectedModels } };
      }
      if (channel === "agent:models") return [];
    });
    useAppStore.setState({ settings: {
      ...DEFAULT_SETTINGS,
      defaultModels: { ...DEFAULT_SETTINGS.defaultModels, codex: "fixed-codex", claude: "sonnet" },
      defaultModelModes: { ...DEFAULT_SETTINGS.defaultModelModes, codex: "lastSelected" },
    } });
  });

  it("聊天框手动选择后新会话沿用，不改变已有会话", async () => {
    useAppStore.getState().newChat("/first", "codex");
    const first = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().conversations[first]?.model).toBe("fixed-codex");
    await useAppStore.getState().setModel("selected-codex");
    expect(invoke).toHaveBeenCalledWith("settings:set", { lastSelectedModels: { codex: "selected-codex" } });
    useAppStore.getState().newChat("/second", "codex");
    const second = useAppStore.getState().activeViewId!;
    expect(useAppStore.getState().conversations[second]?.model).toBe("selected-codex");
    await useAppStore.getState().setModel("");
    useAppStore.getState().newChat("/third", "codex");
    expect(useAppStore.getState().conversations[useAppStore.getState().activeViewId!]?.model).toBe("");
    expect(useAppStore.getState().conversations[first]?.model).toBe("selected-codex");
  });

  it("固定模型保持固定，手动记录按 CLI 隔离，切换 CLI 草稿也沿用", async () => {
    useAppStore.getState().newChat("/first", "claude");
    await useAppStore.getState().setModel("opus");
    useAppStore.getState().newChat("/second", "claude");
    expect(useAppStore.getState().conversations[useAppStore.getState().activeViewId!]?.model).toBe("sonnet");
    useAppStore.getState().setDraftAgent("codex");
    await useAppStore.getState().setModel("selected-codex");
    useAppStore.getState().newChat("/third", "claude");
    useAppStore.getState().setDraftAgent("codex");
    expect(useAppStore.getState().conversations[useAppStore.getState().activeViewId!]?.model).toBe("selected-codex");
    expect(useAppStore.getState().settings.lastSelectedModels).toEqual({ claude: "opus", codex: "selected-codex" });
  });
});

describe("模型列表读取与重试", () => {
  it("失败原因可见，失败不缓存为默认列表；重试可以成功读取", async () => {
    invoke.mockRejectedValueOnce(new Error("Codex 尚未登录"));
    await useAppStore.getState().loadModels("codex");
    expect(useAppStore.getState().modelErrors.codex).toBe("Codex 尚未登录");
    expect(useAppStore.getState().models.codex).toBeUndefined();
    expect(useAppStore.getState().modelsLoading.codex).toBe(false);
    const models = [{ value: "custom/model", label: "提供商 · 模型" }];
    invoke.mockResolvedValueOnce(models);
    await useAppStore.getState().loadModels("codex");
    expect(useAppStore.getState().models.codex).toEqual(models);
    expect(useAppStore.getState().modelErrors.codex).toBeUndefined();
  });
  it("成功列表复用缓存，显式刷新能够更新新配置", async () => {
    invoke.mockResolvedValueOnce([{ value: "old", label: "旧模型" }]);
    await useAppStore.getState().loadModels("codex");
    await useAppStore.getState().loadModels("codex");
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValueOnce([{ value: "new", label: "新模型" }]);
    await useAppStore.getState().loadModels("codex", true);
    expect(useAppStore.getState().models.codex?.[0]?.value).toBe("new");
  });
  it("CLI 路径改变时丢弃旧请求结果并读取新路径的模型", async () => {
    let complete!: (value: unknown) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const loading = useAppStore.getState().loadModels("codex");
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, agentPaths: { ...DEFAULT_SETTINGS.agentPaths, codex: "/new/codex" } } });
    invoke.mockResolvedValueOnce([{ value: "new", label: "新模型" }]);
    complete([{ value: "old", label: "旧模型" }]);
    await loading;
    await vi.waitFor(() => expect(useAppStore.getState().models.codex?.[0]?.value).toBe("new"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
