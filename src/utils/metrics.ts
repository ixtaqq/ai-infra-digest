import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";
import { config } from "../config";

// ─── Event Types ──────────────────────────────────────

export interface MetricsEvent {
  timestamp: string;
  event: string;
  [key: string]: unknown;
}

export interface FeedFetchEvent extends MetricsEvent {
  event: "feed_fetch";
  feed_name: string;
  feed_url: string;
  status: "success" | "failed" | "cached";
  articles_fetched: number;
  response_time_ms: number;
  cached: boolean;
  retry_attempt: number;
  error?: string;
}

export interface AIBatchEvent extends MetricsEvent {
  event: "ai_batch";
  batch_num: number;
  total_batches: number;
  article_count: number;
  tokens_used: number;
  duration_ms: number;
  status: "success" | "failed";
  error?: string;
}

export interface StockFetchEvent extends MetricsEvent {
  event: "stock_fetch";
  tickers_requested: number;
  tickers_succeeded: number;
  duration_ms: number;
  status: "success" | "partial" | "failed";
  errors?: string[];
}

export interface DigestDeliveryEvent extends MetricsEvent {
  event: "digest_delivery";
  status: "success" | "failed";
  article_count: number;
  stock_count: number;
  duration_seconds: number;
  tokens_used: number;
  error?: string;
}

export interface ErrorEvent extends MetricsEvent {
  event: "error";
  source: "ai" | "yahoo_finance" | "supabase" | "rss" | "telegram";
  severity: "warn" | "error" | "critical";
  status_code?: number;
  message: string;
  recovery_action?: string;
}

// ─── Log Directory Setup ──────────────────────────────

const LOG_DIR = path.join(process.cwd(), "logs");

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().split("T")[0];
  return path.join(LOG_DIR, `${date}.ndjson`);
}

// ─── Write Event ──────────────────────────────────────

function writeEvent(event: MetricsEvent): void {
  const line = JSON.stringify(event) + "\n";

  // Stream to stdout
  process.stdout.write(line);

  // Append to per-day NDJSON file
  try {
    ensureLogDir();
    fs.appendFileSync(getLogFilePath(), line, "utf-8");
  } catch (err) {
    // Non-critical — don't let logging failure crash the pipeline
    logger.debug(`Metrics write failed: ${(err as Error).message}`);
  }
}

// ─── Convenience Functions ────────────────────────────

export function emitFeedFetch(
  feedName: string,
  feedUrl: string,
  status: "success" | "failed" | "cached",
  articlesFetched: number,
  responseTimeMs: number,
  cached: boolean,
  retryAttempt: number,
  error?: string
): void {
  writeEvent({
    timestamp: new Date().toISOString(),
    event: "feed_fetch",
    feed_name: feedName,
    feed_url: feedUrl,
    status,
    articles_fetched: articlesFetched,
    response_time_ms: responseTimeMs,
    cached,
    retry_attempt: retryAttempt,
    ...(error ? { error } : {}),
  } as FeedFetchEvent);
}

export function emitAIBatch(
  batchNum: number,
  totalBatches: number,
  articleCount: number,
  tokensUsed: number,
  durationMs: number,
  status: "success" | "failed",
  error?: string
): void {
  writeEvent({
    timestamp: new Date().toISOString(),
    event: "ai_batch",
    batch_num: batchNum,
    total_batches: totalBatches,
    article_count: articleCount,
    tokens_used: tokensUsed,
    duration_ms: durationMs,
    status,
    ...(error ? { error } : {}),
  } as AIBatchEvent);
}

export function emitStockFetch(
  tickersRequested: number,
  tickersSucceeded: number,
  durationMs: number,
  errors?: string[]
): void {
  const status =
    tickersSucceeded === 0
      ? "failed"
      : tickersSucceeded < tickersRequested
        ? "partial"
        : "success";

  writeEvent({
    timestamp: new Date().toISOString(),
    event: "stock_fetch",
    tickers_requested: tickersRequested,
    tickers_succeeded: tickersSucceeded,
    duration_ms: durationMs,
    status,
    ...(errors && errors.length > 0 ? { errors } : {}),
  } as StockFetchEvent);
}

