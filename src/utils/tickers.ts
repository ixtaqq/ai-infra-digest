const NON_TICKER_TOKENS = new Set(["AI", "CEO", "CFO", "ETF", "GPU", "USA", "USD"]);

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
