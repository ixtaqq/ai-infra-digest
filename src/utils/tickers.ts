const NON_TICKER_TOKENS = new Set(["AI", "CEO", "CFO", "ETF", "GPU", "USA", "USD"]);

/** What the model writes for companies it has no exact ticker for. Null means no US listing. */
const AI_TICKER_CORRECTIONS: Record<string, string | null> = {
  ARISTA: "ANET",
  ASE: "ASX",
  AWS: "AMZN",
  CXMT: null,
  INTEL: "INTC",
  KIOXIA: null,
  KLA: "KLAC",
  LAM: "LRCX",
  LMNT: "LITE",
  LUM: "LITE",
  MARV: "MRVL",
  SKH: null,
};

export function normalizeTickerSymbols(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toUpperCase())
        .filter(
          (value) =>
            /^[A-Z]{1,6}(?:[.-][A-Z]{1,2})?$/.test(value) &&
            !NON_TICKER_TOKENS.has(value)
        )
    ),
  ];
}

export function correctAiTickers(values: string[]): string[] {
  return normalizeTickerSymbols(
    normalizeTickerSymbols(values).flatMap((ticker) => {
      const correction = AI_TICKER_CORRECTIONS[ticker];
      if (correction === null) return [];
      return [correction ?? ticker];
    })
  );
}
