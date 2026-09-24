import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../shared/types.js";
import { AppStore, mergeSettings } from "../appStore.js";

describe("mergeSettings", () => {
  it("按 CLI 分组的字段只改补丁里给出的 CLI", () => {
    const current = {
      ...DEFAULT_SETTINGS,
      agentPaths: { ...DEFAULT_SETTINGS.agentPaths, claude: "/opt/claude" },
      defaultModels: { ...DEFAULT_SETTINGS.defaultModels, codex: "gpt-x" },
    };
    const next = mergeSettings(current, { agentPaths: { codex: "/opt/codex" }, defaultModels: { step: "step-1" } });
    expect(next.agentPaths).toEqual({ ...DEFAULT_SETTINGS.agentPaths, claude: "/opt/claude", codex: "/opt/codex" });
    expect(next.defaultModels).toEqual({ ...DEFAULT_SETTINGS.defaultModels, codex: "gpt-x", step: "step-1" });
    expect(next.defaultPermissionModes).toEqual(DEFAULT_SETTINGS.defaultPermissionModes);
  });

  it("顶层字段直接覆盖，undefined 视为未提供", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { theme: "dark", locale: undefined, agentPaths: { claude: undefined } });
    expect(next.theme).toBe("dark");
    expect(next.locale).toBe(DEFAULT_SETTINGS.locale);
    expect(next.agentPaths.claude).toBe("");
  });

  it("空串是合法值（恢复自动查找 / CLI 默认模型）", () => {
    const current = { ...DEFAULT_SETTINGS, agentPaths: { ...DEFAULT_SETTINGS.agentPaths, agy: "/x/agy" } };
    expect(mergeSettings(current, { agentPaths: { agy: "" } }).agentPaths.agy).toBe("");
  });

  it("不修改传入的对象", () => {
    const current = structuredClone(DEFAULT_SETTINGS);
    mergeSettings(current, { theme: "light", defaultModels: { claude: "opus" } });
    expect(current).toEqual(DEFAULT_SETTINGS);
  });
});

describe("AppStore.updateSettings", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("连续的局部更新互不覆盖，并持久化到 settings.json", () => {
    dir = mkdtempSync(join(tmpdir(), "hcode-store-"));
    const store = new AppStore(dir);
    store.updateSettings({ defaultModels: { claude: "opus" } });
    store.updateSettings({ defaultModels: { codex: "gpt-x" } });
    store.updateSettings({ defaultPermissionModes: { step: "auto" } });

    const expected = {
      ...DEFAULT_SETTINGS.defaultModels,
      claude: "opus",
      codex: "gpt-x",
    };
    expect(store.settings.defaultModels).toEqual(expected);
    expect(store.settings.defaultPermissionModes.step).toBe("auto");
    expect(store.settings.defaultPermissionModes.claude).toBe(DEFAULT_SETTINGS.defaultPermissionModes.claude);

    const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(saved.defaultModels).toEqual(expected);
    expect(new AppStore(dir).settings).toEqual(store.settings);
  });

  it("读取旧版扁平设置时迁移到按 CLI 分组的结构", () => {
    dir = mkdtempSync(join(tmpdir(), "hcode-store-"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "dark", claudePath: "/old/claude", defaultPermissionMode: "plan", defaultModel: "sonnet" }),
    );
    const { settings } = new AppStore(dir);
    expect(settings.theme).toBe("dark");
    expect(settings.agentPaths).toEqual({ ...DEFAULT_SETTINGS.agentPaths, claude: "/old/claude" });
    expect(settings.defaultPermissionModes.claude).toBe("plan");
    expect(settings.defaultModels.claude).toBe("sonnet");
    expect(settings).not.toHaveProperty("claudePath");
  });
});
