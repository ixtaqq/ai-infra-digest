export interface PriceWatch {
  id: number;
  chat_id: number;
  ticker: string;
  threshold: number;
  direction: "above" | "below";
  created_at?: string;
}

/**
 * Direction is inferred once, at watch-creation time, from where the
 * threshold sits relative to the current price. Equal-price ties default to
 * "above" — arbitrary but deterministic (see docs/price-watch-design.md).
 */
export function inferDirection(threshold: number, priceAtCreation: number): "above" | "below" {
  return threshold >= priceAtCreation ? "above" : "below";
}

/** Boundary-inclusive: a price landing exactly on the threshold still fires. */
export function isTriggered(watch: { direction: "above" | "below"; threshold: number }, currentPrice: number): boolean {
  return watch.direction === "above" ? currentPrice >= watch.threshold : currentPrice <= watch.threshold;
}
