import { describe, expect, it } from "vitest";
import { clineEnvironment, clineModelValue, configuredClineModels, parseClineModel, type ClineConfig } from "../cline/clineConfig.js";

const config: ClineConfig = {
  settings: { lastUsedProvider: "first", providers: {
    first: { settings: { provider: "first", apiKey: "first-secret", model: "same/model" } },
    second: { settings: { provider: "second", apiKey: "second-secret", model: "same/model" } },
    cline: { settings: { provider: "cline", model: "unused" } },
  } },
  catalog: { providers: {
    first: { provider: { name: "提供商一" }, models: { "same/model": { id: "same/model", name: "模型一" } } },
    second: { provider: { name: "提供商二" }, models: { "same/model": { id: "same/model", name: "模型二" } } },
  } },
};

describe("Cline 提供商与模型配置", () => {
  it("默认沿用 CLI 的最后提供商、凭据和模型，不修改原始环境", () => {
    const env = { PATH: "/bin" };
    expect(clineEnvironment(env, config)).toMatchObject({ provider: "first", modelId: "same/model", env: { CLINE_PROVIDER: "first", CLINE_API_KEY: "first-secret", CLINE_MODEL: "same/model" } });
    expect(env).toEqual({ PATH: "/bin" });
  });
  it("同名模型按提供商区分，切换时使用对应凭据；选项不包含密钥", () => {
    const models = configuredClineModels(config, {});
    expect(models.map((model) => model.label)).toEqual(["提供商一 · 模型一", "提供商二 · 模型二"]);
    expect(models[0]?.value).not.toBe(models[1]?.value);
    expect(JSON.stringify(models)).not.toContain("secret");
    expect(clineEnvironment({}, config, models[1]!.value)).toMatchObject({ provider: "second", modelId: "same/model", env: { CLINE_PROVIDER: "second", CLINE_API_KEY: "second-secret" } });
  });
  it("环境显式固定的提供商、密钥和默认模型优先，不能越过固定提供商", () => {
    const env = { CLINE_PROVIDER: "first", CLINE_API_KEY: "env-secret", CLINE_MODEL: "env-model" };
    expect(clineEnvironment(env, config).env).toMatchObject(env);
    expect(configuredClineModels(config, env)).toHaveLength(1);
    expect(() => clineEnvironment(env, config, clineModelValue("second", "same/model"))).toThrow("固定提供商");
    expect(clineEnvironment(env, config, clineModelValue("first", "chosen")).modelId).toBe("chosen");
  });
  it("OAuth 复用已有认证流程，保留旧的裸模型 ID", () => {
    const oauth: ClineConfig = { catalog: {}, settings: { lastUsedProvider: "openai-codex", providers: { "openai-codex": { settings: { auth: { accessToken: "oauth-token" }, model: "gpt" } } } } };
    const resolved = clineEnvironment({}, oauth);
    expect(resolved.authMethod).toBe("openai-codex");
    expect(resolved.env.CLINE_API_KEY).toBeUndefined();
    expect(clineEnvironment({}, config, "legacy-model")).toMatchObject({ provider: "first", modelId: "legacy-model" });
    expect(parseClineModel(clineModelValue("provider/name", "model/name"))).toEqual({ provider: "provider/name", model: "model/name" });
  });
});
