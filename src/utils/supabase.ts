import { config } from "../config";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────
export interface DigestRunData {
  run_date: string;
  status: "running" | "success" | "failed";
  articles_collected: number;
  articles_processed: number;
  batches_run: number;
  ai_provider: string;
  ai_model: string;
  ai_fast_model?: string;
  total_tokens_used: number;
  duration_seconds: number;
  error_message?: string;
}

export interface ArticleData {
  title: string;
  url?: string;
  source?: string;
  impact?: string;
  impact_score?: number;
  category?: string;
  affected_stocks?: string[];
  summary?: string;
  reason?: string;
  is_sec_filing?: boolean;
}

export interface SectorActivityData {
  sector: string;
  article_count: number;
  avg_impact_score: number;
  bullish_count: number;
  bearish_count: number;
  neutral_count: number;
}

export interface StockMentionData {
  ticker: string;
  mention_count: number;
  avg_sentiment: number;
  avg_impact_score: number;
  price?: number;
  price_change_percent?: number;
}

export interface PipelineHealthData {
  feed_name: string;
  feed_url?: string;
  status: "success" | "failed";
  articles_fetched: number;
  error_message?: string;
  response_time_ms?: number;
}

export interface CapexData {
  company: string;
  amount?: string;
  description?: string;
  category?: string;
  source_url?: string;
  source_name?: string;
}

export interface UserPreferencesData {
  chat_id: number;
  username?: string;
  first_name?: string;
  watchlist?: string[];
  preferred_time?: string;
  timezone?: string;
  categories_enabled?: string[];
  min_impact_score?: number;
  alerts_enabled?: boolean;
  alerts_min_score?: number;
  is_active?: boolean;
}

export interface AIUsageData {
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_estimated: number;
}

export interface StockPriceData {
  date: string;
  ticker: string;
  price?: number;
  change?: number;
  change_percent?: number;
  previous_close?: number;
}

export interface FeedStatus {
  name: string;
  url: string;
  status: "success" | "failed";
  articlesFetched: number;
  error?: string;
}

// ─── Supabase REST Helpers ────────────────────────────
function getConfig() {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  return url && key ? { url, key } : null;
}

async function supabaseFetch(
  method: string,
  table: string,
  body?: unknown,
  params?: string
): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg) return false;

  let url = `${cfg.url}/rest/v1/${table}`;
  if (params) url += `?${params}`;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.key,
        "Authorization": `Bearer ${cfg.key}`,
        "Prefer": "return=minimal",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok && response.status !== 201) {
      logger.warn(`Supabase ${method} ${table}: ${response.status}`);
      return false;
    }
    return true;
  } catch (error) {
    logger.warn(`Supabase ${table}: ${(error as Error).message}`);
    return false;
  }
}

