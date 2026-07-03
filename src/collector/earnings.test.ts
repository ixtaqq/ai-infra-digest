import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: { app: { roicAiApiKey: "test-roic-key" } },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The real sleep() would make the 429-retry tests take 60s+ each — stub it to
// resolve instantly so the retry-cap behavior can be tested at full speed.
vi.mock("../utils/helpers", () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { fetchTranscript, getLatestCompletedQuarter, getPreviousQuarter } from "./earnings";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchTranscript", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns the transcript content on a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, { content: "Welcome to our earnings call.", date: "2026-04-15", year: 2026, quarter: 1 })
      )
    );

    const result = await fetchTranscript("NVDA", 2026, 1);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Welcome to our earnings call.");
    expect(result!.ticker).toBe("NVDA");
  });

  it("returns null on a 404 (no transcript for that quarter)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 404 })));
    const result = await fetchTranscript("NVDA", 2026, 1);
    expect(result).toBeNull();
  });

  it("retries once on 429 and succeeds if the retry gets a 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(200, { content: "Recovered transcript.", date: "2026-04-15" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTranscript("AMD", 2026, 1);
    expect(result).not.toBeNull();
    expect(result!.content).toBe("Recovered transcript.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after MAX_RATE_LIMIT_RETRIES instead of recursing forever (B-01 regression guard)", async () => {
    // Every single call returns 429 — before the fix this recursed with no cap.
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTranscript("AVGO", 2026, 1);

    expect(result).toBeNull();
    // Initial attempt (retryCount 0) + 2 retries (MAX_RATE_LIMIT_RETRIES) = 3 calls, then stop.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns null without calling fetch when the API key isn't configured", async () => {
    vi.doMock("../config", () => ({ config: { app: { roicAiApiKey: "" } } }));
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTranscript: fetchTranscriptNoKey } = await import("./earnings");
    const result = await fetchTranscriptNoKey("NVDA", 2026, 1);

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getLatestCompletedQuarter / getPreviousQuarter", () => {
  afterEach(() => vi.useRealTimers());

  it("returns Q4 of the prior year in January", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15"));
    expect(getLatestCompletedQuarter()).toEqual({ year: 2025, quarter: 4 });
  });

  it("returns Q2 in July", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15"));
    expect(getLatestCompletedQuarter()).toEqual({ year: 2026, quarter: 2 });
  });

  it("rolls back to Q4 of the prior year from Q1", () => {
    expect(getPreviousQuarter(2026, 1)).toEqual({ year: 2025, quarter: 4 });
  });

  it("decrements within the same year otherwise", () => {
    expect(getPreviousQuarter(2026, 3)).toEqual({ year: 2026, quarter: 2 });
  });
});