export function emitDigestDelivery(
  status: "success" | "failed",
  articleCount: number,
  stockCount: number,
  durationSeconds: number,
  tokensUsed: number,
  error?: string
): void {
  writeEvent({
    timestamp: new Date().toISOString(),
    event: "digest_delivery",
    status,
    article_count: articleCount,
    stock_count: stockCount,
    duration_seconds: durationSeconds,
    tokens_used: tokensUsed,
    ...(error ? { error } : {}),
  } as DigestDeliveryEvent);
}

export function emitError(
  source: ErrorEvent["source"],
  severity: ErrorEvent["severity"],
  message: string,
  statusCode?: number,
  recoveryAction?: string
): void {
  writeEvent({
    timestamp: new Date().toISOString(),
    event: "error",
    source,
    severity,
    ...(statusCode !== undefined ? { status_code: statusCode } : {}),
    message,
    ...(recoveryAction ? { recovery_action: recoveryAction } : {}),
  } as ErrorEvent);
}

// ─── Summary ──────────────────────────────────────────

export interface RunSummary {
  runDate: string;
  durationSeconds: number;
  status: "success" | "failed";
  feedsTotal: number;
  feedsHealthy: number;
  feedsFailing: number;
  feedsCached: number;
  articlesCollected: number;
  articlesDeduplicated: number;
  articlesProcessed: number;
  aiBatches: number;
  totalTokens: number;
  stockCount: number;
  deliverySuccess: boolean;
  errors: { source: string; count: number }[];
}

/**
 * Read all NDJSON events for a given date and aggregate them into a summary.
 */
export function summarizeRun(runDate: string): RunSummary | null {
  const filePath = path.join(LOG_DIR, `${runDate}.ndjson`);
  if (!fs.existsSync(filePath)) return null;

  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  const events: MetricsEvent[] = lines
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as MetricsEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is MetricsEvent => e !== null);

  const feedEvents = events.filter((e) => e.event === "feed_fetch");
  const aiEvents = events.filter((e) => e.event === "ai_batch");
  const stockEvents = events.filter((e) => e.event === "stock_fetch");
  const deliveryEvents = events.filter(
    (e) => e.event === "digest_delivery"
  );
  const errorEvents = events.filter((e) => e.event === "error");

  // Count errors by source
  const errorCounts: Record<string, number> = {};
  for (const e of errorEvents) {
    const source = (e as ErrorEvent).source;
    errorCounts[source] = (errorCounts[source] || 0) + 1;
  }

  const totalDuration = deliveryEvents.length > 0
    ? (deliveryEvents[deliveryEvents.length - 1] as DigestDeliveryEvent).duration_seconds
    : 0;

  return {
    runDate,
    durationSeconds: totalDuration,
    status: deliveryEvents.some((e) => (e as DigestDeliveryEvent).status === "failed")
      ? "failed"
      : "success",
    feedsTotal: feedEvents.length,
    feedsHealthy: feedEvents.filter((e) => (e as FeedFetchEvent).status === "success").length,
    feedsFailing: feedEvents.filter((e) => (e as FeedFetchEvent).status === "failed").length,
    feedsCached: feedEvents.filter((e) => (e as FeedFetchEvent).cached).length,
    articlesCollected: (deliveryEvents[0] as DigestDeliveryEvent)?.article_count || 0,
    articlesDeduplicated: 0,
    articlesProcessed: (deliveryEvents[0] as DigestDeliveryEvent)?.article_count || 0,
    aiBatches: aiEvents.length,
    totalTokens: aiEvents.reduce(
      (sum, e) => sum + ((e as AIBatchEvent).tokens_used || 0),
      0
    ),
    stockCount: (deliveryEvents[0] as DigestDeliveryEvent)?.stock_count || 0,
    deliverySuccess: deliveryEvents.some(
      (e) => (e as DigestDeliveryEvent).status === "success"
    ),
    errors: Object.entries(errorCounts).map(([source, count]) => ({
      source,
      count,
    })),
  };
}
