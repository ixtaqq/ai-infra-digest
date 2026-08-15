import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_BUDGET_DAILY_USD = 0.5;
const DEFAULT_BUDGET_MONTHLY_USD = 5.0;
const DEFAULT_MAX_ARTICLES_FOR_AI = 35;

export interface Config {
  telegram: {
    botToken: string;
    chatId: string;
  };
  ai: {
    provider: "groq" | "openai" | "openrouter" | "custom";
    apiKey: string;
    model: string;              // Strong model for synthesis (default: llama-3.3-70b-versatile)
    fastModel: string;          // Fast/cheap model for classification (default: llama-3.1-8b-instant)
    baseUrl?: string;
    embeddingApiKey: string;
    embeddingModel: string;
    /** Optional secondary provider used when the primary fails after all retries. */
    fallback?: {
      apiKey: string;
      model: string;
      fastModel: string;
      baseUrl?: string;
    };
  };
  app: {
    timezone: string;
    cacheDir: string;
    maxArticlesPerSource: number;
    /** Maximum number of deduplicated articles sent to the AI per run. */
    maxArticlesForAI: number;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    roicAiApiKey?: string;
    slackWebhookUrl?: string;
    smtpUser?: string;
    smtpPass?: string;
    digestEmailTo?: string;
    /** Max AI spend per day in USD before an alert is sent (default: $0.50) */
    budgetDailyUsd: number;
    /** Max AI spend per month in USD before an alert is sent (default: $5.00) */
    budgetMonthlyUsd: number;
  };
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `Copy .env.example to .env and fill in the values.`
    );
  }
  return val;
}

function parseBudgetUsd(raw: string | undefined, fallback: number): number {
  const value = raw?.trim();
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  // Invalid negative caps fail closed instead of disabling the budget gate.
  return Math.max(0, parsed);
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 100);
}

function loadConfig(): Config {
  const provider =
    (process.env.AI_PROVIDER as Config["ai"]["provider"]) || "groq";

  const validProviders = ["groq", "openai", "openrouter", "custom"];
  if (!validProviders.includes(provider)) {
    throw new Error(
      `Invalid AI_PROVIDER: "${provider}". Must be one of: ${validProviders.join(", ")}`
    );
  }

  const baseUrls: Record<string, string> = {
    groq: "https://api.groq.com/openai/v1",
    openai: "https://api.openai.com/v1",
    openrouter: "https://openrouter.ai/api/v1",
  };

  return {
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      chatId: requireEnv("TELEGRAM_CHAT_ID"),
    },
    ai: {
      provider,
      apiKey: requireEnv("AI_API_KEY"),
      model: process.env.AI_MODEL || "llama-3.3-70b-versatile",
      fastModel: process.env.AI_FAST_MODEL || "llama-3.1-8b-instant",
      baseUrl: baseUrls[provider] || process.env.AI_BASE_URL,
      embeddingApiKey: process.env.OPENAI_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || "",
      embeddingModel: "text-embedding-3-small",
      fallback: process.env.AI_FALLBACK_API_KEY
        ? {
            apiKey: process.env.AI_FALLBACK_API_KEY,
            model: process.env.AI_FALLBACK_MODEL || "gpt-4o-mini",
            fastModel: process.env.AI_FALLBACK_FAST_MODEL || process.env.AI_FALLBACK_MODEL || "gpt-4o-mini",
            baseUrl: process.env.AI_FALLBACK_BASE_URL || baseUrls[process.env.AI_FALLBACK_PROVIDER || "openai"],
          }
        : undefined,
    },
    app: {
      timezone: process.env.TZ || "Asia/Kuala_Lumpur",
      cacheDir: path.resolve(__dirname, "../.cache"),
      maxArticlesPerSource: 5,
      maxArticlesForAI: parsePositiveInteger(process.env.MAX_ARTICLES_FOR_AI, DEFAULT_MAX_ARTICLES_FOR_AI),
      supabaseUrl: process.env.SUPABASE_URL || undefined,
      supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || undefined,
      roicAiApiKey: process.env.ROIC_AI_API_KEY || undefined,
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
      smtpUser: process.env.SMTP_USER || undefined,
      smtpPass: process.env.SMTP_PASS || undefined,
      digestEmailTo: process.env.DIGEST_EMAIL_TO || undefined,
      budgetDailyUsd: parseBudgetUsd(process.env.AI_BUDGET_DAILY_USD, DEFAULT_BUDGET_DAILY_USD),
      budgetMonthlyUsd: parseBudgetUsd(process.env.AI_BUDGET_MONTHLY_USD, DEFAULT_BUDGET_MONTHLY_USD),
    },
  };
}

export const config = loadConfig();
