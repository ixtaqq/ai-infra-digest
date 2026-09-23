import { describe, it, expect } from "vitest";
import { inferDirection, isTriggered, isFreshQuote } from "./price-watch";

it("rejects absent, stale and future quote timestamps", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  expect(isFreshQuote({ price: 100 }, now)).toBe(false);
  expect(isFreshQuote({ price: 100, observedAt: "2026-09-22T11:00:00Z" }, now)).toBe(false);
  expect(isFreshQuote({ price: 100, observedAt: "2026-09-23T12:00:00Z" }, now)).toBe(false);
  expect(isFreshQuote({ price: 100, observedAt: "2026-09-22T11:55:00Z" }, now)).toBe(true);
});

describe("inferDirection", () => {
  it("infers 'above' when the threshold is above the current price", () => {
    expect(inferDirection(130, 120)).toBe("above");
  });

  it("infers 'below' when the threshold is below the current price", () => {
    expect(inferDirection(120, 130)).toBe("below");
  });

  it("defaults to 'above' when the threshold equals the current price (documented tie-break)", () => {
    expect(inferDirection(125, 125)).toBe("above");
  });
});

describe("isTriggered", () => {
  it("fires for 'above' once the price reaches or exceeds the threshold", () => {
    expect(isTriggered({ direction: "above", threshold: 130 }, 131)).toBe(true);
    expect(isTriggered({ direction: "above", threshold: 130 }, 129)).toBe(false);
  });

  it("fires for 'below' once the price reaches or drops below the threshold", () => {
    expect(isTriggered({ direction: "below", threshold: 120 }, 119)).toBe(true);
    expect(isTriggered({ direction: "below", threshold: 120 }, 121)).toBe(false);
  });

  it("is boundary-inclusive for both directions", () => {
    expect(isTriggered({ direction: "above", threshold: 130 }, 130)).toBe(true);
    expect(isTriggered({ direction: "below", threshold: 120 }, 120)).toBe(true);
  });
});
