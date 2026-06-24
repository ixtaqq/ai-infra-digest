import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

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
  };
  app: {
    timezone: string;
    cacheDir: string;
    maxArticlesPerSource: number;
    supabaseUrl?: string;
    supabaseServiceKey?: string;
    roicAiApiKey?: string;
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
    },
    app: {
      timezone: process.env.TZ || "Asia/Kuala_Lumpur",
      cacheDir: path.resolve(__dirname, "../.cache"),
      maxArticlesPerSource: 5,
      supabaseUrl: process.env.SUPABASE_URL || undefined,
      supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || undefined,
      roicAiApiKey: process.env.ROIC_AI_API_KEY || undefined,
      budgetDailyUsd: parseFloat(process.env.AI_BUDGET_DAILY_USD || "0.50"),
      budgetMonthlyUsd: parseFloat(process.env.AI_BUDGET_MONTHLY_USD || "5.00"),
    },
  };
}

export const config = loadConfig();
