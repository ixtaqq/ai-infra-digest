import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadConfigWithBudgets(daily: string, monthly: string) {
  vi.resetModules();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
  vi.stubEnv("AI_API_KEY", "test-key");
  vi.stubEnv("AI_PROVIDER", "groq");
  vi.stubEnv("AI_BUDGET_DAILY_USD", daily);
  vi.stubEnv("AI_BUDGET_MONTHLY_USD", monthly);

  const { config } = await import("./config");
  return config;
}

async function loadConfigWithArticleCap(raw: string) {
  vi.resetModules();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
  vi.stubEnv("AI_API_KEY", "test-key");
  vi.stubEnv("AI_PROVIDER", "groq");
  vi.stubEnv("MAX_ARTICLES_FOR_AI", raw);

  const { config } = await import("./config");
  return config;
}

async function loadSchedulerConfig() {
  vi.resetModules();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "");
  vi.stubEnv("AI_API_KEY", "");
  vi.stubEnv("CONFIG_SCOPE", "scheduler");

  const { config } = await import("./config");
  return config;
}

describe("configuration budget parsing", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accepts finite numeric values, including zero", async () => {
    const config = await loadConfigWithBudgets("0", "12.75");

    expect(config.app.budgetDailyUsd).toBe(0);
    expect(config.app.budgetMonthlyUsd).toBe(12.75);
  });

  it("clamps negative values to zero", async () => {
    const config = await loadConfigWithBudgets("-1", "-0.01");

    expect(config.app.budgetDailyUsd).toBe(0);
    expect(config.app.budgetMonthlyUsd).toBe(0);
  });

  it("falls back for malformed, partial, and non-finite values", async () => {
    const config = await loadConfigWithBudgets("0.5usd", "Infinity");

    expect(config.app.budgetDailyUsd).toBe(0.5);
    expect(config.app.budgetMonthlyUsd).toBe(5);
  });

  it("bounds the configurable AI article cap", async () => {
    await expect(loadConfigWithArticleCap("42")).resolves.toMatchObject({
      app: { maxArticlesForAI: 42 },
    });
    await expect(loadConfigWithArticleCap("101")).resolves.toMatchObject({
      app: { maxArticlesForAI: 100 },
    });
    await expect(loadConfigWithArticleCap("not-a-number")).resolves.toMatchObject({
      app: { maxArticlesForAI: 35 },
    });
  });
});

describe("scoped runtime configuration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("lets scheduled delivery boot without AI or a default Telegram chat", async () => {
    const config = await loadSchedulerConfig();

    expect(config.telegram).toMatchObject({
      botToken: "test-token",
      chatId: "",
      mode: "send-only",
    });
    expect(config.ai.apiKey).toBe("");
  });

  it("keeps scheduled delivery send-only even if polling is configured globally", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("CONFIG_SCOPE", "scheduler");
    vi.stubEnv("TELEGRAM_MODE", "polling");

    const { config } = await import("./config");

    expect(config.telegram.mode).toBe("send-only");
  });

  it("keeps daily runs strict about their pipeline and default-chat credentials", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "");
    vi.stubEnv("AI_API_KEY", "");
    vi.stubEnv("CONFIG_SCOPE", "daily");

    await expect(import("./config")).rejects.toThrow("TELEGRAM_CHAT_ID");
  });

  it("accepts explicit send-only, polling, and webhook modes", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    vi.stubEnv("AI_API_KEY", "test-key");
    const { loadConfig } = await import("./config");

    expect(loadConfig({ scope: "daily", telegramMode: "send-only" }).telegram.mode).toBe("send-only");
    expect(loadConfig({ scope: "daily", telegramMode: "polling" }).telegram.mode).toBe("polling");
    expect(loadConfig({ scope: "webhook", telegramMode: "webhook" }).telegram.mode).toBe("webhook");
  });

  it("initializes the exported config through the named pipeline loader", async () => {
    vi.resetModules();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("CONFIG_SCOPE", "daily");

    const { config, loadPipelineConfig } = await import("./config");

    expect(config.scope).toBe("daily");
    expect(loadPipelineConfig().scope).toBe("daily");
  });
});
