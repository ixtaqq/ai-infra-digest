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

// Complete AI Infrastructure Universe — all tickers across 10 sectors
const TICKER_MAP: Record<string, string> = {
  // 1. AI Chip Designers
  NVDA: "NVDA", AMD: "AMD", AVGO: "AVGO", QCOM: "QCOM",
  MRVL: "MRVL", ARM: "ARM",

  // 2. Semiconductor Manufacturing
  TSM: "TSM", INTC: "INTC", GFS: "GFS",

  // 3. Semiconductor Equipment
  ASML: "ASML", AMAT: "AMAT", LRCX: "LRCX", KLAC: "KLAC",

  // 4. Memory & Storage
  MU: "MU",

  // 5. Networking
  ANET: "ANET", CSCO: "CSCO", JNPR: "JNPR",

  // 6. Datacenter REITs
  DLR: "DLR", EQIX: "EQIX",

  // 7. Cloud Providers
  MSFT: "MSFT", AMZN: "AMZN", GOOGL: "GOOGL", ORCL: "ORCL",

  // 8. Power & Energy
  CEG: "CEG", VST: "VST", GEV: "GEV",

  // 9. Cooling Infrastructure
  VRT: "VRT", ETN: "ETN", TT: "TT", SBGSY: "SBGSY",

  // 10. Other key tech
  META: "META", CRM: "CRM", NOW: "NOW", PLTR: "PLTR",
  IBM: "IBM", DELL: "DELL", SMCI: "SMCI", SNPS: "SNPS",
  CDNS: "CDNS",
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
