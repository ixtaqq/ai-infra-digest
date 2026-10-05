import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestResult } from "../processor/ai";

vi.mock("../config", () => ({ config: { app: {
  supabaseUrl: "https://fixture.invalid", supabaseServiceKey: "fixture", roicAiApiKey: "fixture",
} } }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../utils/helpers", () => ({ sleep: vi.fn(async () => {}) }));

import { fetchCompanyFilings } from "../collector/sec";
import { fetchTranscript } from "../collector/earnings";
import { flagRehashes } from "../utils/novelty";
import { queryDerivedMetrics, queryRecentDerivedMetrics, writeDerivedMetrics } from "../utils/derived-metrics";

const company = { ticker: "NVDA", name: "NVIDIA", cik: "0001045810", tier: 1 as const };
const digest = { articles: [{ category: "Chips & GPUs", impact: "Neutral", impactScore: 5, affectedStocks: ["NVDA"] }] } as DigestResult;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("Fixture body timeout")), ms);
    return controller.signal;
  });
  fetchMock.mockReset().mockImplementation(async (_input, init: RequestInit) => {
    const stalledBody = () => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    return { ok: true, status: 200, json: stalledBody, text: stalledBody };
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HTTP body deadlines", () => {
  it.each([
    { name: "SEC submissions", run: () => fetchCompanyFilings(company), expected: expect.objectContaining({ status: "failed" }) },
    { name: "earnings transcript", run: () => fetchTranscript("NVDA"), expected: null },
    { name: "novelty history", run: () => flagRehashes([]).catch(error => error.message), expected: "Fixture body timeout" },
    { name: "entity metrics", run: () => queryDerivedMetrics("ticker", "NVDA", 7), expected: [] },
    { name: "recent metrics", run: () => queryRecentDerivedMetrics(), expected: [] },
  ])("settles $name when headers arrive but the body stalls", async ({ run, expected }) => {
    let settled = false;
    let result: unknown;
    const pending = run().then(value => { result = value; settled = true; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(true);
    expect(result).toEqual(expected);
    await pending;
  });

  it("retains filing metadata when its document times out", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ filings: { recent: {
      accessionNumber: ["0001045810-26-000123"], filingDate: [new Date().toISOString().slice(0, 10)],
      form: ["8-K"], primaryDocument: ["filing.htm"], primaryDocDescription: ["Earnings"], items: ["2.02"],
    } } }) });
    let settled = false;
    const pending = fetchCompanyFilings(company).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ status: "success", filings: [{ rawText: "" }] });
  });

  it("releases a stalled metrics write without retrying an uncertain write", async () => {
    fetchMock.mockImplementation((_input, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    let settled = false;
    const pending = writeDerivedMetrics(digest, "2026-10-06", new Map()).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(settled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await pending;
  });
});
