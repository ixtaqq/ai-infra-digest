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

import { analyzeSECFilings, extractionText, flagExcerpt, formatSECExtract } from "./sec";
import { config } from "../config";
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

describe("flagExcerpt", () => {
  it("keeps the opening text when it already shows a dollar figure", () => {
    const text = "Net sales increased 13% to $180.2 billion. " + "x".repeat(5000);
    expect(flagExcerpt(text)).toBe(text.slice(0, 3000));
  });

  it("moves past a figure-free cover page to the first dollar figure", () => {
    const cover = "FORM 10-Q table of contents ".repeat(200);
    const excerpt = flagExcerpt(cover + "Total net sales $ 180,169 and inventory $ 41,000.");
    expect(excerpt).toContain("$ 180,169");
    expect(excerpt.length).toBeLessThanOrEqual(3000);
  });

  it("does not treat a cover page's par value as financial data (real 10-Q shape)", () => {
    const cover = "Common Stock, $0.01 par value per share. Table of contents ".repeat(1) + "x ".repeat(2000);
    const excerpt = flagExcerpt(cover + "Total net sales $ 180,169 $ 158,877 Inventories $ 41,000.");
    expect(excerpt).toContain("$ 180,169");
    expect(excerpt).not.toContain("par value");
  });

  it("recognises euro figures as well as dollars (ASML reports in euros)", () => {
    const text = "x ".repeat(2000) + "Total net sales of €7.5 billion, gross margin 52%.";
    expect(flagExcerpt(text)).toContain("€7.5 billion");
  });

  it("falls back to the opening text when no figure exists", () => {
    expect(flagExcerpt("No numbers here.")).toBe("No numbers here.");
  });
});

describe("extractionText", () => {
  const BUDGET = 14000;
  const padding = (chars: number) => "Business highlights without figures. ".repeat(Math.ceil(chars / 37)).slice(0, chars);

  it("leaves a filing shorter than the budget untouched", () => {
    const text = "Revenue was $5 billion. " + padding(3000);
    expect(extractionText(text)).toBe(text);
  });

  it("reaches guidance past the opening (AMZN shape, guidance at char 14000)", () => {
    const guidance = "Fourth Quarter 2026 Guidance • Net sales are expected to be between $240.0 billion and $247.0 billion. " +
      padding(600) + "We expect capital expenditures to be approximately $220 billion.";
    const text = extractionText("Operating income was $28.1 billion. " + padding(14000) + guidance + padding(26000));

    expect(text).toContain("Operating income was $28.1 billion");
    expect(text).toContain("$240.0 billion and $247.0 billion");
    expect(text).toContain("approximately $220 billion");
  });

  it("reaches a cash-flow capex row, whose figures carry no dollar sign (GOOGL shape)", () => {
    const text = extractionText(padding(20000) + "Purchases of property and equipment (23,953) (17,197) " + padding(9000));
    expect(text).toContain("(23,953)");
  });

  it("keeps the column headers above a capex row (DLR's outlook table shape)", () => {
    const headers = "2026 Outlook As of As of As of As of Top-Line February 5, 2026 April 23, 2026 July 23, 2026 October 29, 2026 ";
    const row = "Development CapEx (Net of Partner Contributions) (4) $3,250 - $3,750 million $4,250 - $4,750 million";
    const text = extractionText(padding(23000) + headers + padding(1300) + row + padding(5000));

    expect(text).toContain("October 29, 2026");
    expect(text).toContain("$4,250 - $4,750 million");
  });

  it("stays within the budget however long the filing is", () => {
    const text = extractionText(
      padding(16000) + "Full year outlook: revenue of $9 billion. " + padding(9000) +
      "Capital expenditures of 1,200. " + padding(400000)
    );
    expect(text).toContain("revenue of $9 billion");
    expect(text).toContain("Capital expenditures of 1,200");
    expect(text.length).toBeLessThanOrEqual(BUDGET + 20);
  });

  it("does not jump to a guidance mention with no figure near it (safe-harbor shape)", () => {
    const text = extractionText(padding(16000) + "Our guidance and outlook are subject to risks. " + padding(16000));
    expect(text).not.toContain("subject to risks");
  });

  it("spends the whole budget on the opening when no later section exists", () => {
    const raw = padding(40000);
    expect(extractionText(raw)).toBe(raw.slice(0, BUDGET));
  });
});

