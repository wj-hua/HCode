// 各 CLI 的订阅额度（5 小时 / 每周）统一换算成 AgentQuota：
// - Claude：Agent SDK 的 usage 控制请求（/usage 背后的数据，utilization 0–100，resets_at 为 ISO 时间）
// - Codex：app-server 的 account/rateLimits/read（usedPercent 0–100，resetsAt 为秒级时间戳，窗口时长看 windowDurationMins）
// - Antigravity：`agy -p /quota --output-format json` 的 command.data.groups（remaining_fraction 0–1，reset_time 为 ISO 时间）
// - GLM Coding Plan：/api/monitor/usage/quota/limit 的 data.limits（percentage 0–100，nextResetTime 为毫秒时间戳）
import type { AgentQuota, QuotaGroup, QuotaSource, QuotaWindow, QuotaWindowKind } from "../../shared/types.js";
import { isRecord, type JsonRecord } from "./rowProjectorBase.js";

const FIVE_HOURS_MIN = 5 * 60;
const WEEK_MIN = 7 * 24 * 60;

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** 组内按 5 小时、每周、其他排列（同类保持原顺序）。 */
function sortWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const order: Record<QuotaWindowKind, number> = { "5h": 0, weekly: 1, other: 2 };
  return windows.sort((a, b) => order[a.kind] - order[b.kind]);
}

function makeWindow(kind: QuotaWindowKind, label: string, usedPercent: number, resetsAt?: number): QuotaWindow {
  return { kind, label, usedPercent: clampPercent(usedPercent), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

export function quotaError(agent: QuotaSource, error: unknown): AgentQuota {
  const message = error instanceof Error ? error.message : String(error);
  return { agent, status: "error", message, groups: [], updatedAt: Date.now() };
}

export function quotaUnavailable(agent: QuotaSource, message: string): AgentQuota {
  return { agent, status: "unavailable", message, groups: [], updatedAt: Date.now() };
}

// ───────────────────────── Claude ─────────────────────────

const CLAUDE_WINDOWS: [key: string, kind: QuotaWindowKind, label: string][] = [
  ["five_hour", "5h", "5 小时"],
  ["seven_day", "weekly", "每周"],
  ["seven_day_opus", "weekly", "每周 · Opus"],
  ["seven_day_sonnet", "weekly", "每周 · Sonnet"],
];

/** 参数是 SDK usage 请求的返回值（SDKControlGetUsageResponse）。 */
export function claudeQuota(usage: unknown, now = Date.now()): AgentQuota {
  if (!isRecord(usage) || !usage.rate_limits_available || !isRecord(usage.rate_limits)) {
    return { ...quotaUnavailable("claude", "当前登录方式没有订阅额度（API key、Bedrock、Vertex 等）"), updatedAt: now };
  }
  const limits = usage.rate_limits;
  const windows: QuotaWindow[] = [];
  const add = (label: string, kind: QuotaWindowKind, entry: unknown) => {
    if (!isRecord(entry) || typeof entry.utilization !== "number") return;
    windows.push(makeWindow(kind, label, entry.utilization, isoTime(entry.resets_at)));
  };
  for (const [key, kind, label] of CLAUDE_WINDOWS) add(label, kind, limits[key]);
  for (const entry of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    if (!isRecord(entry) || typeof entry.display_name !== "string") continue;
    const label = `每周 · ${entry.display_name}`;
    if (!windows.some((item) => item.label === label)) add(label, "weekly", entry);
  }
  const plan = typeof usage.subscription_type === "string" ? usage.subscription_type : undefined;
  return {
    agent: "claude",
    status: "ok",
    ...(plan ? { plan } : {}),
    groups: windows.length ? [{ windows }] : [],
    updatedAt: now,
  };
}

// ───────────────────────── Codex ─────────────────────────

function codexWindowLabel(minutes: number | null): [QuotaWindowKind, string] {
  if (minutes === FIVE_HOURS_MIN) return ["5h", "5 小时"];
  if (minutes === WEEK_MIN) return ["weekly", "每周"];
  if (minutes === null) return ["other", "额度"];
  if (minutes % (24 * 60) === 0) return ["other", `${minutes / (24 * 60)} 天`];
  if (minutes % 60 === 0) return ["other", `${minutes / 60} 小时`];
  return ["other", `${minutes} 分钟`];
}

function codexWindows(snapshot: JsonRecord): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const entry of [snapshot.primary, snapshot.secondary]) {
    if (!isRecord(entry) || typeof entry.usedPercent !== "number") continue;
    const minutes = typeof entry.windowDurationMins === "number" ? entry.windowDurationMins : null;
    const [kind, label] = codexWindowLabel(minutes);
    const resetsAt = typeof entry.resetsAt === "number" ? entry.resetsAt * 1000 : undefined;
    windows.push(makeWindow(kind, label, entry.usedPercent, resetsAt));
  }
  return sortWindows(windows);
}

