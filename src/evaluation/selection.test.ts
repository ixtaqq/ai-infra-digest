import { expect, it } from "vitest";
import type { Article } from "../collector/rss";
import { selectSourceDiverseArticles } from "./selection";
it("keeps a prolific first feed from excluding every other source", () => {
  const articles = ["A","A","A","B","C"].map((source, i) => ({ source, title: String(i), date: new Date(2026,0,10-i) } as Article));
  expect(selectSourceDiverseArticles(articles, 3).map(row => row.source)).toEqual(["A","B","C"]);
});