describe("analyzeSECFilings review outcomes", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("sends the flagging pass the dollar figures from a cover-page filing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      chatCompletionResponse(JSON.stringify({ hasFinancialData: false, reason: "no" }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const cover = "FORM 10-Q table of contents with inventory discussion ".repeat(100);

    await analyzeSECFilings([makeFiling({ formType: "10-Q", rawText: cover + "Total net sales $ 180,169." })], 1);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[1].content).toContain("$ 180,169");
  });

  it("reports filings the model or keyword filter rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      chatCompletionResponse(JSON.stringify({ hasFinancialData: false, reason: "cover page only" }))
    ));
    const rejected = makeFiling({ accessionNumber: "ai-no" });
    const noKeywords = makeFiling({ accessionNumber: "kw-no", rawText: "Director resignation." });

    const result = await analyzeSECFilings([rejected, noKeywords], 2);

    expect(result.notFlagged.map((r) => [r.filing.accessionNumber, r.reason])).toEqual([
      ["ai-no", "cover page only"],
      ["kw-no", "No relevant keywords found in filing text"],
    ]);
  });

  it("does not report a rejection based on incomplete or empty text, so it is retried", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      chatCompletionResponse(JSON.stringify({ hasFinancialData: false, reason: "no figures" }))
    ));

    const result = await analyzeSECFilings([
      makeFiling({ accessionNumber: "partial", textIncomplete: true }),
      makeFiling({ accessionNumber: "empty", rawText: "" }),
    ], 2);

    expect(result.notFlagged).toEqual([]);
  });

  it("does not report a filing whose extraction failed, so it is retried", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "yes" })))
      .mockResolvedValueOnce(chatCompletionResponse("not json")));

    const result = await analyzeSECFilings([makeFiling()], 1);

    expect(result.extracts).toEqual([]);
    expect(result.notFlagged).toEqual([]);
  });

  it("tells extraction not to report foreign-currency amounts as USD millions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "yes" })))
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify(extractionPayload())));
    vi.stubGlobal("fetch", fetchMock);

    await analyzeSECFilings([makeFiling({ formType: "6-K", rawText: "Capex was NT$300 billion." })], 1);

    const prompt = JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[1].content as string;
    expect(prompt).toContain("millions of US dollars");
    expect(prompt).toMatch(/another currency[^.]*null/);
  });

  it("sends extraction the guidance from past the opening", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "yes" })))
      .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify(extractionPayload())));
    vi.stubGlobal("fetch", fetchMock);
    const rawText = "Capital expenditure was $5 billion. " + "x ".repeat(8000) +
      "Fourth Quarter Guidance • Net sales are expected to be between $240.0 billion and $247.0 billion.";

    await analyzeSECFilings([makeFiling({ rawText })], 1);

    const prompt = JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[1].content as string;
    expect(prompt).toContain("$240.0 billion and $247.0 billion");
  });

  describe("extraction rules", () => {
    async function extractionPrompt() {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "yes" })))
        .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify(extractionPayload())));
      vi.stubGlobal("fetch", fetchMock);
      await analyzeSECFilings([makeFiling()], 1);
      return JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[1].content as string;
    }

    // Each rule answers a wrong number from the Groq run on live filings.
    it.each([
      ["a range becomes its midpoint (AMZN took the low end of $240-247B)", /range[^.\n]*midpoint/i],
      ["a change is not capex (AMZN's $94.8B year-over-year increase)", /capex[^\n]*(?:change|increase)[^\n]*null/i],
      ["whole-company revenue is not AI revenue (DLR's $1.9B total)", /aiRevenue[^\n]*names?[^\n]*(?:AI|data center)[^\n]*null/i],
      ["the newest outlook column wins (DLR's first of four columns)", /most recent[^.\n]*column/i],
      ["the current period beats comparatives", /current period[^.\n]*column|column[^.\n]*current period/i],
      ["next-quarter fields stay next-quarter (DLR's full-year EPS)", /revenueGuidance[^\n]*epsGuidance[^\n]*next quarter[^\n]*full-year[^\n]*guidanceText/i],
    ])("tells the model: %s", async (_rule, pattern) => {
      expect(await extractionPrompt()).toMatch(pattern);
    });
  });

  describe("token settings", () => {
    const ai = config.ai as { provider: string; model: string; fastModel: string };
    const original = { ...ai };
    afterEach(() => Object.assign(ai, original));

    async function requests() {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify({ hasFinancialData: true, reason: "yes" })))
        .mockResolvedValueOnce(chatCompletionResponse(JSON.stringify(extractionPayload())));
      vi.stubGlobal("fetch", fetchMock);
      await analyzeSECFilings([makeFiling()], 1);
      return fetchMock.mock.calls.map((call) => JSON.parse(call[1].body as string));
    }

    it("uses low reasoning effort on Groq's gpt-oss models, as the digest pass does", async () => {
      Object.assign(ai, { provider: "groq", model: "openai/gpt-oss-120b", fastModel: "openai/gpt-oss-20b" });

      const [flag, extraction] = await requests();

      expect(flag.reasoning_effort).toBe("low");
      expect(extraction.reasoning_effort).toBe("low");
    });

    it("keeps a Groq extraction under its 8000 tokens-per-minute limit, prompt included", async () => {
      Object.assign(ai, { provider: "groq", model: "openai/gpt-oss-120b", fastModel: "openai/gpt-oss-20b" });

      const [, extraction] = await requests();

      // 14000 chars of filing plus the instructions, at a pessimistic 3 chars per token.
      expect(extraction.max_tokens).toBe(2400);
      expect(Math.ceil((14000 + extraction.messages[1].content.length) / 3) + extraction.max_tokens).toBeLessThanOrEqual(8000);
    });

    it("leaves room for a reasoning model that has no reasoning control (OpenRouter run: 4590 tokens)", async () => {
      Object.assign(ai, { provider: "openrouter", model: "nvidia/nemotron-3.5-super-vl:free", fastModel: "liquid/lfm-2.5-2.6b:free" });

      const [flag, extraction] = await requests();

      expect(extraction.max_tokens).toBe(8192);
      expect(flag.max_tokens).toBe(1024);
      expect(flag.reasoning_effort).toBeUndefined();
      expect(extraction.reasoning_effort).toBeUndefined();
    });
  });
});

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
