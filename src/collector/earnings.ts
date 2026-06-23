/**
 * Earnings Call Transcript Collector
 *
 * Fetches earnings call transcripts for tracked AI infrastructure companies
 * via the Roic.ai API (free tier: 5 req/min, 2-year history).
 *
 * API docs: https://www.roic.ai/api/docs/earnings-calls
 * Endpoints:
 *   GET /v2/company/earnings-calls/transcript/{ticker}?year=YYYY&quarter=N
 *   GET /v2/company/earnings-calls/latest/{ticker}
 */

import { logger } from "../utils/logger";
import { config } from "../config";
import { sleep } from "../utils/helpers";

// ─── Types ──────────────────────────────────────────────

export interface EarningsTranscript {
  /** Ticker symbol */
  ticker: string;
  /** Company name */
  companyName: string;
  /** Fiscal year */
  year: number;
  /** Fiscal quarter (1-4) */
  quarter: number;
  /** Date of the earnings call (YYYY-MM-DD) */
  date: string;
  /** Full transcript text (prepared remarks + Q&A) */
  content: string;
  /** Raw API response for debugging */
  rawResponse?: string;
}

export interface EarningsCollectorResult {
  transcripts: EarningsTranscript[];
  totalFetched: number;
  failed: string[];
}

// ─── Company List for Earnings Monitoring ───────────────

/** Core AI infrastructure companies to monitor for earnings transcripts. */
export const EARNINGS_COMPANIES: { ticker: string; name: string }[] = [
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "AMD",  name: "Advanced Micro Devices" },
  { ticker: "AVGO", name: "Broadcom Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "TSM",  name: "Taiwan Semiconductor (ADR)" },
  { ticker: "INTC", name: "Intel Corporation" },
  { ticker: "QCOM", name: "Qualcomm Inc." },
  { ticker: "MU",   name: "Micron Technology Inc." },
  { ticker: "ORCL", name: "Oracle Corporation" },
  { ticker: "ASML", name: "ASML Holding N.V." },
  { ticker: "IBM",  name: "International Business Machines" },
  { ticker: "SMCI", name: "Super Micro Computer Inc." },
];

const ROIC_BASE_URL = "https://api.roic.ai/v2";

// ─── Rate Limiting ─────────────────────────────────────

/** Ensure max 5 requests per minute (free tier limit). Track timestamps. */
const requestTimestamps: number[] = [];

async function rateLimitRoic(): Promise<void> {
  const now = Date.now();
  // Remove timestamps older than 60 seconds
  while (requestTimestamps.length > 0 && requestTimestamps[0] < now - 60000) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= 5) {
    // Wait until the oldest request is >60s old
    const waitMs = requestTimestamps[0] + 60000 - now + 200;
    logger.debug(`Roic.ai rate limit: waiting ${Math.round(waitMs)}ms`);
    await sleep(waitMs);
  }
  requestTimestamps.push(Date.now());
}

// ─── Fetch Transcript ──────────────────────────────────

/**
 * Fetch an earnings call transcript for a ticker from a specific fiscal quarter.
 * Falls back to fetching the latest transcript if no specific quarter is given.
 */
