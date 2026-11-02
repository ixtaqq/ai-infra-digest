import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config", () => ({ config: { app: {} } }));
vi.mock("../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Avoid real 150ms rate-limit gaps between requests in tests.
vi.mock("../utils/helpers", () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { collectSECFilings, fetchCompanyFilings, get8KFilings, getTopFilings, INTERESTING_FORM_TYPES, TRACKED_COMPANIES } from "./sec";
import { sleep } from "../utils/helpers";
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

// Shapes below are trimmed from real EDGAR responses (AMZN, MSFT, META, ARM, TSM; 2026).
const IXBRL_HIDDEN = "us-gaap:AccumulatedGainLossNetCashFlowHedgeParentMember";
const inlineXbrl8K = `<?xml version="1.0" ?><html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL"><head><title>msft-20261028</title><style>p { margin: 0 }</style></head>
<body><div style="display:none"><ix:header><ix:hidden><ix:nonNumeric contextRef="c0" name="dei:AmendmentFlag">false</ix:nonNumeric><ix:nonNumeric contextRef="c0" name="dei:EntityCentralIndexKey">0000789019</ix:nonNumeric></ix:hidden><ix:references><link:schemaRef xlink:href="msft-20261028.xsd"/></ix:references><ix:resources><xbrli:context id="c1"><xbrli:segment><xbrldi:explicitMember dimension="us-gaap:StatementEquityComponentsAxis">${IXBRL_HIDDEN}</xbrldi:explicitMember></xbrli:segment></xbrli:context></ix:resources></ix:header></div>
<p>Item 2.02. Results of Operations and Financial Condition. The press release is furnished as Exhibit 99.1.</p></body></html>`;

const pressRelease = `<html><body><p>Amazon.com Announces Third Quarter Results</p>
<p>Net sales increased 13% to &#36;180.2&#160;billion. Operating income was $&#160;17.4 billion.</p></body></html>`;

function filingIndex(dir: string, rows: [seq: string, description: string, href: string, type: string][]) {
  const body = rows.map(([seq, description, href, type]) =>
    `<tr><td scope="row">${seq}</td><td scope="row">${description}</td><td scope="row"><a href="${href}">${href.split("/").pop()}</a></td><td scope="row">${type}</td><td scope="row">1000</td></tr>`
  ).join("\n");
  return `<html><body><table class="tableFile" summary="Document Format Files"><tr><th scope="col">Seq</th><th scope="col">Description</th><th scope="col">Document</th><th scope="col">Type</th><th scope="col">Size</th></tr>${body}
<tr><td scope="row">&nbsp;</td><td scope="row">Complete submission text file</td><td scope="row"><a href="${dir}/full.txt">full.txt</a></td><td scope="row">&nbsp;</td><td scope="row">9000</td></tr></table></body></html>`;
}

const DIR = "/Archives/edgar/data/1045810/000104581026000123";
const PRIMARY_URL = `https://www.sec.gov${DIR}/nvda-8k.htm`;
const INDEX_URL = `https://www.sec.gov${DIR}/0001045810-26-000123-index.htm`;

function stubFiling(items: string, pages: Record<string, string | number>, form = "8-K") {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("data.sec.gov/submissions")) return submissionsResponse({ items: [items], form: [form] });
    const page = pages[url];
    if (typeof page === "string") return htmlResponse(page);
    return new Response(null, { status: page ?? 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("filing text extraction", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("drops the hidden ix:header block so XBRL metadata never reaches the AI", async () => {
    stubFiling("5.02", { [PRIMARY_URL]: inlineXbrl8K });

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).not.toContain(IXBRL_HIDDEN);
    expect(filings[0].rawText).not.toContain("0000789019");
    expect(filings[0].rawText).not.toContain("margin: 0");
    expect(filings[0].rawText).not.toContain("msft-20261028");
    expect(filings[0].rawText).toContain("Item 2.02. Results of Operations");
  });

  it("removes zero-width padding, which would otherwise use up the text budget", async () => {
    stubFiling("5.02", { [PRIMARY_URL]: "<p>High&#8203; &#8203; &#8203;price &#x200B;$207.47</p>" });

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).toBe("High price $207.47");
  });

  it("decodes numeric entities so dollar figures survive", async () => {
    stubFiling("5.02", { [PRIMARY_URL]: pressRelease });

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).toContain("$180.2 billion");
    expect(filings[0].rawText).toContain("$ 17.4 billion");
  });
});

