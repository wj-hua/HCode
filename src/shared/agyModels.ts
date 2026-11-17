import type { ChatUsage, ModelOption } from "./types.js";

/** agy 思考强度从低到高的展示与滑杆顺序。 */
export const AGY_EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

const VARIANT_ID_RE = /^(.+)-(minimal|low|medium|high|xhigh|max)$/i;
const VARIANT_LABEL_RE = /\s*\((minimal|low|medium|high|xhigh|max)\)$/i;

export interface AgyModelVariant {
  base: string;
  effort: string;
}

export interface GroupedAgyModels {
  models: ModelOption[];
  variants: Map<string, Map<string, string>>;
  rawIds: Set<string>;
}

/** 从 agy 模型 ID 末尾提取基础模型与思考强度（如 gemini-4-argon-high）。 */
export function parseAgyModelVariant(id: string): AgyModelVariant | null {
  const match = VARIANT_ID_RE.exec(id.trim());
  if (!match) return null;
  return { base: match[1]!, effort: match[2]!.toLowerCase() };
}

/** 去掉 agy 模型名称末尾的思考强度括号标签（如 Gemini 4 Argon (High)）。 */
export function stripAgyEffortLabel(label: string, effort?: string): string {
  const trimmed = label.trim();
  const match = VARIANT_LABEL_RE.exec(trimmed);
  if (!match) return trimmed;
  if (effort && match[1]!.toLowerCase() !== effort.toLowerCase()) return trimmed;
  return trimmed.slice(0, match.index).trim();
}

function sortEfforts(efforts: Iterable<string>): string[] {
  const order = new Map<string, number>(AGY_EFFORT_ORDER.map((value, index) => [value, index]));
  return [...new Set(efforts)].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
}

/** 将 `agy models` 平铺的强度变体按基础模型聚合，并附上由低到高排列的 efforts。 */
export function groupAgyModels(
  raw: readonly { value: string; label: string }[],
  defaultModel: ModelOption = { value: "", label: "默认模型" },
): GroupedAgyModels {
  const baseCounts = new Map<string, number>();
  for (const item of raw) {
    const parsed = parseAgyModelVariant(item.value);
    if (parsed) baseCounts.set(parsed.base, (baseCounts.get(parsed.base) ?? 0) + 1);
  }

  const rawIds = new Set<string>();
  const variants = new Map<string, Map<string, string>>();
  const grouped = new Map<string, { label: string; efforts: Set<string> }>();
  const order: string[] = [];
  const allEfforts = new Set<string>();

  for (const item of raw) {
    rawIds.add(item.value);
    const parsed = parseAgyModelVariant(item.value);
    const hasLabelSuffix = parsed ? stripAgyEffortLabel(item.label, parsed.effort) !== item.label.trim() : false;
    const isVariant = Boolean(parsed && (hasLabelSuffix || (baseCounts.get(parsed.base) ?? 0) > 1));

    if (parsed && isVariant) {
      let byEffort = variants.get(parsed.base);
      if (!byEffort) {
        byEffort = new Map<string, string>();
        variants.set(parsed.base, byEffort);
      }
      byEffort.set(parsed.effort, item.value);
      allEfforts.add(parsed.effort);

      let entry = grouped.get(parsed.base);
      if (!entry) {
        entry = { label: stripAgyEffortLabel(item.label, parsed.effort) || item.label, efforts: new Set() };
        grouped.set(parsed.base, entry);
        order.push(parsed.base);
      }
      entry.efforts.add(parsed.effort);
      continue;
    }

    if (!grouped.has(item.value)) {
      grouped.set(item.value, { label: item.label, efforts: new Set() });
      order.push(item.value);
    }
  }

  const defaultEfforts = sortEfforts(allEfforts);
  const models: ModelOption[] = [
    { ...defaultModel, ...(defaultEfforts.length ? { efforts: defaultEfforts } : {}) },
    ...order.map((value) => {
      const entry = grouped.get(value)!;
      const efforts = sortEfforts(entry.efforts);
      return { value, label: entry.label, ...(efforts.length ? { efforts } : {}) };
    }),
  ];

  return { models, variants, rawIds };
}

