import type { Config } from "../config";

export type CapabilityState = "enabled" | "disabled" | "degraded";

export interface CapabilityStatus {
  state: CapabilityState;
  detail: string;
}

export type CapabilityReport = Record<
  "primaryAi" | "fallbackAi" | "embeddings" | "earnings" | "supabase" | "slack" | "email",
  CapabilityStatus
>;

export function getCapabilityReport(config: Config): CapabilityReport {
  const smtpConfigured = Boolean(config.app.smtpUser && config.app.smtpPass);
  const smtpPartiallyConfigured = Boolean(config.app.smtpUser || config.app.smtpPass);

  return {
    primaryAi: { state: "enabled", detail: `${config.ai.provider}/${config.ai.model}` },
    fallbackAi: config.ai.fallback
      ? { state: "enabled", detail: config.ai.fallback.model }
      : { state: "disabled", detail: "not configured" },
    embeddings: config.ai.embeddingApiKey
      ? { state: "enabled", detail: config.ai.embeddingModel }
      : { state: "disabled", detail: "no embedding key" },
    earnings: config.app.roicAiApiKey
      ? { state: "enabled", detail: "Roic.ai" }
      : { state: "disabled", detail: "no Roic.ai key" },
    supabase: config.app.supabaseUrl && config.app.supabaseServiceKey
      ? { state: "enabled", detail: "configured" }
      : { state: "disabled", detail: "not configured" },
    slack: config.app.slackWebhookUrl
      ? { state: "enabled", detail: "configured" }
      : { state: "disabled", detail: "not configured" },
    email: smtpConfigured
      ? {
          state: "enabled",
          detail: config.app.digestEmailTo
            ? "SMTP and default recipient configured"
            : "SMTP configured for per-user recipients",
        }
      : smtpPartiallyConfigured || config.app.digestEmailTo
        ? { state: "degraded", detail: "incomplete SMTP configuration" }
        : { state: "disabled", detail: "not configured" },
  };
}

export function degradedCapabilities(report: CapabilityReport): string[] {
  return Object.entries(report)
    .filter(([, status]) => status.state === "degraded")
    .map(([name]) => name);
}

export function formatCapabilityReport(report: CapabilityReport): string {
  return Object.entries(report)
    .map(([name, status]) => `${name}=${status.state} (${status.detail})`)
    .join(", ");
}