describe("press-release exhibits", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("leads an Item 2.02 8-K with its EX-99.1, ahead of the cover document", async () => {
    const exhibitUrl = `https://www.sec.gov${DIR}/q3-release.htm`;
    const fetchMock = stubFiling("2.02,9.01", {
      [PRIMARY_URL]: inlineXbrl8K,
      [INDEX_URL]: filingIndex(DIR, [
        ["1", "8-K", `/ix?doc=${DIR}/nvda-8k.htm`, "8-K"],
        ["2", "EX-99.1", `${DIR}/q3-release.htm`, "EX-99.1"],
        ["8", "LOGO", `${DIR}/logo.jpg`, "GRAPHIC"],
      ]),
      [exhibitUrl]: pressRelease,
    });

    const { filings } = await fetchCompanyFilings(company);

    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(exhibitUrl);
    expect(filings[0].rawText.indexOf("$180.2 billion")).toBeGreaterThanOrEqual(0);
    expect(filings[0].rawText.indexOf("$180.2 billion")).toBeLessThan(filings[0].rawText.indexOf("Item 2.02."));
    expect(filings[0].items).toEqual(["2.02", "9.01"]);
    expect(filings[0].textIncomplete).toBeFalsy();
    expect(filings[0].primaryDocumentUrl).toBe(PRIMARY_URL);
  });

  it("picks the EX-99 exhibit over an earlier EX-10 and accepts a bare EX-99 type", async () => {
    const exhibitUrl = `https://www.sec.gov${DIR}/a991results.htm`;
    const fetchMock = stubFiling("1.01,2.02,8.01,9.01", {
      [PRIMARY_URL]: inlineXbrl8K,
      [INDEX_URL]: filingIndex(DIR, [
        ["1", "8-K", `/ix?doc=${DIR}/nvda-8k.htm`, "8-K"],
        ["2", "EX-10.1", `${DIR}/credit-agreement.htm`, "EX-10.1"],
        ["3", "EX-99.1", `${DIR}/a991results.htm`, "EX-99"],
      ]),
      [exhibitUrl]: pressRelease,
    });

    const { filings } = await fetchCompanyFilings(company);

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls).toContain(exhibitUrl);
    expect(urls.some((url) => url.includes("credit-agreement"))).toBe(false);
    expect(filings[0].rawText).toContain("$180.2 billion");
  });

  it("follows an exhibit listed through the iXBRL viewer link", async () => {
    const exhibitUrl = `https://www.sec.gov${DIR}/ex991.htm`;
    stubFiling("2.02", {
      [PRIMARY_URL]: inlineXbrl8K,
      [INDEX_URL]: filingIndex(DIR, [["2", "EX-99.1", `/ix?doc=${DIR}/ex991.htm`, "EX-99.1"]]),
      [exhibitUrl]: pressRelease,
    });

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).toContain("$180.2 billion");
  });

  it("does not fetch an index for an 8-K item that carries no results exhibit", async () => {
    const fetchMock = stubFiling("5.02", { [PRIMARY_URL]: inlineXbrl8K });

    await fetchCompanyFilings(company);

    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(INDEX_URL);
  });

  it("collects a 6-K with its exhibit (TSM's quarterly results shape)", async () => {
    const exhibitUrl = `https://www.sec.gov${DIR}/a3q26e.htm`;
    stubFiling("", {
      [PRIMARY_URL]: "<p>Form 6-K cover page for Taiwan Semiconductor.</p>",
      [INDEX_URL]: filingIndex(DIR, [
        ["1", "6-K", `${DIR}/nvda-8k.htm`, "6-K"],
        ["2", "EX-99.1", `${DIR}/a3q26e.htm`, "EX-99.1"],
      ]),
      [exhibitUrl]: "<p>Revenue was US$33.1 billion.</p>",
    }, "6-K");

    const { status, filings } = await fetchCompanyFilings(company);

    expect(INTERESTING_FORM_TYPES.has("6-K")).toBe(true);
    expect(status).toBe("success");
    expect(filings[0].formType).toBe("6-K");
    expect(filings[0].rawText.startsWith("Revenue was US$33.1 billion.")).toBe(true);
    expect(filings[0].textIncomplete).toBeFalsy();
  });

  it("keeps the primary text of a 6-K whose index lists no exhibit", async () => {
    stubFiling("", {
      [PRIMARY_URL]: "<p>September revenue was NT$330.98 billion.</p>",
      [INDEX_URL]: filingIndex(DIR, [["1", "6-K", `${DIR}/nvda-8k.htm`, "6-K"]]),
    }, "6-K");

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).toBe("September revenue was NT$330.98 billion.");
    expect(filings[0].textIncomplete).toBeFalsy();
  });

  it("marks text incomplete when the exhibit cannot be fetched, keeping the primary text", async () => {
    stubFiling("2.02,9.01", { [PRIMARY_URL]: inlineXbrl8K, [INDEX_URL]: 503 });

    const { status, filings } = await fetchCompanyFilings(company);

    expect(status).toBe("success");
    expect(filings[0].rawText).toContain("Item 2.02.");
    expect(filings[0].textIncomplete).toBe(true);
  });

  it("marks text incomplete when the primary document cannot be downloaded", async () => {
    stubFiling("5.02", { [PRIMARY_URL]: 500 });

    const { filings } = await fetchCompanyFilings(company);

    expect(filings[0].rawText).toBe("");
    expect(filings[0].textIncomplete).toBe(true);
  });
});

