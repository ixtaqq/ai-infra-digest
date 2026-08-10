import { NEWS_CATEGORIES } from "../processor/ai";
import type { DigestResult, NewsCategory } from "../processor/ai";
import type { UserPreferencesData } from "../utils/supabase";

export interface PersonalizationResult {
  applied: boolean;
  digest: DigestResult;
  note: string;
  length: "brief" | "standard" | "detailed";
}

export function personalizeDigest(
  digest: DigestResult,
  prefs: UserPreferencesData
): PersonalizationResult {
  const length = prefs.digest_length ?? "standard";
  const applied =
    (prefs.min_impact_score ?? 0) > 0 ||
    (prefs.categories_enabled?.length ?? 0) > 0 ||
    (prefs.watchlist?.length ?? 0) > 0 ||
    length !== "standard";

  if (!applied) return { applied: false, digest, note: "", length };

  let articles = digest.articles;
  const minScore = prefs.min_impact_score ?? 0;
  if (minScore > 0) articles = articles.filter((article) => article.impactScore >= minScore);

  const enabledCategories = prefs.categories_enabled ?? [];
  if (enabledCategories.length > 0) {
    articles = articles.filter((article) => enabledCategories.includes(article.category));
  }

  const watchlist = (prefs.watchlist ?? []).map((ticker) => ticker.toUpperCase());
  let topStocks = digest.topStocks;
  if (watchlist.length > 0) {
    const isWatched = (tickers: string[]) =>
      tickers.some((ticker) => watchlist.includes(ticker.toUpperCase()));
    topStocks = [
      ...topStocks.filter((stock) => watchlist.includes(stock.ticker.toUpperCase())),
      ...topStocks.filter((stock) => !watchlist.includes(stock.ticker.toUpperCase())),
    ].slice(0, 5);
    articles = [
      ...articles.filter((article) => isWatched(article.affectedStocks)),
      ...articles.filter((article) => !isWatched(article.affectedStocks)),
    ];
  }

  articles = articles.map((article) => ({
    ...article,
    summary: length === "brief" ? trimSummary(article.summary, 80) : article.summary,
    reason: length === "detailed" ? article.reason : "",
  }));

  const categories = {} as DigestResult["categories"];
  for (const category of NEWS_CATEGORIES) categories[category as NewsCategory] = [];
  for (const article of articles) {
    const category = (article.category || NEWS_CATEGORIES[0]) as NewsCategory;
    categories[category].push(article);
  }

  return {
    applied: true,
    digest: { ...digest, articles, topStocks, categories },
    note: buildPersonalizationNote(prefs),
    length,
  };
}

function buildPersonalizationNote(prefs: UserPreferencesData): string {
  const parts: string[] = [];
  const watchlist = prefs.watchlist ?? [];
  const categories = prefs.categories_enabled ?? [];
  const minScore = prefs.min_impact_score ?? 0;
  if (watchlist.length > 0) parts.push(`watchlist: ${watchlist.join(", ")}`);
  if (categories.length > 0) parts.push(`sectors: ${categories.join(", ")}`);
  if (minScore > 0) parts.push(`min score: ${minScore}/10`);
  if ((prefs.digest_length ?? "standard") !== "standard") {
    parts.push(`${prefs.digest_length} digest`);
  }
  return parts.length > 0 ? `Filtered for you — ${parts.join(" · ")}` : "";
}

function trimSummary(text: string, limit: number): string {
  if (!text || text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, "") + "…";
}