/** 参数是 account/rateLimits/read 的返回值（GetAccountRateLimitsResponse）。 */
export function codexQuota(response: unknown, now = Date.now()): AgentQuota {
  if (!isRecord(response)) return { ...quotaError("codex", "account/rateLimits/read 返回格式无法识别"), updatedAt: now };
  // 多个计量桶时（rateLimitsByLimitId）逐个列出；默认的 codex 桶排第一且不单独命名
  const byId = isRecord(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : null;
  const snapshots = (byId ? Object.values(byId) : [response.rateLimits]).filter(isRecord);
  if (snapshots.length === 0 && isRecord(response.rateLimits)) snapshots.push(response.rateLimits);
  snapshots.sort((a, b) => Number(b.limitId === "codex") - Number(a.limitId === "codex"));
  const groups: QuotaGroup[] = [];
  let plan: string | undefined;
  for (const snapshot of snapshots) {
    const windows = codexWindows(snapshot);
    if (typeof snapshot.planType === "string" && snapshot.planType !== "unknown") plan ??= snapshot.planType;
    if (windows.length === 0) continue;
    const name =
      snapshot.limitId === "codex" || snapshot.limitId == null
        ? undefined
        : typeof snapshot.limitName === "string" && snapshot.limitName
          ? snapshot.limitName
          : String(snapshot.limitId);
    groups.push({ ...(name ? { name } : {}), windows });
  }
  if (groups.length > 1 && !groups[0]!.name) groups[0] = { name: "Codex", windows: groups[0]!.windows };
  return { agent: "codex", status: "ok", ...(plan ? { plan } : {}), groups, updatedAt: now };
}

// ───────────────────────── Antigravity ─────────────────────────

/** stdout 可能夹带日志行，取最后一个能解析的 JSON 对象行。 */
function lastJsonLine(stdout: string): JsonRecord | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value: unknown = JSON.parse(lines[i]!);
      if (isRecord(value)) return value;
    } catch {
      // 继续找上一行
    }
  }
  return null;
}

/** 参数是 `agy -p /quota --output-format json` 的 stdout。 */
export function agyQuota(stdout: string, now = Date.now()): AgentQuota {
  const result = lastJsonLine(stdout);
  const data = isRecord(result?.command) && isRecord(result.command.data) ? result.command.data : null;
  if (!result || !data || !Array.isArray(data.groups)) {
    const detail = typeof result?.response === "string" && result.response.trim() ? result.response.trim() : stdout.trim();
    return { ...quotaError("agy", detail || "agy /quota 没有返回额度数据"), updatedAt: now };
  }
  const groups: QuotaGroup[] = [];
  for (const group of data.groups.filter(isRecord)) {
    const windows: QuotaWindow[] = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : []) {
      if (bucket.disabled === true || typeof bucket.remaining_fraction !== "number") continue;
      const kind: QuotaWindowKind = bucket.window === "5h" ? "5h" : bucket.window === "weekly" ? "weekly" : "other";
      const label =
        kind === "5h" ? "5 小时" : kind === "weekly" ? "每周" : typeof bucket.name === "string" ? bucket.name : "额度";
      windows.push(makeWindow(kind, label, (1 - bucket.remaining_fraction) * 100, isoTime(bucket.reset_time)));
    }
    if (windows.length === 0) continue;
    groups.push({ ...(typeof group.name === "string" && group.name ? { name: group.name } : {}), windows: sortWindows(windows) });
  }
  return { agent: "agy", status: "ok", groups, updatedAt: now };
}

// ───────────────────────── GLM Coding Plan ─────────────────────────

/** unit：3 = 小时、5 = 月、6 = 周；TOKENS_LIMIT（团队版叫 CREDIT_LIMIT）是模型额度，TIME_LIMIT 是工具调用额度。 */
function glmWindowLabel(type: unknown, unit: unknown, number: unknown): [QuotaWindowKind, string] {
  const count = typeof number === "number" ? number : 1;
  const tool = type === "TIME_LIMIT";
  const prefix = tool ? "工具调用 · " : "";
  if (!tool && unit === 3 && count === 5) return ["5h", "5 小时"];
  if (!tool && unit === 6 && count === 1) return ["weekly", "每周"];
  if (unit === 3) return ["other", `${prefix}${count} 小时`];
  if (unit === 6) return ["other", `${prefix}${count === 1 ? "每周" : `${count} 周`}`];
  if (unit === 5) return ["other", `${prefix}${count === 1 ? "每月" : `${count} 个月`}`];
  return ["other", tool ? "工具调用" : "额度"];
}

/** 参数是 quota/limit 接口的完整响应体。 */
export function glmQuota(response: unknown, now = Date.now()): AgentQuota {
  const data = isRecord(response) && isRecord(response.data) ? response.data : null;
  if (!data || !Array.isArray(data.limits)) {
    const message = isRecord(response) && typeof response.msg === "string" ? response.msg : "quota/limit 返回格式无法识别";
    return { ...quotaError("glm", message), updatedAt: now };
  }
  const windows: QuotaWindow[] = [];
  for (const limit of data.limits.filter(isRecord)) {
    if (typeof limit.percentage !== "number") continue;
    const [kind, label] = glmWindowLabel(limit.type, limit.unit, limit.number);
    const resetsAt = typeof limit.nextResetTime === "number" ? limit.nextResetTime : undefined;
    windows.push(makeWindow(kind, label, limit.percentage, resetsAt));
  }
  const plan = typeof data.level === "string" && data.level ? data.level : undefined;
  return {
    agent: "glm",
    status: "ok",
    ...(plan ? { plan } : {}),
    groups: windows.length ? [{ windows: sortWindows(windows) }] : [],
    updatedAt: now,
  };
}
