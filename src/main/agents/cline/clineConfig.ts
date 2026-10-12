// 只在主进程读取 Cline 的提供商配置；密钥仅传给 CLI 子进程。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModelOption } from "../../../shared/types.js";
import { isRecord, type JsonRecord } from "../rowProjectorBase.js";
import { clineDataDir } from "./clineHistory.js";

const MODEL_PREFIX = "cline-model:";
const OAUTH_PROVIDERS = new Set(["cline", "cline-pass", "openai-codex"]);
export const CLINE_EFFORTS = ["none", "low", "medium", "high", "xhigh"];

export interface ClineConfig { settings: JsonRecord; catalog: JsonRecord }

async function readConfig(path: string): Promise<JsonRecord> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)) throw new Error("配置不是对象");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // 不把包含密钥的 JSON 原文或解析错误输出到界面。
    throw new Error(`无法读取 Cline 配置：${path}`);
  }
}

export async function readClineConfig(env: Record<string, string>): Promise<ClineConfig> {
  const path = env.CLINE_PROVIDER_SETTINGS_PATH?.trim() || join(clineDataDir(env), "settings/providers.json");
  const [settings, catalog] = await Promise.all([readConfig(path), readConfig(join(dirname(path), "models.json"))]);
  return { settings, catalog };
}

function providerSettings(config: ClineConfig, id: string): JsonRecord {
  const providers = isRecord(config.settings.providers) ? config.settings.providers : {};
  const entry = isRecord(providers[id]) ? providers[id] : {};
  return isRecord(entry.settings) ? entry.settings : {};
}

function apiKey(settings: JsonRecord): string | undefined {
  const auth = isRecord(settings.auth) ? settings.auth : {};
  const key = settings.apiKey ?? auth.apiKey;
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

function hasOAuth(settings: JsonRecord): boolean {
  return isRecord(settings.auth) && typeof settings.auth.accessToken === "string" && Boolean(settings.auth.accessToken.trim());
}

export function clineModelValue(provider: string, model: string): string {
  return `${MODEL_PREFIX}${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;
}

export function parseClineModel(value: string): { provider?: string; model?: string } {
  if (!value) return {};
  if (!value.startsWith(MODEL_PREFIX)) return { model: value }; // 兼容已有的裸模型 ID。
  const parts = value.slice(MODEL_PREFIX.length).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Cline 模型选项无效，请重新选择模型");
  try { return { provider: decodeURIComponent(parts[0]), model: decodeURIComponent(parts[1]) }; }
  catch { throw new Error("Cline 模型选项无效，请重新选择模型"); }
}

export function clineEnvironment(env: Record<string, string>, config: ClineConfig, selection = "") {
  const chosen = parseClineModel(selection);
  const pinned = env.CLINE_PROVIDER?.trim();
  if (pinned && chosen.provider && pinned !== chosen.provider) throw new Error("CLINE_PROVIDER 已固定提供商，不能选择其他提供商的模型");
  const saved = typeof config.settings.lastUsedProvider === "string" ? config.settings.lastUsedProvider : undefined;
  const provider = pinned || chosen.provider || saved;
  const settings = provider ? providerSettings(config, provider) : {};
  const next = { ...env };
  let authMethod: string | undefined;
  if (provider) {
    next.CLINE_PROVIDER = provider;
    if (!next.CLINE_API_KEY) {
      if (OAUTH_PROVIDERS.has(provider) && hasOAuth(settings)) authMethod = provider;
      else {
        const key = apiKey(settings);
        if (key) next.CLINE_API_KEY = key;
      }
    }
  }
  const model = chosen.model || env.CLINE_MODEL || (typeof settings.model === "string" ? settings.model : undefined);
  if (model) next.CLINE_MODEL = model;
  return { env: next, provider, modelId: model, authMethod };
}

export function clineProviderLabel(config: ClineConfig, provider: string): string {
  const providers = isRecord(config.catalog.providers) ? config.catalog.providers : {};
  const entry = isRecord(providers[provider]) ? providers[provider] : {};
  const descriptor = isRecord(entry.provider) ? entry.provider : {};
  return typeof descriptor.name === "string" ? descriptor.name : provider;
}

/** 用户自己登记的模型；不猜测模型名或网络探测自定义 API 地址。 */
export function configuredClineModels(config: ClineConfig, env: Record<string, string>): ModelOption[] {
  const providers = isRecord(config.settings.providers) ? config.settings.providers : {};
  const catalog = isRecord(config.catalog.providers) ? config.catalog.providers : {};
  const models: ModelOption[] = [];
  for (const id of Object.keys(providers)) {
    if (env.CLINE_PROVIDER && env.CLINE_PROVIDER !== id) continue;
    const settings = providerSettings(config, id);
    if (!apiKey(settings) && !hasOAuth(settings) && !(env.CLINE_PROVIDER === id && env.CLINE_API_KEY)) continue;
    const entry = isRecord(catalog[id]) ? catalog[id] : {};
    const definitions = isRecord(entry.models) ? entry.models : {};
    const candidates = new Map<string, string>();
    for (const [key, value] of Object.entries(definitions)) {
      if (!isRecord(value)) continue;
      const model = typeof value.id === "string" && value.id ? value.id : key;
      candidates.set(model, typeof value.name === "string" ? value.name : model);
    }
    if (typeof settings.model === "string" && settings.model && !candidates.has(settings.model)) candidates.set(settings.model, settings.model);
    for (const [model, label] of candidates) models.push({ value: clineModelValue(id, model), label: `${clineProviderLabel(config, id)} · ${label}`, efforts: CLINE_EFFORTS });
  }
  return models;
}
