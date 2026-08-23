import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import {
  degradedCapabilities,
  formatCapabilityReport,
  getCapabilityReport,
} from "./capabilities";

function makeConfig(): Config {
  return {
    scope: "daily",
    telegram: { botToken: "telegram-secret", chatId: "1", mode: "send-only" },
    ai: {
      provider: "openrouter",
      apiKey: "ai-secret",
      model: "strong-model",
      fastModel: "fast-model",
      embeddingApiKey: "embedding-secret",
      embeddingModel: "embedding-model",
      fallback: { apiKey: "fallback-secret", model: "fallback-model", fastModel: "fallback-fast" },
    },
    app: {
      timezone: "UTC",
      cacheDir: ".",
      maxArticlesPerSource: 5,
      maxArticlesForAI: 35,
      supabaseUrl: "https://example.supabase.co",
      supabaseServiceKey: "supabase-secret",
      roicAiApiKey: "roic-secret",
      slackWebhookUrl: "https://hooks.slack.test/secret",
      smtpUser: "sender@example.com",
      smtpPass: "smtp-secret",
      digestEmailTo: "reader@example.com",
      budgetDailyUsd: 0.5,
      budgetMonthlyUsd: 5,
    },
  };
}

describe("capability reporting", () => {
  it("reports configured optional stages without exposing credentials", () => {
    const report = getCapabilityReport(makeConfig());
    const formatted = formatCapabilityReport(report);

    expect(report.embeddings.state).toBe("enabled");
    expect(report.fallbackAi.state).toBe("enabled");
    expect(report.email.state).toBe("enabled");
    expect(formatted).not.toContain("secret");
  });

  it("marks partial email configuration as degraded", () => {
    const config = makeConfig();
    config.app.smtpPass = undefined;

    const report = getCapabilityReport(config);

    expect(report.email.state).toBe("degraded");
    expect(degradedCapabilities(report)).toEqual(["email"]);
  });

  it("treats SMTP without a global recipient as ready for per-user email copies", () => {
    const config = makeConfig();
    config.app.digestEmailTo = undefined;

    const report = getCapabilityReport(config);

    expect(report.email).toEqual({
      state: "enabled",
      detail: "SMTP configured for per-user recipients",
    });
  });
});
