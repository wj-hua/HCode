import { describe, expect, it } from "vitest";
import { agyQuota, claudeQuota, codexQuota, glmQuota } from "../quota.js";

const NOW = Date.parse("2026-09-24T09:15:00Z");

describe("claudeQuota", () => {
  it("5 小时、每周和按模型的周额度", () => {
    const quota = claudeQuota(
      {
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-09-24T12:00:00Z" },
          seven_day: { utilization: 18.5, resets_at: "2026-09-29T00:00:00Z" },
          seven_day_oauth_apps: { utilization: 3, resets_at: null },
          seven_day_opus: null,
          seven_day_sonnet: { utilization: null, resets_at: null },
          model_scoped: [{ display_name: "Fable", utilization: 7, resets_at: "2026-09-29T00:00:00Z" }],
        },
      },
      NOW,
    );
    expect(quota).toEqual({
      agent: "claude",
      status: "ok",
      plan: "max",
      updatedAt: NOW,
      groups: [
        {
          windows: [
            { kind: "5h", label: "5 小时", usedPercent: 42, resetsAt: Date.parse("2026-09-24T12:00:00Z") },
            { kind: "weekly", label: "每周", usedPercent: 18.5, resetsAt: Date.parse("2026-09-29T00:00:00Z") },
            { kind: "weekly", label: "每周 · Fable", usedPercent: 7, resetsAt: Date.parse("2026-09-29T00:00:00Z") },
          ],
        },
      ],
    });
  });

  it("API key 登录没有订阅额度", () => {
    const quota = claudeQuota({ subscription_type: null, rate_limits_available: false, rate_limits: null }, NOW);
    expect(quota).toMatchObject({ agent: "claude", status: "unavailable", groups: [] });
  });
});

describe("codexQuota", () => {
  it("按窗口时长区分 5 小时和每周，resetsAt 是秒", () => {
    const quota = codexQuota(
      {
        rateLimits: {
          limitId: "codex",
          limitName: null,
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1790500000 },
          secondary: { usedPercent: 64, windowDurationMins: 300, resetsAt: 1790260000 },
          planType: "plus",
        },
        rateLimitsByLimitId: null,
      },
      NOW,
    );
    expect(quota).toEqual({
      agent: "codex",
      status: "ok",
      plan: "plus",
      updatedAt: NOW,
      groups: [
        {
          windows: [
            { kind: "5h", label: "5 小时", usedPercent: 64, resetsAt: 1790260000_000 },
            { kind: "weekly", label: "每周", usedPercent: 12, resetsAt: 1790500000_000 },
          ],
        },
      ],
    });
  });

  it("多个计量桶时默认桶排第一，其余按名称分组", () => {
    const quota = codexQuota(
      {
        rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } },
        rateLimitsByLimitId: {
          other: {
            limitId: "other",
            limitName: "GPT-5 Spark",
            primary: { usedPercent: 50, windowDurationMins: 1440, resetsAt: null },
            secondary: null,
            planType: "pro",
          },
          codex: {
            limitId: "codex",
            limitName: null,
            primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
            secondary: null,
            planType: "pro",
          },
        },
      },
      NOW,
    );
    expect(quota.groups).toEqual([
      { name: "Codex", windows: [{ kind: "5h", label: "5 小时", usedPercent: 1 }] },
      { name: "GPT-5 Spark", windows: [{ kind: "other", label: "1 天", usedPercent: 50 }] },
    ]);
    expect(quota.plan).toBe("pro");
  });
});

describe("agyQuota", () => {
  // agy -p "/quota" --output-format json 的真实输出
  const stdout = JSON.stringify({
    conversation_id: "",
    status: "SUCCESS",
    response:
      "Gemini Models\tWeekly Limit Remaining\t100%\t2026-09-30T10:29:21Z\nGemini Models\tFive Hour Limit Remaining\t100%\t2026-09-24T12:51:26Z\n",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    command: {
      name: "usage",
      data: {
        description: "Within each group, models share a weekly limit and a 5-hour limit.",
        groups: [
          {
            name: "Gemini Models",
            description: "Models within this group: Gemini Flash, Gemini Pro",
            buckets: [
              { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9955880045890808, reset_time: "2026-09-30T10:29:21Z" },
              { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.996843695640564, reset_time: "2026-09-24T12:51:26Z" },
            ],
          },
          {
            name: "Claude and GPT models",
            description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
            buckets: [
              { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-01T09:14:48Z" },
              { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-09-24T14:14:48Z" },
            ],
          },
        ],
      },
    },
  });

  it("按组换算成已用百分比，不用 response 里四舍五入的文字", () => {
    const quota = agyQuota(`some log line\n${stdout}\n`, NOW);
    expect(quota.status).toBe("ok");
    expect(quota.groups.map((group) => group.name)).toEqual(["Gemini Models", "Claude and GPT models"]);
    const [fiveHour, weekly] = quota.groups[0]!.windows;
    expect(weekly).toMatchObject({ kind: "weekly", label: "每周", resetsAt: Date.parse("2026-09-30T10:29:21Z") });
    expect(weekly!.usedPercent).toBeCloseTo(0.4412, 3);
    expect(fiveHour).toMatchObject({ kind: "5h", label: "5 小时" });
    expect(fiveHour!.usedPercent).toBeCloseTo(0.3156, 3);
    expect(quota.groups[1]!.windows.map((item) => item.usedPercent)).toEqual([0, 0]);
  });

  it("没有额度数据时返回错误和 agy 的说明", () => {
    const quota = agyQuota(JSON.stringify({ status: "ERROR", response: "Please log in first." }), NOW);
    expect(quota).toMatchObject({ agent: "agy", status: "error", message: "Please log in first.", groups: [] });
  });
});

describe("glmQuota", () => {
  it("5 小时、每周和每月工具调用", () => {
    const quota = glmQuota(
      {
        code: 200,
        success: true,
        data: {
          level: "lite",
          limits: [
            { type: "TIME_LIMIT", unit: 5, number: 1, usage: 100, currentValue: 10, percentage: 10, nextResetTime: 1790900000000 },
            { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 6852, percentage: 68, nextResetTime: 1790305715998 },
            { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 47, percentage: 2, nextResetTime: 1790287584022 },
          ],
        },
      },
      NOW,
    );
    expect(quota).toEqual({
      agent: "glm",
      status: "ok",
      plan: "lite",
      updatedAt: NOW,
      groups: [
        {
          windows: [
            { kind: "5h", label: "5 小时", usedPercent: 2, resetsAt: 1790287584022 },
            { kind: "weekly", label: "每周", usedPercent: 68, resetsAt: 1790305715998 },
            { kind: "other", label: "工具调用 · 每月", usedPercent: 10, resetsAt: 1790900000000 },
          ],
        },
      ],
    });
  });

  it("key 无效时显示接口的错误信息", () => {
    expect(glmQuota({ code: 401, msg: "令牌已过期或验证不正确", success: false }, NOW)).toMatchObject({
      agent: "glm",
      status: "error",
      message: "令牌已过期或验证不正确",
    });
  });
});
