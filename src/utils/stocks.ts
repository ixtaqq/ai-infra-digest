import { logger } from "./logger";

export interface StockPrice {
  ticker: string;
  price: number;
  change: number;       // Absolute change
  changePercent: number; // Percentage change
  previousClose: number;
}

const YAHOO_FINANCE_URL =
  "https://query1.finance.yahoo.com/v8/finance/chart";

// Common AI infrastructure tickers with their full exchange names for Yahoo Finance
const TICKER_MAP: Record<string, string> = {
  NVDA: "NVDA",
  AMD: "AMD",
  AVGO: "AVGO",
  MSFT: "MSFT",
  AMZN: "AMZN",
  GOOGL: "GOOGL",
  META: "META",
  TSLA: "TSLA",
  INTC: "INTC",
  QCOM: "QCOM",
  TSM: "TSM",
  MU: "MU",
  MRVL: "MRVL",
  SNPS: "SNPS",
  CDNS: "CDNS",
  ARM: "ARM",
  DELL: "DELL",
  SMCI: "SMCI",
  ANET: "ANET",
  CRM: "CRM",
  ORCL: "ORCL",
  NOW: "NOW",
  PLTR: "PLTR",
  IBM: "IBM",
};

async function fetchPrice(ticker: string): Promise<StockPrice | null> {
  try {
    const url = `${YAHOO_FINANCE_URL}/${TICKER_MAP[ticker] || ticker}?range=5d&interval=1d`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      logger.debug(`Yahoo Finance returned ${response.status} for ${ticker}`);
      return null;
    }

    const data = await response.json() as {
      chart?: {
        result?: Array<{
          meta?: {
            regularMarketPrice?: number;
            previousClose?: number;
            currency?: string;
          };
          indicators?: {
            quote?: Array<{
              close?: number[];
            }>;
          };
        }>;
        error?: { description?: string };
      };
    };

    const result = data?.chart?.result?.[0];
    if (!result?.meta) return null;

    const meta = result.meta;
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.previousClose ?? price;
    const change = price - prevClose;
    const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

    return {
      ticker,
      price,
      change,
      changePercent,
      previousClose: prevClose,
    };
  } catch (error) {
    logger.debug(`Failed to fetch ${ticker}: ${(error as Error).message}`);
    return null;
  }
}

export async function fetchStockPrices(
  tickers: string[]
): Promise<Map<string, StockPrice>> {
  const uniqueTickers = [...new Set(tickers)]
    .filter((t) => TICKER_MAP[t] || t.length <= 5)
    .slice(0, 25); // Max 25 tickers

  if (uniqueTickers.length === 0) return new Map();

  logger.info(`Fetching stock prices for ${uniqueTickers.length} tickers...`);

  const results = await Promise.allSettled(
    uniqueTickers.map((t) => fetchPrice(t))
  );

  const prices = new Map<string, StockPrice>();
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      prices.set(result.value.ticker, result.value);
    }
  }

  logger.info(`Got prices for ${prices.size}/${uniqueTickers.length} tickers`);
  return prices;
}
