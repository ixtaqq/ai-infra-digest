/**
 * Configuration preflight. The default mode is local-only and never calls an
 * external service. Pass --network to authenticate against read-only endpoints;
 * it does not send messages, email, or model inference requests.
 */
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import path from "path";
import type { Config } from "../src/config";
import { formatCapabilityReport, getCapabilityReport } from "../src/utils/capabilities";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

let config: Config;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

function looksLikePlaceholder(value: string): boolean {
  return !value || value.includes("your_") || value.endsWith("...");
}

function localChecks(): CheckResult[] {
  const checks: CheckResult[] = [
    {
      name: "Telegram configuration",
      ok: !looksLikePlaceholder(config.telegram.botToken) && Boolean(config.telegram.chatId),
      detail: "bot token and chat ID are set",
    },
    {
      name: "Primary AI configuration",
      ok: !looksLikePlaceholder(config.ai.apiKey) &&
        (config.ai.provider !== "custom" || Boolean(config.ai.baseUrl)),
      detail: `${config.ai.provider}/${config.ai.model}`,
    },
    {
      name: "Supabase configuration",
      ok: Boolean(config.app.supabaseUrl) === Boolean(config.app.supabaseServiceKey),
      detail: config.app.supabaseUrl ? "URL and service key are set" : "intentionally disabled",
    },
  ];

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.app.timezone });
    checks.push({ name: "Timezone", ok: true, detail: config.app.timezone });
  } catch {
    checks.push({ name: "Timezone", ok: false, detail: `invalid timezone: ${config.app.timezone}` });
  }

  const report = getCapabilityReport(config);
  checks.push({
    name: "Email configuration",
    ok: report.email.state !== "degraded",
    detail: report.email.detail,
  });
  return checks;
}

async function fetchCheck(
  name: string,
  url: string,
  headers: Record<string, string>
): Promise<CheckResult> {
  try {
    const response = await fetch(url, { headers });
    return { name, ok: response.ok, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.name : "network error",
    };
  }
}

async function networkChecks(): Promise<CheckResult[]> {
  const checks: Promise<CheckResult>[] = [];
  checks.push(fetchCheck(
    "Telegram authentication",
    `https://api.telegram.org/bot${config.telegram.botToken}/getMe`,
    {}
  ));

  if (config.ai.baseUrl) {
    checks.push(fetchCheck(
      "Primary AI authentication",
      `${config.ai.baseUrl.replace(/\/$/, "")}/models`,
      { Authorization: `Bearer ${config.ai.apiKey}` }
    ));
  }

  if (config.ai.embeddingApiKey) {
    checks.push(fetchCheck(
      "Embedding authentication",
      `https://api.openai.com/v1/models/${encodeURIComponent(config.ai.embeddingModel)}`,
      { Authorization: `Bearer ${config.ai.embeddingApiKey}` }
    ));
  }

  if (config.app.supabaseUrl && config.app.supabaseServiceKey) {
    checks.push(fetchCheck(
      "Supabase authentication",
      `${config.app.supabaseUrl}/rest/v1/digest_runs?select=id&limit=1`,
      {
        apikey: config.app.supabaseServiceKey,
        Authorization: `Bearer ${config.app.supabaseServiceKey}`,
      }
    ));
  }

  const results = await Promise.all(checks);
  if (config.app.smtpUser && config.app.smtpPass) {
    try {
      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 587,
        secure: false,
        auth: { user: config.app.smtpUser, pass: config.app.smtpPass },
      });
      await transport.verify();
      results.push({ name: "SMTP authentication", ok: true, detail: "verified without sending" });
    } catch (error) {
      const code = (error as { code?: string }).code || "authentication failed";
      results.push({ name: "SMTP authentication", ok: false, detail: code });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const missing = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "AI_API_KEY"]
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    for (const name of missing) console.log(`FAIL  Required variable: ${name} is not set`);
    process.exitCode = 1;
    return;
  }

  config = (await import("../src/config")).config;
  console.log(`Capabilities: ${formatCapabilityReport(getCapabilityReport(config))}`);
  const checks = localChecks();
  if (process.argv.includes("--network")) checks.push(...await networkChecks());

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Preflight failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exitCode = 1;
});
