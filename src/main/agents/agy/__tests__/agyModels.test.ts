import { describe, expect, it } from "vitest";
import {
  agyContextUsage,
  agyContextWindowTokens,
  agyInitModelMatches,
  agyModelDisplayLabel,
  groupAgyModels,
  normalizeAgyModelSelection,
  resolveAgyModelInput,
} from "../../../../shared/agyModels.js";

const SAMPLE_RAW = [
  { value: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
  { value: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
  { value: "gemini-4-argon-low", label: "Gemini 4 Argon (Low)" },
  { value: "gemini-4-hydrogen-high", label: "Gemini 4 Hydrogen (High)" },
  { value: "gemini-4-hydrogen-xhigh", label: "Gemini 4 Hydrogen (XHigh)" },
  { value: "gemini-4-hydrogen-medium", label: "Gemini 4 Hydrogen (Medium)" },
  { value: "gemini-4-hydrogen-low", label: "Gemini 4 Hydrogen (Low)" },
  { value: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)" },
  { value: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

describe("groupAgyModels", () => {
  it("将同一模型的不同思考强度折叠并按由低到高排序，无强度后缀的模型保持独立", () => {
    const grouped = groupAgyModels(SAMPLE_RAW);
    expect(grouped.models).toEqual([
      { value: "", label: "默认模型", efforts: ["low", "medium", "high", "xhigh"] },
      { value: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"] },
      { value: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"] },
      { value: "gemini-pro-orchestrator-g1-pro", label: "Orchestrator (Argon)" },
      { value: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ]);
  });

  it("解析基础模型和思考强度到精确 CLI 参数，并兼容旧版变体 ID", () => {
    const { variants } = groupAgyModels(SAMPLE_RAW);
    expect(resolveAgyModelInput(variants, "gemini-4-argon", "high")).toEqual({ model: "gemini-4-argon-high" });
    expect(resolveAgyModelInput(variants, "gemini-4-argon", "")).toEqual({ model: "gemini-4-argon" });
    expect(resolveAgyModelInput(variants, "gpt-oss-120b", "")).toEqual({ model: "gpt-oss-120b-medium" });
    expect(resolveAgyModelInput(variants, "gemini-4-hydrogen-high", "")).toEqual({ model: "gemini-4-hydrogen-high" });
    expect(resolveAgyModelInput(variants, "gemini-4-hydrogen-high", "low")).toEqual({ model: "gemini-4-hydrogen-low" });
    expect(resolveAgyModelInput(variants, "", "xhigh")).toEqual({ effort: "xhigh" });
    expect(resolveAgyModelInput(variants, "", "")).toEqual({});
    expect(resolveAgyModelInput(new Map(), "gemini-4-argon", "high")).toEqual({
      model: "gemini-4-argon",
      effort: "high",
    });
  });

  it("迁移旧版选中的带后缀模型到基础模型与思考强度并生成友好展示名", () => {
    const { models } = groupAgyModels(SAMPLE_RAW);
    expect(normalizeAgyModelSelection(models, "gemini-4-hydrogen-high", "")).toEqual({
      model: "gemini-4-hydrogen",
      effort: "high",
    });
    expect(normalizeAgyModelSelection(models, "gemini-4-hydrogen-high", "low")).toEqual({
      model: "gemini-4-hydrogen",
      effort: "low",
    });
    expect(normalizeAgyModelSelection(models, "gemini-4-argon", "medium")).toEqual({
      model: "gemini-4-argon",
      effort: "medium",
    });
    expect(agyModelDisplayLabel(models, "gemini-4-argon-medium")).toBe("Gemini 4 Argon");
  });

  it("校验 init 返回的模型时允许基础模型匹配同族变体，但拒绝跨族或错误强度", () => {
    expect(agyInitModelMatches("gemini-4-argon-high", "gemini-4-argon-high")).toBe(true);
    expect(agyInitModelMatches("gemini-4-argon-medium", "gemini-4-argon")).toBe(true);
    expect(agyInitModelMatches("gemini-4-argon-medium", "gemini-4-argon-high")).toBe(false);
    expect(agyInitModelMatches("claude-opus-5-5-medium", "gemini-4-argon")).toBe(false);
  });

  it("按模型族与可选 settings 覆盖解析上下文窗口，不伪造未知模型容量", () => {
    expect(agyContextWindowTokens("gemini-4-hydrogen-high")).toBe(1_048_576);
    expect(agyContextWindowTokens("gemini-4-hydrogen")).toBe(1_048_576);
    expect(agyContextWindowTokens("claude-sonnet-4-6")).toBe(250_000);
    expect(agyContextWindowTokens("claude-sonnet-4-6", { "claude-sonnet-4-6": "1m" })).toBe(1_048_576);
    expect(agyContextWindowTokens("claude-opus-4-6-high", { "claude-opus-4-6": "1m" })).toBe(1_048_576);
    expect(agyContextWindowTokens("gpt-oss-120b-medium")).toBe(131_072);
    expect(agyContextWindowTokens("unknown-model")).toBeUndefined();
    expect(agyContextWindowTokens("")).toBeUndefined();
    expect(agyContextUsage(52_428.8, 1_048_576)).toEqual({
      contextUsedTokens: 52_428.8,
      contextWindowTokens: 1_048_576,
      contextUsedPercent: 5,
    });
    expect(agyContextUsage(0, 1_048_576)).toBeUndefined();
    expect(agyContextUsage(1000, undefined)).toBeUndefined();
  });
});