export async function fetchTranscript(
  ticker: string,
  year?: number,
  quarter?: number
): Promise<EarningsTranscript | null> {
  const apiKey = config.app.roicAiApiKey;
  if (!apiKey) {
    logger.warn(`Roic.ai API key not configured — skipping transcript fetch for ${ticker}`);
    return null;
  }

  try {
    let url: string;
    if (year && quarter) {
      url = `${ROIC_BASE_URL}/company/earnings-calls/transcript/${ticker}?apikey=${apiKey}&year=${year}&quarter=${quarter}`;
    } else {
      url = `${ROIC_BASE_URL}/company/earnings-calls/latest/${ticker}?apikey=${apiKey}`;
    }

    await rateLimitRoic();

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "AI-Infra-Digest/3.1 (earnings transcript analysis; contact: ai-infra@example.com)",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        logger.debug(`No transcript found for ${ticker} Q${quarter} ${year}`);
        return null;
      }
      // Rate limit handling
      if (response.status === 429) {
        logger.warn(`Roic.ai rate limited on ${ticker}, waiting 60s...`);
        await sleep(62000);
        return fetchTranscript(ticker, year, quarter);
      }
      throw new Error(`Roic.ai HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Normalise response: some endpoints return { symbol, content, date, ... }
    const content = (data.content || data.transcript || "") as string;
    if (!content) {
      logger.debug(`Empty transcript for ${ticker}`);
      return null;
    }

    return {
      ticker,
      companyName: "", // Will be filled in by the caller
      year: (data.year as number) || year || new Date().getFullYear(),
      quarter: (data.quarter as number) || quarter || 1,
      date: (data.date as string) || new Date().toISOString().split("T")[0],
      content,
      rawResponse: JSON.stringify(data).slice(0, 500),
    };
  } catch (error) {
    logger.warn(`Earnings transcript fetch failed for ${ticker}: ${(error as Error).message}`);
    return null;
  }
}

// ─── Determine Recent Quarter ─────────────────────────

/**
 * Determine the most recent completed fiscal quarter.
 * E.g., if it's June 2026, the most recent completed quarter is Q2 2026
 * (Apr-Jun). If it's February, it's Q4 of the previous year.
 */
export function getLatestCompletedQuarter(): { year: number; quarter: number } {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();

  if (month < 3) return { year: year - 1, quarter: 4 }; // Q4 prev year
  if (month < 6) return { year, quarter: 1 };            // Q1
  if (month < 9) return { year, quarter: 2 };            // Q2
  return { year, quarter: 3 };                            // Q3 (current Q not yet complete)
}

/**
 * Get the previous quarter from a given year/quarter.
 */
export function getPreviousQuarter(year: number, quarter: number): { year: number; quarter: number } {
  if (quarter > 1) return { year, quarter: quarter - 1 };
  return { year: year - 1, quarter: 4 };
}

// ─── Main Collection ───────────────────────────────────

/**
 * Collect recent earnings call transcripts for top AI infrastructure companies.
 *
 * Strategy:
 * - Fetches the latest transcript for each Tier 1 company
 * - Rate-limited to 5 req/min (Roic.ai free tier)
 * - Returns transcripts sorted by date (newest first)
 * - Gracefully handles failures (logs, skips)
 *
 * For production use, this can be expanded to pull transcripts for
 * companies that recently reported (via SEC 8-K with Item 2.02).
 */
export async function collectEarningsTranscripts(
  tickers?: string[]
): Promise<EarningsCollectorResult> {
  const targets = tickers || EARNINGS_COMPANIES.map((c) => c.ticker);
  logger.info(`Earnings: fetching transcripts for ${targets.length} companies...`);

  const transcripts: EarningsTranscript[] = [];
  const failed: string[] = [];

  const { year, quarter } = getLatestCompletedQuarter();

  for (let i = 0; i < targets.length; i++) {
    const ticker = targets[i];
    const company = EARNINGS_COMPANIES.find((c) => c.ticker === ticker);
    const companyName = company?.name || ticker;

    logger.info(`  [${i + 1}/${targets.length}] Fetching ${ticker} Q${quarter} ${year} transcript...`);

    const transcript = await fetchTranscript(ticker, year, quarter);
    if (transcript) {
      transcript.companyName = companyName;
      transcripts.push(transcript);
      logger.info(`  ✓ ${ticker} Q${quarter} ${year}: ${transcript.content.length.toLocaleString()} chars`);
    } else {
      failed.push(ticker);
    }

    // Brief pause between requests (rate limiting handled internally)
    if (i < targets.length - 1) await sleep(200);
  }

  // Sort by date (newest first)
  transcripts.sort((a, b) => b.date.localeCompare(a.date));

  logger.info(
    `Earnings collection complete: ${transcripts.length} transcripts fetched ` +
    `(${failed.length} failed)`
  );

  return { transcripts, totalFetched: transcripts.length, failed };
}
