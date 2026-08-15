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

import {
  collectEarningsTranscripts,
  fetchTranscript,
  getLatestCompletedQuarter,
  getPreviousQuarter,
} from "./earnings";
import { sleep } from "../utils/helpers";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("fetchTranscript", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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

  it("uses the latest endpoint and transcript alias when no quarter is provided", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:00:00Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, { transcript: "Latest call transcript." })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTranscript("NVDA");

    expect(result).toMatchObject({
      ticker: "NVDA",
      content: "Latest call transcript.",
      year: 2026,
      quarter: 1,
      date: "2026-08-15",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://api.roic.ai/v2/company/earnings-calls/latest/NVDA?apikey=test-roic-key"
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Accept: "application/json" },
    });
  });

  it("returns null for a successful response with no transcript content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { date: "2026-04-15" })));

    await expect(fetchTranscript("NVDA", 2026, 1)).resolves.toBeNull();
  });
});

describe("collectEarningsTranscripts", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("enriches successful transcripts, records failures, and sorts newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { content: "NVIDIA call", date: "2026-04-15" }))
      .mockResolvedValueOnce(new Response(null, { status: 500, statusText: "Server Error" }))
      .mockResolvedValueOnce(jsonResponse(200, { content: "Unknown company call", date: "2026-06-15" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await collectEarningsTranscripts(["NVDA", "BROKEN", "ACME"]);

    expect(result.totalFetched).toBe(2);
    expect(result.failed).toEqual(["BROKEN"]);
    expect(result.transcripts.map((transcript) => transcript.ticker)).toEqual(["ACME", "NVDA"]);
    expect(result.transcripts[0].companyName).toBe("ACME");
    expect(result.transcripts[1].companyName).toBe("NVIDIA Corporation");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain("year=2026&quarter=2");
    expect(String(fetchMock.mock.calls[2][0])).toContain("year=2026&quarter=2");
  });

  it("does no work for an explicitly empty ticker list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(collectEarningsTranscripts([])).resolves.toEqual({
      transcripts: [],
      totalFetched: 0,
      failed: [],
    });
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