// ─── Public API ────────────────────────────────────────
export const supabase = {
  isConfigured(): boolean {
    return !!getConfig();
  },

  async createDigestRun(data: DigestRunData): Promise<number | null> {
    const cfg = getConfig();
    if (!cfg) return null;

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/digest_runs?select=id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
            "Prefer": "return=representation",
          },
          body: JSON.stringify(data),
        }
      );

      if (!response.ok) {
        logger.warn(`Supabase createDigestRun: ${response.status}`);
        return null;
      }

      const jsonData = (await response.json()) as Record<string, unknown>[] | Record<string, unknown>;
      const created = Array.isArray(jsonData) ? jsonData[0] : jsonData;
      const idVal = (created && typeof created === "object" ? (created as Record<string, unknown>).id : null) as number | null;
      if (idVal) logger.info(`Supabase: created digest run #${idVal}`);
      return idVal;
    } catch (error) {
      logger.warn(`Supabase createDigestRun: ${(error as Error).message}`);
      return null;
    }
  },

  async insertArticles(digestRunId: number, articles: ArticleData[]): Promise<boolean> {
    if (!articles.length) return true;
    const cfg = getConfig();
    if (!cfg) return false;

    const records = articles.map((a) => ({
      digest_run_id: digestRunId,
      title: a.title,
      url: a.url || null,
      source: a.source || null,
      impact: a.impact || null,
      impact_score: a.impact_score || null,
      category: a.category || null,
      affected_stocks: a.affected_stocks || [],
      summary: a.summary || null,
      reason: a.reason || null,
    }));

    // Insert in chunks of 20 (Supabase REST limit)
    let success = true;
    for (let i = 0; i < records.length; i += 20) {
      const chunk = records.slice(i, i + 20);
      const ok = await supabaseFetch("POST", "articles", chunk);
      if (!ok) success = false;
    }
    logger.info(`Supabase: inserted ${records.length} articles for run #${digestRunId}`);
    return success;
  },

  async updateSectorActivity(
    date: string,
    sectors: SectorActivityData[]
  ): Promise<boolean> {
    let success = true;
    for (const sector of sectors) {
      const ok = await supabaseFetch(
        "POST",
        "sector_activity",
        { date, ...sector },
        `on_conflict=date,sector`
      );
      if (!ok) success = false;
    }
    return success;
  },

  async updateStockMentions(
    date: string,
    mentions: StockMentionData[]
  ): Promise<boolean> {
    let success = true;
    for (const mention of mentions) {
      const ok = await supabaseFetch(
        "POST",
        "stock_mentions",
        { date, ...mention },
        `on_conflict=date,ticker`
      );
      if (!ok) success = false;
    }
    return success;
  },

  async insertPipelineHealth(
    digestRunId: number,
    feeds: PipelineHealthData[]
  ): Promise<boolean> {
    let success = true;
    for (const feed of feeds) {
      const ok = await supabaseFetch("POST", "pipeline_health", {
        digest_run_id: digestRunId,
        ...feed,
      });
      if (!ok) success = false;
    }
    return success;
  },

  async insertCapex(entries: CapexData[]): Promise<boolean> {
    let success = true;
    for (const entry of entries) {
      const ok = await supabaseFetch("POST", "capex_tracking", entry);
      if (!ok) success = false;
    }
    return success;
  },

  async insertAIUsage(
    digestRunId: number,
    usage: AIUsageData
  ): Promise<boolean> {
    return supabaseFetch("POST", "ai_usage", {
      digest_run_id: digestRunId,
      ...usage,
    });
  },

  async updateDailyMetrics(
    date: string,
    metrics: Record<string, unknown>
  ): Promise<boolean> {
    return supabaseFetch(
      "POST",
      "daily_metrics",
      { date, ...metrics },
      "on_conflict=date"
    );
  },

  async insertStockPrices(prices: StockPriceData[]): Promise<boolean> {
    if (!prices.length) return true;
    let success = true;
    for (const price of prices) {
      const ok = await supabaseFetch(
        "POST",
        "stock_prices",
        price,
        `on_conflict=date,ticker`
      );
      if (!ok) success = false;
    }
    logger.info(`Supabase: stored ${prices.length} stock prices`);
    return success;
  },

  // ─── User Management ────────────────────────────────

  async upsertUserPreferences(
    data: UserPreferencesData
  ): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg) return false;

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/user_preferences?on_conflict=chat_id`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
            "Prefer": "return=minimal,resolution=merge-duplicates",
          },
          body: JSON.stringify({
            ...data,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      return response.ok || response.status === 201;
    } catch (error) {
      logger.warn(`Supabase upsertUserPreferences: ${(error as Error).message}`);
      return false;
    }
  },

  async getUserPreferences(
    chatId: number
  ): Promise<UserPreferencesData | null> {
    const cfg = getConfig();
    if (!cfg) return null;

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/user_preferences?chat_id=eq.${chatId}&select=*`,
        {
          headers: {
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
          },
        }
      );
      if (!response.ok) return null;
      const data = (await response.json()) as UserPreferencesData[];
      return data?.[0] ?? null;
    } catch (error) {
      logger.warn(`Supabase getUserPreferences: ${(error as Error).message}`);
      return null;
    }
  },

  async getAllActiveUsers(): Promise<UserPreferencesData[]> {
    const cfg = getConfig();
    if (!cfg) return [];

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/user_preferences?is_active=eq.true&select=*`,
        {
          headers: {
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
          },
        }
      );
      if (!response.ok) return [];
      return (await response.json()) as UserPreferencesData[];
    } catch (error) {
      logger.warn(`Supabase getAllActiveUsers: ${(error as Error).message}`);
      return [];
    }
  },

  // ─── User Delivery Log ────────────────────────────

  /**
   * Log that a digest was delivered to a user for a given date.
   * Returns true if logged successfully.
   */
  async logUserDelivery(
    chatId: number,
    runDate: string,
    status: "success" | "failed",
    details?: string
  ): Promise<boolean> {
    // Use upsert with on_conflict to handle race conditions from overlapping cron runs
    return supabaseFetch(
      "POST",
      "user_delivery_log",
      {
        chat_id: chatId,
        run_date: runDate,
        status,
        details,
      },
      "on_conflict=chat_id,run_date"
    );
  },

  /**
   * Check if a user was already successfully delivered today.
   * Returns true if a successful delivery record exists for this user+date.
   */
  async wasUserDeliveredToday(
    chatId: number,
    runDate: string
  ): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg) return false;

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/user_delivery_log?chat_id=eq.${chatId}&run_date=eq.${runDate}&status=eq.success&select=id&limit=1`,
        {
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
        }
      );
      if (!response.ok) return false;
      const data = (await response.json()) as { id: number }[];
      return data.length > 0;
    } catch {
      return false;
    }
  },

  // Quick helper to check if the database is reachable
  async healthCheck(): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg) return false;
    try {
      const response = await fetch(`${cfg.url}/rest/v1/digest_runs?limit=1`, {
        headers: {
          "apikey": cfg.key,
          "Authorization": `Bearer ${cfg.key}`,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  },
};