/** 将界面选择的基础模型（或旧版变体 ID）与思考强度解析为传给 agy CLI 的参数。 */
export function resolveAgyModelInput(
  variants: ReadonlyMap<string, ReadonlyMap<string, string>>,
  model?: string,
  effort?: string,
): { model?: string; effort?: string } {
  const cleanModel = model?.trim() || undefined;
  const cleanEffort = effort?.trim() || undefined;
  if (!cleanModel) return cleanEffort ? { effort: cleanEffort } : {};

  let base: string | undefined;
  let effectiveEffort = cleanEffort;
  if (variants.has(cleanModel)) {
    base = cleanModel;
  } else {
    const parsed = parseAgyModelVariant(cleanModel);
    if (parsed && variants.has(parsed.base)) {
      base = parsed.base;
      effectiveEffort = cleanEffort ?? parsed.effort;
    }
  }

  if (base) {
    const byEffort = variants.get(base)!;
    if (effectiveEffort) {
      const exact = byEffort.get(effectiveEffort);
      if (exact) return { model: exact };
      return { model: base, effort: effectiveEffort };
    }
    if (byEffort.size === 1) return { model: [...byEffort.values()][0]! };
    return { model: base };
  }

  return { model: cleanModel, ...(cleanEffort ? { effort: cleanEffort } : {}) };
}

/** 兼容旧版保存的带强度后缀 ID，迁移到对应的基础模型与思考强度。 */
export function normalizeAgyModelSelection(
  models: readonly ModelOption[],
  model: string,
  effort: string,
): { model: string; effort: string } {
  if (!model || models.some((item) => item.value === model)) return { model, effort };
  const parsed = parseAgyModelVariant(model);
  if (!parsed) return { model, effort };
  const baseOption = models.find((item) => item.value === parsed.base);
  if (!baseOption) return { model, effort };
  const nextEffort = baseOption.efforts?.includes(effort)
    ? effort
    : (baseOption.efforts?.includes(parsed.effort) ? parsed.effort : "");
  return { model: baseOption.value, effort: nextEffort };
}

/** 将基础模型或变体 ID 转成友好的模型展示名。 */
export function agyModelDisplayLabel(models: readonly ModelOption[], modelId: string): string | undefined {
  const direct = models.find((item) => item.value === modelId)?.label;
  if (direct) return direct;
  const parsed = parseAgyModelVariant(modelId);
  return parsed ? models.find((item) => item.value === parsed.base)?.label : undefined;
}

/** 校验 agy init 返回的真实模型是否符合预期（允许基础模型解析到同族默认变体）。 */
export function agyInitModelMatches(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== "string" || !expected) return false;
  if (actual === expected) return true;
  return !parseAgyModelVariant(expected) && parseAgyModelVariant(actual)?.base === expected;
}

const CONTEXT_OVERRIDE_PRESETS: Record<string, number> = {
  "1m": 1_048_576,
  "250k": 250_000,
  "200k": 200_000,
  "128k": 131_072,
};

function parseContextWindowOverride(value: string | undefined): number | undefined {
  const clean = value?.trim().toLowerCase();
  if (!clean) return undefined;
  const preset = CONTEXT_OVERRIDE_PRESETS[clean];
  if (preset) return preset;
  if (/^\d+$/.test(clean)) {
    const tokens = Number(clean);
    return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
  }
  return undefined;
}

/** 按 Antigravity 模型族（及可选的 settings.json contextWindow 覆盖）解析上下文窗口大小。 */
export function agyContextWindowTokens(
  modelId: string | undefined,
  overrides?: Readonly<Record<string, string>>,
): number | undefined {
  const clean = modelId?.trim().toLowerCase();
  if (!clean) return undefined;
  if (overrides) {
    const base = parseAgyModelVariant(clean)?.base;
    const custom = parseContextWindowOverride(overrides[clean] ?? (base ? overrides[base] : undefined));
    if (custom) return custom;
  }
  if (clean.startsWith("gemini-")) return 1_048_576;
  if (clean.startsWith("claude-")) return 250_000;
  if (clean.startsWith("gpt-oss-")) return 131_072;
  return undefined;
}

export type AgyContextUsage = Pick<ChatUsage, "contextUsedTokens" | "contextWindowTokens" | "contextUsedPercent">;

/** 仅在已用 Token 与模型窗口均有效时生成上下文容量指标。 */
export function agyContextUsage(
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): AgyContextUsage | undefined {
  if (
    typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens <= 0 ||
    typeof windowTokens !== "number" || !Number.isFinite(windowTokens) || windowTokens <= 0
  ) {
    return undefined;
  }
  return {
    contextUsedTokens: usedTokens,
    contextWindowTokens: windowTokens,
    contextUsedPercent: (usedTokens / windowTokens) * 100,
  };
}
