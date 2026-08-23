import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const DEFAULT_BUDGET_DAILY_USD = 0.5;
const DEFAULT_BUDGET_MONTHLY_USD = 5.0;
const DEFAULT_MAX_ARTICLES_FOR_AI = 35;

/** The process boundary that is loading configuration. */
export type ConfigScope = "daily" | "scheduler" | "webhook";

/** How the Telegram client is allowed to receive updates. */
export type TelegramMode = "send-only" | "polling" | "webhook";

export interface ConfigLoadOptions {
  scope?: ConfigScope;
  /** Override the default mode for an explicitly loaded process boundary. */
  telegramMode?: TelegramMode;
}

export interface Config {
  scope: ConfigScope;
  telegram: {
    botToken: string;
    chatId: string;
    mode: TelegramMode;
  };
  ai: {
    provider: "groq" | "openai" | "openrouter" | "custom";
    apiKey: string;
    model: string;              // Strong model for synthesis (default: openai/gpt-oss-120b)
    fastModel: string;          // Fast/cheap model for classification (default: openai/gpt-oss-20b)
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

function optionalEnv(name: string): string {
  return process.env[name] || "";
}

function detectConfigScope(): ConfigScope {
  const configured = process.env.CONFIG_SCOPE || process.env.RUNTIME_SCOPE;
  if (configured === "daily" || configured === "scheduler" || configured === "webhook") {
    return configured;
  }
  if (configured) {
    throw new Error(
      `Invalid CONFIG_SCOPE: "${configured}". Must be one of: daily, scheduler, webhook`
    );
  }

  // npm run scheduler uses tsx, so process.argv[1] is the tsx launcher and
  // the source entry point is later in argv. The built workflows invoke the
  // JavaScript entry point directly. Looking for the exact filename supports
  // both without requiring every caller to set another environment variable.
  const args = process.argv.slice(1);
  if (args.some((arg) => /(?:^|[\\/])scheduler\.(?:ts|m?js)$/.test(arg))) {
    return "scheduler";
  }
  if (args.some((arg) => /(?:^|[\\/])webhook\.(?:ts|m?js)$/.test(arg))) {
    return "webhook";
  }
  return "daily";
}

function parseTelegramMode(scope: ConfigScope, override?: TelegramMode): TelegramMode {
  // These entry points are never allowed to receive updates by long polling.
  // An accidental shared TELEGRAM_MODE=polling must not change that contract.
  if (scope === "webhook") return "webhook";
  if (scope === "scheduler") return "send-only";

  const sourceEntryPoint = process.argv.some((arg) => /(?:^|[\\/])src[\\/]index\.ts$/.test(arg));
  // The compiled daily workflow is send-only by contract. TELEGRAM_MODE is
  // intentionally honored only for the local source entry point, preserving
  // polling for `tsx src/index.ts` without making production configurable into
  // a long-polling process.
  if (!sourceEntryPoint && override === undefined) return "send-only";

  const raw = override || process.env.TELEGRAM_MODE || process.env.TELEGRAM_BOT_MODE;
  if (raw === "send-only" || raw === "polling" || raw === "webhook") {
    return raw;
  }
  if (raw) {
    throw new Error(
      `Invalid TELEGRAM_MODE: "${raw}". Must be one of: send-only, polling, webhook`
    );
  }

  // Keep `npm run dev` useful for local interactive development. Built daily
  // workflow runs are send-only because their entry point is not an interactive
  // bot process and must never start long polling.
  return "polling";
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

export function loadConfig(scope?: ConfigScope): Config;
export function loadConfig(options?: ConfigLoadOptions): Config;
export function loadConfig(options: ConfigScope | ConfigLoadOptions = {}): Config {
  const scope = typeof options === "string"
    ? options
    : options.scope || detectConfigScope();
  const telegramMode = typeof options === "string" ? undefined : options.telegramMode;
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
    scope,
    telegram: {
      botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
      // A scheduler fans out to user chat IDs from Supabase and has no default
      // chat. Webhook mode likewise only replies to the incoming chat. Keep an
      // empty value in the public shape so existing consumers remain typed as
      // strings while scoped validation still fails fast for daily runs.
      chatId: scope === "scheduler" || scope === "webhook"
        ? optionalEnv("TELEGRAM_CHAT_ID")
        : requireEnv("TELEGRAM_CHAT_ID"),
      mode: parseTelegramMode(scope, telegramMode),
    },
    ai: {
      provider,
      // Scheduled delivery reads a canonical publication and never invokes AI.
      // It must therefore be able to boot with no AI_API_KEY at all.
      apiKey: scope === "scheduler" ? optionalEnv("AI_API_KEY") : requireEnv("AI_API_KEY"),
      model: process.env.AI_MODEL || "openai/gpt-oss-120b",
      fastModel: process.env.AI_FAST_MODEL || "openai/gpt-oss-20b",
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

export function loadPipelineConfig(): Config {
  return loadConfig("daily");
}

export function loadSchedulerConfig(): Config {
  return loadConfig("scheduler");
}

export function loadWebhookConfig(): Config {
  return loadConfig("webhook");
}

const detectedScope = detectConfigScope();

export const config = detectedScope === "scheduler"
  ? loadSchedulerConfig()
  : detectedScope === "webhook"
    ? loadWebhookConfig()
    : loadPipelineConfig();
