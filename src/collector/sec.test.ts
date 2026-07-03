import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({ config: { app: {} } }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Avoid real 150ms rate-limit gaps between requests in tests.
vi.mock("../utils/helpers", () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { fetchCompanyFilings, get8KFilings, getTopFilings } from "./sec";
import type { SECFiling } from "./sec";

const company = { ticker: "NVDA", name: "NVIDIA Corporation", cik: "0001045810", tier: 1 as const };

function submissionsResponse(overrides: Partial<{
  accessionNumber: string[];
  filingDate: string[];
  form: string[];
  primaryDocument: string[];
  primaryDocDescription: string[];
  items: string[];
}> = {}) {
  const recent = {
    accessionNumber: ["0001045810-26-000123"],
    filingDate: [new Date().toISOString().split("T")[0]], // today — well within 60 days
    form: ["8-K"],
    primaryDocument: ["nvda-8k.htm"],
    primaryDocDescription: ["Results of Operations"],
    items: ["2.02"],
    ...overrides,
  };
  return new Response(
    JSON.stringify({ cik: company.cik, name: company.name, filings: { recent } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function htmlResponse(text: string) {
  return new Response(text, { status: 200, headers: { "content-type": "text/html" } });
}

describe("fetchCompanyFilings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("returns a success result with a downloaded, tag-stripped filing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(submissionsResponse())
      .mockResolvedValueOnce(htmlResponse("<html><body><p>Capex was $500M this quarter.</p></body></html>"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCompanyFilings(company);

    expect(result.status).toBe("success");
    expect(result.filings).toHaveLength(1);
    expect(result.filings[0].rawText).toContain("Capex was $500M this quarter.");
    expect(result.filings[0].rawText).not.toContain("<p>");
  });

  it("returns no_new_filings when the submissions API has no recent filings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(submissionsResponse({ accessionNumber: [] })));

    const result = await fetchCompanyFilings(company);
    expect(result.status).toBe("no_new_filings");
    expect(result.filings).toEqual([]);
  });

  it("skips filings older than 60 days", async () => {
    const oldDate = new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(submissionsResponse({ filingDate: [oldDate] })));

    const result = await fetchCompanyFilings(company);
    expect(result.status).toBe("no_new_filings");
    expect(result.filings).toEqual([]);
  });

  it("ignores form types outside the tracked set (e.g. a 4)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(submissionsResponse({ form: ["4"] })));

    const result = await fetchCompanyFilings(company);
    expect(result.status).toBe("no_new_filings");
  });

  it("still includes the filing (with empty text) when document download fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(submissionsResponse())
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCompanyFilings(company);
    expect(result.status).toBe("success");
    expect(result.filings[0].rawText).toBe("");
  });

  it("returns a failed result when the submissions API itself errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));

    const result = await fetchCompanyFilings(company);
    expect(result.status).toBe("failed");
    expect(result.error).toBeDefined();
  });
});

describe("get8KFilings", () => {
  it("keeps only 8-K filings", () => {
    const filings = [
      { formType: "8-K" } as SECFiling,
      { formType: "10-Q" } as SECFiling,
      { formType: "8-K" } as SECFiling,
    ];
    expect(get8KFilings(filings)).toHaveLength(2);
  });
});

describe("getTopFilings", () => {
  function filing(overrides: Partial<SECFiling>): SECFiling {
    return {
      cik: "1", ticker: "T", companyName: "Test Co", formType: "10-Q",
      filingDate: new Date().toISOString().split("T")[0], accessionNumber: "1",
      primaryDocumentUrl: "u", items: [], rawText: "", description: "",
      ...overrides,
    };
  }

  it("prioritizes 8-K over 10-K over 10-Q", () => {
    const filings = [filing({ formType: "10-K" }), filing({ formType: "10-Q" }), filing({ formType: "8-K" })];
    const top = getTopFilings(filings, 3);
    expect(top[0].formType).toBe("8-K");
    expect(top[1].formType).toBe("10-K");
    expect(top[2].formType).toBe("10-Q");
  });

  it("gives an earnings-item bonus that outranks a same-type filing without one", () => {
    const withEarnings = filing({ formType: "8-K", items: ["2.02"] });
    const withoutEarnings = filing({ formType: "8-K", items: ["5.02"] });
    const top = getTopFilings([withoutEarnings, withEarnings], 2);
    expect(top[0]).toBe(withEarnings);
  });

  it("respects the maxCount cap", () => {
    const filings = [filing({}), filing({}), filing({}), filing({})];
    expect(getTopFilings(filings, 2)).toHaveLength(2);
  });
});
