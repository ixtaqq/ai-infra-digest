import { config } from "../config";
import { logger } from "./logger";
import type { PriceWatch } from "./price-watch";

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
  bear_case?: string;
  embedding?: number[];
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
  /** Controls article summary verbosity in the personalised digest */
  digest_length?: "brief" | "standard" | "detailed";
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
    const prefer = params?.includes("on_conflict")
      ? "return=minimal,resolution=merge-duplicates"
      : "return=minimal";
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "apikey": cfg.key,
        "Authorization": `Bearer ${cfg.key}`,
        "Prefer": prefer,
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

  /**
   * Generic REST SELECT. `params` is the PostgREST query string (caller is
   * responsible for encoding values with encodeURIComponent where needed).
   * Returns [] when unconfigured or on any error — never throws.
   */
  async queryRows<T>(table: string, params: string): Promise<T[]> {
    const cfg = getConfig();
    if (!cfg) return [];
    try {
      const response = await fetch(`${cfg.url}/rest/v1/${table}?${params}`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      });
      if (!response.ok) {
        logger.warn(`Supabase query ${table}: ${response.status}`);
        return [];
      }
      return (await response.json()) as T[];
    } catch (error) {
      logger.warn(`Supabase query ${table}: ${(error as Error).message}`);
      return [];
    }
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

  async insertArticles(
    digestRunId: number,
    articles: ArticleData[]
  ): Promise<{ id: number; url: string }[]> {
    if (!articles.length) return [];
    const cfg = getConfig();
    if (!cfg) return [];

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
      bear_case: a.bear_case || null,
      embedding: a.embedding ?? null,
    }));

    const inserted: { id: number; url: string }[] = [];

    // Insert in chunks of 20, requesting id+url back for validation buttons
    for (let i = 0; i < records.length; i += 20) {
      const chunk = records.slice(i, i + 20);
      try {
        const res = await fetch(
          `${cfg.url}/rest/v1/articles?select=id,url`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "apikey": cfg.key,
              "Authorization": `Bearer ${cfg.key}`,
              "Prefer": "return=representation",
            },
            body: JSON.stringify(chunk),
          }
        );
        if (res.ok || res.status === 201) {
          const rows = (await res.json()) as { id: number; url: string }[];
          inserted.push(...rows);
        } else {
          logger.warn(`Supabase insertArticles chunk: HTTP ${res.status}`);
        }
      } catch (err) {
        logger.warn(`Supabase insertArticles: ${(err as Error).message}`);
      }
    }

    logger.info(`Supabase: inserted ${inserted.length}/${records.length} articles for run #${digestRunId}`);
    return inserted;
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

  /** Upsert weekly bull/bear thesis snapshots (v10), keyed by ticker. */
  async upsertTickerTheses(
    theses: { ticker: string; bull_case: string; bear_case: string; confidence: number; key_drivers: string[] }[]
  ): Promise<boolean> {
    if (!theses.length) return true;
    return supabaseFetch(
      "POST",
      "ticker_theses",
      theses.map((t) => ({ ...t, updated_at: new Date().toISOString() })),
      "on_conflict=ticker"
    );
  },

  /**
   * Append this week's thesis snapshots to the history table (v11), keyed by
   * (ticker, week_of). Independent of upsertTickerTheses — a failure here is
   * logged and does not affect the latest-only ticker_theses write. A re-run
   * for the same week overwrites that week's row rather than erroring or
   * duplicating (insert-or-overwrite-per-week, not append-only).
   */
  async insertTickerThesisHistory(
    theses: { ticker: string; bull_case: string; bear_case: string; confidence: number; key_drivers: string[] }[],
    weekOf: string
  ): Promise<boolean> {
    if (!theses.length) return true;
    return supabaseFetch(
      "POST",
      "ticker_thesis_history",
      theses.map((t) => ({ ...t, week_of: weekOf })),
      "on_conflict=ticker,week_of"
    );
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
        `${cfg.url}/rest/v1/user_preferences?chat_id=eq.${encodeURIComponent(chatId)}&select=*`,
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
   * Atomically reserve the (chat_id, run_date) delivery slot before sending.
   * Inserts a placeholder row and relies on the table's UNIQUE(chat_id, run_date)
   * constraint plus `resolution=ignore-duplicates` to make the reservation
   * race-free at the database level: only the first caller for a given user+date
   * gets a non-empty response back. Callers MUST NOT send the digest unless this
   * returns true — this closes the TOCTOU gap where two overlapping scheduler
   * runs both pass a read-only "already delivered?" check before either has
   * written anything (the whole digest-generation pipeline runs in between).
   */
  async claimUserDelivery(chatId: number, runDate: string): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg) return true; // Not configured — nothing to guard against, let the caller proceed.

    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/user_delivery_log?on_conflict=chat_id,run_date`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
            "Prefer": "return=representation,resolution=ignore-duplicates",
          },
          body: JSON.stringify({
            chat_id: chatId,
            run_date: runDate,
            status: "failed", // Conservative placeholder — overwritten by logUserDelivery once the send resolves.
            details: "claimed — send in progress",
          }),
        }
      );
      if (!response.ok) return true; // Fail open on infra errors — best-effort guard, not a hard gate.
      const rows = (await response.json()) as unknown[];
      return rows.length > 0; // Non-empty = we won the race and inserted a fresh row.
    } catch {
      return true; // Fail open — see above.
    }
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
        `${cfg.url}/rest/v1/user_delivery_log?chat_id=eq.${encodeURIComponent(chatId)}&run_date=eq.${encodeURIComponent(runDate)}&status=eq.success&select=id&limit=1`,
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

  // ─── Earnings Transcripts ───────────────────────────

  async upsertEarningsTranscript(data: Record<string, unknown>): Promise<boolean> {
    const cfg = getConfig();
    if (!cfg) return false;
    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/earnings_transcripts?on_conflict=ticker,year,quarter`,
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
            segments: data.segments ? JSON.stringify(data.segments) : null,
            risks_mentioned: data.risks_mentioned || [],
            key_takeaways: data.key_takeaways || [],
            updated_at: new Date().toISOString(),
          }),
        }
      );
      return response.ok || response.status === 201;
    } catch (error) {
      logger.warn(`Supabase upsertEarningsTranscript: ${(error as Error).message}`);
      return false;
    }
  },

  async getEarningsTranscript(
    ticker: string,
    year: number,
    quarter: number
  ): Promise<Record<string, unknown> | null> {
    const cfg = getConfig();
    if (!cfg) return null;
    try {
      const response = await fetch(
        `${cfg.url}/rest/v1/earnings_transcripts?ticker=eq.${encodeURIComponent(ticker)}&year=eq.${encodeURIComponent(year)}&quarter=eq.${encodeURIComponent(quarter)}&select=*`,
        {
          headers: {
            "apikey": cfg.key,
            "Authorization": `Bearer ${cfg.key}`,
          },
        }
      );
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>[];
      return data?.[0] ?? null;
    } catch (error) {
      logger.warn(`Supabase getEarningsTranscript: ${(error as Error).message}`);
      return null;
    }
  },

  // ─── Price Watches (v12) ──────────────────────────────

  /** All active price watches, across every user — fetched once per generateDigest() run. */
  async getAllPriceWatches(): Promise<PriceWatch[]> {
    const cfg = getConfig();
    if (!cfg) return [];
    try {
      const response = await fetch(`${cfg.url}/rest/v1/price_watches?select=*`, {
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      });
      if (!response.ok) {
        logger.warn(`Supabase getAllPriceWatches: ${response.status}`);
        return [];
      }
      return (await response.json()) as PriceWatch[];
    } catch (error) {
      logger.warn(`Supabase getAllPriceWatches: ${(error as Error).message}`);
      return [];
    }
  },

  /**
   * Set or replace a watch. `on_conflict=chat_id,ticker` upserts — re-setting a
   * watch on a ticker the user already watches updates it in place instead of
   * creating a duplicate row.
   */
  async upsertPriceWatch(watch: {
    chat_id: number;
    ticker: string;
    threshold: number;
    direction: "above" | "below";
  }): Promise<boolean> {
    return supabaseFetch("POST", "price_watches", watch, "on_conflict=chat_id,ticker");
  },

  /** Clears a single user's watch on one ticker (the `/watch TICKER off` command). */
  async deletePriceWatch(chatId: number, ticker: string): Promise<boolean> {
    return supabaseFetch(
      "DELETE",
      "price_watches",
      undefined,
      `chat_id=eq.${chatId}&ticker=eq.${encodeURIComponent(ticker)}`
    );
  },

  /** Batch-clears watches by id, after their triggered notification has been sent. */
  async deletePriceWatchesByIds(ids: number[]): Promise<boolean> {
    if (!ids.length) return true;
    return supabaseFetch("DELETE", "price_watches", undefined, `id=in.(${ids.join(",")})`);
  },

  // ─── Command Usage (v13) ──────────────────────────────

  /**
   * Append one command-invocation row. Fire-and-forget durable usage log —
   * survives across ephemeral runner filesystems (unlike the NDJSON logs) so
   * feature-adoption questions can be answered with real data. Never throws;
   * a logging failure must never break the command the user actually ran.
   */
  async logCommandUsage(command: string, chatId: number): Promise<boolean> {
    return supabaseFetch("POST", "command_usage", { command, chat_id: chatId });
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