describe("processed filings", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("skips processed accessions without downloading them, and they do not use the per-company cap", async () => {
    const today = new Date().toISOString().split("T")[0];
    const accessions = ["a-1", "a-2", "a-3", "a-4", "a-5"];
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("data.sec.gov/submissions")
        ? submissionsResponse({
          accessionNumber: accessions,
          filingDate: accessions.map(() => today),
          form: accessions.map(() => "8-K"),
          primaryDocument: accessions.map((a) => `${a}.htm`),
          primaryDocDescription: accessions.map(() => "8-K"),
          items: accessions.map(() => "5.02"),
        })
        : htmlResponse("<p>Body</p>"));
    vi.stubGlobal("fetch", fetchMock);

    const { filings } = await fetchCompanyFilings(company, new Set(["a-1", "a-2"]));

    expect(filings.map((f) => f.accessionNumber)).toEqual(["a-3", "a-4", "a-5"]);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls.some((url) => url.includes("a-1.htm") || url.includes("a-2.htm"))).toBe(false);
  });

  it("threads the processed set through collectSECFilings", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("data.sec.gov/submissions") ? submissionsResponse({ items: ["5.02"] }) : htmlResponse("<p>Body</p>"));
    vi.stubGlobal("fetch", fetchMock);

    const { newFilings } = await collectSECFilings(new Set(["0001045810-26-000123"]));

    expect(newFilings).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(TRACKED_COMPANIES.length);
  });
});

describe("EDGAR throttle", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives concurrent requests, including document downloads, distinct 150ms slots", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000); // Past any slot reserved by an earlier test
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("data.sec.gov/submissions") ? submissionsResponse({ items: ["5.02"] }) : htmlResponse("<p>Body</p>"));
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([fetchCompanyFilings(company), fetchCompanyFilings({ ...company, ticker: "AMD", cik: "0000002488" })]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const delays = vi.mocked(sleep).mock.calls.map(([ms]) => ms).sort((a, b) => a - b);
    expect(delays).toEqual([150, 300, 450]);
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

  it("ranks a 6-K with 8-Ks, since foreign filers report material events on it", () => {
    const top = getTopFilings([filing({ formType: "10-Q" }), filing({ formType: "6-K" })], 2);
    expect(top[0].formType).toBe("6-K");
  });

  it("respects the maxCount cap", () => {
    const filings = [filing({}), filing({}), filing({}), filing({})];
    expect(getTopFilings(filings, 2)).toHaveLength(2);
  });
});

describe("8-K item parsing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decodes filing entities once", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(submissionsResponse())
      .mockResolvedValueOnce(htmlResponse("<p>R&amp;D &amp;lt;b&amp;gt;</p>")));
    const result = await fetchCompanyFilings(company);
    expect(result.filings[0].rawText).toContain("R&D &lt;b&gt;");
  });

  it("splits EDGAR's comma-separated items so earnings 8-Ks are recognised", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(submissionsResponse({ items: ["2.02,9.01"] }))
      .mockResolvedValueOnce(htmlResponse("<p>Results</p>")));
    const result = await fetchCompanyFilings(company);
    expect(result.filings[0].items).toEqual(["2.02", "9.01"]);
  });
});
