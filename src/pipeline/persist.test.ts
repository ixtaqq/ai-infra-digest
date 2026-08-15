import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DigestResult } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { CapabilityReport } from "../utils/capabilities";
import type { GeneratedDigest } from "./types";

const h = vi.hoisted(() => ({
  isConfigured: vi.fn(),
  createDigestRun: vi.fn(),
  insertArticles: vi.fn(),
  insertPipelineHealth: vi.fn(),
  updateSectorActivity: vi.fn(),
  updateStockMentions: vi.fn(),
  insertStockPrices: vi.fn(),
  updateDailyMetrics: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    app: {
      supabaseUrl: "https://mock.supabase.co",
      supabaseServiceKey: "service-key",
      budgetDailyUsd: 1,
      budgetMonthlyUsd: 30,
    },
    ai: { provider: "groq", model: "strong", fastModel: "fast" },
  },
}));
vi.mock("../processor/ai", () => ({ NEWS_CATEGORIES: ["Chips & GPUs"] }));
vi.mock("../sender/telegram", () => ({ sendDigestMessage: vi.fn() }));
vi.mock("../utils/budget", () => ({ getRolling30DaySpend: vi.fn(async () => 0) }));
vi.mock("../utils/capabilities", () => ({ degradedCapabilities: vi.fn(() => []) }));
vi.mock("../utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../utils/supabase", () => ({ supabase: h }));

import { persistDigestMetrics, persistSecFilings } from "./persist";

const fetchMock = vi.fn();

function makeExtract(overrides: Partial<SECFinancialExtract> = {}): SECFinancialExtract {
  return {
    ticker: "NVDA",
    formType: "8-K",
    filingDate: "2026-08-15",
    companyName: "NVIDIA Corporation",
    accessionNumber: "0001045810-26-000123",
    primaryDocumentUrl: "https://www.sec.gov/Archives/edgar/data/1045810/filing.htm",
    items: ["2.02"],
    capex: 500,
    capexGuidance: null,
    capexSource: "Capex was $500 million",
    aiRevenue: 250,
    aiRevenueGrowthPct: 20,
    aiRevenueSource: "AI revenue was $250 million",
    grossMargin: 75,
    operatingMargin: null,
    marginSource: "",
    inventory: null,
    inventoryTurnover: null,
    inventorySource: "",
    revenueGuidance: null,
    epsGuidance: null,
    guidanceText: "",
    impactScore: 8,
    impactRationale: "Strong AI demand",
    keyTakeaways: ["Capex increased"],
    ...overrides,
  };
}

function makeGenerated(secExtracts: SECFinancialExtract[]): GeneratedDigest {
  const digest = {
    articles: [],
    topStocks: [],
    marketOutlook: "",
    summary: "",
    categories: {},
    usage: { totalTokens: 10, promptTokens: 5, completionTokens: 5 },
    batchesRun: 0,
  } as unknown as DigestResult;

  return {
    runDate: "2026-08-15",
    startTime: Date.now(),
    formattedMessage: "",
    digest,
    articlesCollected: 0,
    feedStatuses: [],
    secExtracts,
    earningsAnalyses: [],
    stockPrices: new Map(),
    activeWatches: [],
    capabilities: {} as CapabilityReport,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue({ ok: true, status: 201 });
  h.isConfigured.mockReturnValue(true);
  h.createDigestRun.mockResolvedValue(42);
  h.insertArticles.mockResolvedValue([]);
  h.insertPipelineHealth.mockResolvedValue(true);
  h.updateSectorActivity.mockResolvedValue(true);
  h.updateStockMentions.mockResolvedValue(true);
  h.insertStockPrices.mockResolvedValue(true);
  h.updateDailyMetrics.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SEC persistence", () => {
  it("writes normalized extracts and preserves the existing aggregate metrics", async () => {
    const extract = makeExtract();

    await persistDigestMetrics(makeGenerated([extract]), "success");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/sec_filings?on_conflict=ticker,accession_number");
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      apikey: "service-key",
      Authorization: "Bearer service-key",
      Prefer: "return=minimal,resolution=merge-duplicates",
    });

    const [row] = JSON.parse(options.body as string) as Record<string, unknown>[];
    expect(row).toMatchObject({
      date: "2026-08-15",
      ticker: "NVDA",
      company_name: "NVIDIA Corporation",
      form_type: "8-K",
      filing_date: "2026-08-15",
      accession_number: "0001045810-26-000123",
      primary_document_url: "https://www.sec.gov/Archives/edgar/data/1045810/filing.htm",
      items: ["2.02"],
      capex: 500,
      ai_revenue: 250,
      gross_margin: 75,
      impact_score: 8,
      key_takeaways: ["Capex increased"],
    });
    expect(h.updateDailyMetrics).toHaveBeenCalledWith(
      "2026-08-15",
      expect.objectContaining({
        sec_filings_processed: 1,
        sec_capex_total: 500,
        sec_ai_revenue_total: 250,
      })
    );
  });

  it("uses the filing conflict key so repeated runs keep one row", async () => {
    const stored = new Map<string, Record<string, unknown>>();
    fetchMock.mockImplementation(async (_url: string, options: RequestInit) => {
      const rows = JSON.parse(options.body as string) as Record<string, unknown>[];
      for (const row of rows) {
        stored.set(`${row.ticker}:${row.accession_number}`, row);
      }
      return { ok: true, status: 201 };
    });

    const extract = makeExtract();
    await persistSecFilings("2026-08-15", [extract, extract]);
    await persistSecFilings("2026-08-15", [extract]);

    expect(stored).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toContain("on_conflict=ticker,accession_number");
    }
  });

  it("skips empty input and normalizes malformed optional fields", async () => {
    await persistSecFilings("2026-08-15", []);
    expect(fetchMock).not.toHaveBeenCalled();

    const malformed = makeExtract({
      items: "not an array" as unknown as string[],
      capex: "not a number" as unknown as number,
      capexSource: 123 as unknown as string,
      aiRevenue: Number.NaN,
      guidanceText: "   ",
      keyTakeaways: ["valid", 123] as unknown as string[],
    });
    await persistSecFilings("2026-08-15", [malformed]);

    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const [row] = JSON.parse(options.body as string) as Record<string, unknown>[];
    expect(row).toMatchObject({
      items: [],
      capex: null,
      capex_source: null,
      ai_revenue: null,
      guidance_text: null,
      key_takeaways: ["valid"],
    });
  });
});
