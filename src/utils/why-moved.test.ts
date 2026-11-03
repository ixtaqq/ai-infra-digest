import { describe, expect, it } from "vitest";
import type { ProcessedArticle } from "../processor/ai";
import type { SECFinancialExtract } from "../processor/sec";
import type { StockPrice } from "./stocks";
import { explainMoves } from "./why-moved";

function prices(moves: Record<string, number>): Map<string, StockPrice> {
  return new Map(Object.entries(moves).map(([ticker, changePercent]) => [
    ticker, { ticker, price: 100, change: changePercent, changePercent, previousClose: 100 },
  ]));
}

function article(ticker: string, title: string, effectiveScore: number): ProcessedArticle {
  return {
    title, url: `https://example.com/${title}`, source: "Test", summary: "", impact: "Neutral",
    impactScore: 5, effectiveScore, affectedStocks: [ticker], reason: "", category: "Chips & GPUs",
  } as ProcessedArticle;
}

function filing(ticker: string, impactScore: number): SECFinancialExtract {
  return {
    ticker, formType: "8-K", filingDate: "2026-11-02", impactScore,
    keyTakeaways: [`${ticker} takeaway`], primaryDocumentUrl: `https://www.sec.gov/${ticker}`,
  } as SECFinancialExtract;
}

describe("explainMoves", () => {
  it("pairs each large move with its best article, largest move first", () => {
    const moves = explainMoves(
      prices({ NVDA: 3.5, MRVL: -12.72 }),
      [article("NVDA", "minor", 2), article("NVDA", "major", 9), article("MRVL", "deal", 7)],
      []
    );

    expect(moves.map((move) => [move.ticker, move.coverage.title])).toEqual([
      ["MRVL", "deal"],
      ["NVDA", "major"],
    ]);
  });

  it("prefers a high-impact filing over an article", () => {
    const [move] = explainMoves(prices({ MRVL: -12.72 }), [article("MRVL", "deal", 9)], [filing("MRVL", 7)]);

    expect(move.coverage).toEqual({ title: "8-K: MRVL takeaway", url: "https://www.sec.gov/MRVL" });
  });

  it("ignores a low-impact filing", () => {
    const [move] = explainMoves(prices({ MRVL: -12.72 }), [article("MRVL", "deal", 9)], [filing("MRVL", 6)]);

    expect(move.coverage.title).toBe("deal");
  });

  it("ignores a story that only mentions the ticker in passing", () => {
    const passing = { ...article("NVDA", "OpenAI rebrands data centers", 9), affectedStocks: ["NVDA", "AMD"] };

    expect(explainMoves(prices({ AMD: -7.52 }), [passing], [])).toEqual([]);
  });

  it("leaves out small moves and moves nothing covers", () => {
    const moves = explainMoves(
      prices({ NVDA: 2.99, AMD: -7.52 }),
      [article("NVDA", "small move", 9), article("TSM", "no price", 9)],
      []
    );

    expect(moves).toEqual([]);
  });

  it("keeps at most three moves", () => {
    const tickers = { A: 3, B: 4, C: 5, D: 6 };
    const moves = explainMoves(
      prices(tickers),
      Object.keys(tickers).map((ticker) => article(ticker, ticker, 5)),
      []
    );

    expect(moves.map((move) => move.ticker)).toEqual(["D", "C", "B"]);
  });
});
