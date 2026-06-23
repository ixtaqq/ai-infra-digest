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
    model: string;
    baseUrl?: string;
  };
  app: {
    timezone: string;
    cacheDir: string;
    maxArticlesPerSource: number;
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
      baseUrl: baseUrls[provider] || process.env.AI_BASE_URL,
    },
    app: {
      timezone: process.env.TZ || "Asia/Kuala_Lumpur",
      cacheDir: path.resolve(__dirname, "../.cache"),
      maxArticlesPerSource: 5,
    },
  };
}

export const config = loadConfig();
