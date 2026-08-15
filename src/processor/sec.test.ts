import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({
  config: {
    ai: {
      provider: "groq",
      apiKey: "test-key",
      model: "strong-model",
      fastModel: "fast-model",
      baseUrl: "https://api.test/v1",
    },
  },
}));

vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../utils/helpers", () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { analyzeSECFilings, formatSECExtract } from "./sec";
import type { SECFiling } from "../collector/sec";

function makeFiling(overrides: Partial<SECFiling> = {}): SECFiling {
  return {
    cik: "0001045810",
    ticker: "NVDA",
    companyName: "NVIDIA Corporation",
    formType: "8-K",
    filingDate: "2026-07-01",
    accessionNumber: "0001045810-26-000123",
    primaryDocumentUrl: "https://sec.gov/filing/1",
    items: ["2.02"],
    description: "Results of Operations",
    rawText: "Capital expenditure this quarter was $500 million, up from prior guidance. AI revenue grew.",
    ...overrides,
  };
}

function chatCompletionResponse(content: string) {
  return new Response(
    JSON.stringify({
      id: "test",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { total_tokens: 50, prompt_tokens: 30, completion_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function extractionPayload(overrides: Record<string, unknown> = {}) {
  return {
    capex: null,
    capexGuidance: null,
    capexSource: "",
    aiRevenue: null,
    aiRevenueGrowthPct: null,
    aiRevenueSource: "",
    grossMargin: null,
    operatingMargin: null,
    marginSource: "",
    inventory: null,
    inventoryTurnover: null,
    inventorySource: "",
    revenueGuidance: null,
    epsGuidance: null,
    guidanceText: "",
    impactScore: 5,
    impactRationale: "r",
    keyTakeaways: [],
    ...overrides,
  };
}

describe("analyzeSECFilings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns empty result immediately when there are no filings", async () => {
    const result = await analyzeSECFilings([]);
    expect(result.extracts).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it("coerces numeric-looking strings instead of crashing on .toFixed()", async () => {
    const fetchMock = vi.fn()
      // Pass 1: flag as relevant
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "capex mentioned" })))
      // Pass 2: extraction — capex returned as a STRING, not a number (the exact
      // shape that used to crash formatSECExtract's `.toFixed()` call)
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            capex: "500",
            capexGuidance: null,
            capexSource: "Capex was $500 million",
            aiRevenue: null,
            aiRevenueGrowthPct: null,
            aiRevenueSource: "",
            grossMargin: null,
            operatingMargin: null,
            marginSource: "",
            inventory: null,
            inventoryTurnover: null,
            inventorySource: "",
            revenueGuidance: null,
            epsGuidance: null,
            guidanceText: "",
            impactScore: "8", // also a string
            impactRationale: "Higher capex signals continued AI investment",
            keyTakeaways: ["Capex up"],
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings([makeFiling()], 1);

    expect(result.extracts).toHaveLength(1);
    const extract = result.extracts[0];
    expect(extract.capex).toBe(500);
    expect(typeof extract.capex).toBe("number");
    expect(extract.impactScore).toBe(8);
    // Metadata is merged in by the caller, not the AI response
    expect(extract.ticker).toBe("NVDA");
    expect(extract.formType).toBe("8-K");
    expect(extract.accessionNumber).toBe("0001045810-26-000123");
    expect(extract.primaryDocumentUrl).toBe("https://sec.gov/filing/1");
    expect(extract.items).toEqual(["2.02"]);

    // formatSECExtract must not throw now that capex is a real number
    expect(() => formatSECExtract(extract)).not.toThrow();
    expect(formatSECExtract(extract)).toContain("$500M");
  });

  it("treats an unparseable extraction response as no data (not a crash)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "ok" })))
      .mockResolvedValueOnce(chatCompletionResponse("not valid json at all"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings([makeFiling()], 1);
    expect(result.extracts).toEqual([]);
  });

  it("skips Pass 2 entirely when Pass 1 flags nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      chatCompletionResponse(JSON.stringify({ hasFinancialData: false, reason: "no relevant data" }))
    );
    vi.stubGlobal("fetch", fetchMock);

    // Mentions a keyword (passes the free pre-filter) but the AI flag call says "no data"
    const result = await analyzeSECFilings(
      [makeFiling({ rawText: "This filing references capital expenditure in a general risk-factors boilerplate section." })],
      1
    );
    expect(result.extracts).toEqual([]);
    // Only the Pass-1 flag call should have been made — no Pass-2 extraction call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips the AI flag call entirely when no keywords are present (free pre-filter)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings(
      [makeFiling({ rawText: "This filing discusses unrelated corporate housekeeping matters." })],
      1
    );
    expect(result.extracts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("nullifies unparseable financial figures instead of propagating garbage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "ok" })))
      .mockResolvedValueOnce(
        chatCompletionResponse(
          JSON.stringify({
            capex: "not a number",
            capexGuidance: null,
            capexSource: "",
            aiRevenue: null,
            aiRevenueGrowthPct: null,
            aiRevenueSource: "",
            grossMargin: null,
            operatingMargin: null,
            marginSource: "",
            inventory: null,
            inventoryTurnover: null,
            inventorySource: "",
            revenueGuidance: null,
            epsGuidance: null,
            guidanceText: "",
            impactScore: 6,
            impactRationale: "r",
            keyTakeaways: [],
          })
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings([makeFiling()], 1);
    expect(result.extracts).toHaveLength(1);
    expect(result.extracts[0].capex).toBeNull();
  });

  it("sorts filings by processing priority and respects maxFilings", async () => {
    const filings = [
      makeFiling({ ticker: "TENK", formType: "10-K", accessionNumber: "10-k" }),
      makeFiling({ ticker: "EIGHTK", formType: "8-K", accessionNumber: "8-k" }),
      makeFiling({ ticker: "TENQ", formType: "10-Q", accessionNumber: "10-q" }),
    ];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const prompt = request.messages[1].content as string;
      if (prompt.startsWith("Does this SEC filing")) {
        return chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "numbers" }));
      }
      const formType = prompt.match(/Form type: ([^\n]+)/)![1];
      return chatCompletionResponse(JSON.stringify(extractionPayload({ impactScore: formType === "8-K" ? 8 : 6 })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings(filings, 2);

    expect(result.extracts.map((extract) => extract.formType)).toEqual(["8-K", "10-Q"]);
    expect(result.extracts.map((extract) => extract.ticker)).toEqual(["EIGHTK", "TENQ"]);
    expect(result.totalTokens).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).model).toBe("fast-model");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)).model).toBe("strong-model");
  });

  it("defaults to extracting when the Pass 1 flag response cannot be parsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(chatCompletionResponse("not valid json"))
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify(extractionPayload({ capex: 125 }))));
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeSECFilings([makeFiling()], 1);

    expect(result.extracts).toHaveLength(1);
    expect(result.extracts[0].capex).toBe(125);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("formatSECExtract", () => {
  it("renders populated financial fields, growth direction, takeaways, and impact", () => {
    const formatted = formatSECExtract({
      ...makeFiling(),
      capex: 500,
      capexGuidance: 650,
      capexSource: "capex source",
      aiRevenue: 1200,
      aiRevenueGrowthPct: -4.5,
      aiRevenueSource: "revenue source",
      grossMargin: 72.25,
      operatingMargin: 31.5,
      marginSource: "margin source",
      inventory: 900,
      inventoryTurnover: 2.4,
      inventorySource: "inventory source",
      revenueGuidance: 8000,
      epsGuidance: 2.35,
      guidanceText: "guidance",
      impactScore: 9,
      impactRationale: "Material capex increase",
      keyTakeaways: ["Capex increased", "Margins softened", "Third takeaway is omitted"],
    });

    expect(formatted).toContain("$500M");
    expect(formatted).toContain("$650M");
    expect(formatted).toContain("(-4.5% YoY)");
    expect(formatted).toContain("72.3%");
    expect(formatted).toContain("31.5%");
    expect(formatted).toContain("$900M");
    expect(formatted).toContain("$8000M");
    expect(formatted).toContain("$2.35");
    expect(formatted).toContain("Capex increased • Margins softened");
    expect(formatted).toContain("HIGH IMPACT");
    expect(formatted).not.toContain("Third takeaway is omitted");
  });
});
