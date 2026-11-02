import { z } from "zod";
import { fetchCompanyFilings, TRACKED_COMPANIES } from "../src/collector/sec";
import { fetchStockPrices } from "../src/utils/stocks";

const SEC_HEADERS = { "User-Agent": "AI-Infra-Digest/2.0 (contract check; contact: ai-infra@example.com)" };
const YAHOO_HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };

const YahooChart = z.object({ chart: z.object({ result: z.array(z.object({
  meta: z.object({ regularMarketPrice: z.number().positive(), regularMarketTime: z.number() }),
  timestamp: z.array(z.number()).min(2),
  indicators: z.object({ quote: z.array(z.object({ close: z.array(z.number().nullable()).min(2) })).min(1) }),
})).length(1) }) });

const EdgarTickers = z.record(z.string(), z.object({ cik_str: z.number(), ticker: z.string() }));

const EdgarSubmissions = z.object({ filings: z.object({ recent: z.object({
  accessionNumber: z.array(z.string()).min(1),
  filingDate: z.array(z.string()).min(1),
  form: z.array(z.string()).min(1),
  primaryDocument: z.array(z.string()).min(1),
  primaryDocDescription: z.array(z.string()),
  items: z.array(z.string()),
}) }) });

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

const CHECKS: [string, () => Promise<string>][] = [
  ["Yahoo chart response shape", async () => {
    const chart = YahooChart.parse(await getJson(
      "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=5d&interval=1d", YAHOO_HEADERS));
    return `${chart.chart.result[0].indicators.quote[0].close.length} closes`;
  }],
  ["Quotes show real movement", async () => {
    const quotes = [...(await fetchStockPrices(["NVDA", "MSFT", "AMD", "AVGO", "TSM"])).values()];
    if (quotes.length < 3) throw new Error(`only ${quotes.length} of 5 quotes returned`);
    if (quotes.every((quote) => quote.changePercent === 0)) throw new Error("every quote shows 0% change");
    return quotes.map((quote) => `${quote.ticker} ${quote.changePercent.toFixed(2)}%`).join(", ");
  }],
  ["Tracked CIKs match EDGAR", async () => {
    const listed = new Map(Object.values(EdgarTickers.parse(
      await getJson("https://www.sec.gov/files/company_tickers.json", SEC_HEADERS)
    )).map((company) => [company.ticker, company.cik_str]));
    const wrong = TRACKED_COMPANIES.filter((company) =>
      listed.has(company.ticker) && listed.get(company.ticker) !== Number(company.cik));
    if (wrong.length) {
      throw new Error(wrong.map((company) =>
        `${company.ticker} has ${Number(company.cik)}, EDGAR has ${listed.get(company.ticker)}`).join("; "));
    }
    const unlisted = TRACKED_COMPANIES.filter((company) => !listed.has(company.ticker)).map((company) => company.ticker);
    return `${TRACKED_COMPANIES.length - unlisted.length} match, unlisted: ${unlisted.join(", ") || "none"}`;
  }],
  ["EDGAR submissions response shape", async () => {
    const recent = EdgarSubmissions.parse(await getJson(
      "https://data.sec.gov/submissions/CIK0001045810.json", SEC_HEADERS)).filings.recent;
    return `${recent.form.length} recent filings`;
  }],
  ["Filing collector still parses EDGAR", async () => {
    const company = TRACKED_COMPANIES.find((entry) => entry.ticker === "MSFT")!;
    const result = await fetchCompanyFilings(company);
    if (result.status === "failed") throw new Error(result.error ?? "collector failed");
    return `${result.status}, ${result.filings.length} filings`;
  }],
];

async function main() {
  let failures = 0;
  for (const [name, check] of CHECKS) {
    try {
      console.log(`PASS ${name}: ${await check()}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${name}: ${(error as Error).message}`);
    }
  }
  console.log(`${CHECKS.length - failures}/${CHECKS.length} live contract checks passed`);
  process.exit(failures ? 1 : 0);
}

main();
