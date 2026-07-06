import { describe, it, expect } from "vitest";
import { todayInTimezone, parsePositiveFloat } from "./helpers";

describe("todayInTimezone", () => {
  // 2026-01-01 20:00 UTC is already 2026-01-02 in UTC+8 (Malaysia) — the exact
  // boundary case the helper exists to get right (UTC .toISOString() would say Jan 1).
  const lateUtc = new Date("2026-01-01T20:00:00Z");

  it("returns the local calendar date, not the UTC date, for a timezone ahead of UTC", () => {
    expect(todayInTimezone("Asia/Kuala_Lumpur", lateUtc)).toBe("2026-01-02");
  });

  it("returns the UTC-equal date for the UTC zone", () => {
    expect(todayInTimezone("UTC", lateUtc)).toBe("2026-01-01");
  });

  it("stays on the previous local day for a timezone behind UTC", () => {
    // 03:00 UTC on Jan 2 is still Jan 1 evening in New York (UTC-5).
    expect(todayInTimezone("America/New_York", new Date("2026-01-02T03:00:00Z"))).toBe(
      "2026-01-01"
    );
  });

  it("emits YYYY-MM-DD format", () => {
    expect(todayInTimezone("UTC", new Date("2026-03-07T12:00:00Z"))).toBe("2026-03-07");
  });

  it("falls back to the UTC date on an invalid timezone instead of throwing", () => {
    expect(todayInTimezone("Not/AZone", lateUtc)).toBe("2026-01-01");
  });
});

describe("parsePositiveFloat", () => {
  it("parses a valid positive number", () => {
    expect(parsePositiveFloat("0.75", 0.5)).toBe(0.75);
  });

  it("accepts zero", () => {
    expect(parsePositiveFloat("0", 0.5)).toBe(0);
  });

  it("falls back on undefined / empty / whitespace", () => {
    expect(parsePositiveFloat(undefined, 0.5)).toBe(0.5);
    expect(parsePositiveFloat("", 5)).toBe(5);
    expect(parsePositiveFloat("   ", 5)).toBe(5);
  });

  it("falls back on non-numeric input instead of returning NaN", () => {
    expect(parsePositiveFloat("abc", 0.5)).toBe(0.5);
    expect(parsePositiveFloat("$1.00", 0.5)).toBe(0.5);
  });

  it("falls back on a negative number", () => {
    expect(parsePositiveFloat("-2", 0.5)).toBe(0.5);
  });

  it("parses a leading-numeric string the way parseFloat does", () => {
    // parseFloat("1.5x") === 1.5 — acceptable; documents the intended behavior.
    expect(parsePositiveFloat("1.5x", 0.5)).toBe(1.5);
  });
});
