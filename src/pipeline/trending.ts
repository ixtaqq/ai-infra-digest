export interface TrendingItem {
  entity: string;
  type: "ticker" | "sector" | "company" | "keyword";
  mentionCount: number;
  avgScore: number;
  dominantSentiment: "positive" | "negative" | "neutral";
  topArticles: { title: string; url: string }[];
}
