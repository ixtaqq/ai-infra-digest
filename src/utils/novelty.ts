import { jaccardSimilarity } from "./dedup";
import { config } from "../config";
import { logger } from "./logger";
import type { ProcessedArticle } from "../processor/ai";

const REHASH_WINDOW_HOURS = 48;
// Lower than the dedup threshold (0.65) — catches same story, different headline
const REHASH_THRESHOLD = 0.5;

export async function flagRehashes(articles: ProcessedArticle[]): Promise<void> {
  const url = config.app.supabaseUrl;
  const key = config.app.supabaseServiceKey;
  if (!url || !key) return;

  const cutoff = new Date(Date.now() - REHASH_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

  const resp = await fetch(
    `${url}/rest/v1/articles?select=title&created_at=gte.${cutoff}&limit=500`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!resp.ok) return;

  const rows = (await resp.json()) as { title: string }[];
  if (!rows.length) return;

  const recentTitles = rows.map((r) => r.title);
  let flagged = 0;

  for (const article of articles) {
    const isRehash = recentTitles.some(
      (recent) => jaccardSimilarity(article.title, recent) >= REHASH_THRESHOLD
    );
    if (isRehash) {
      article.isRehash = true;
      flagged++;
    }
  }

  if (flagged > 0) {
    logger.info(`Novelty check: flagged ${flagged}/${articles.length} articles as rehashes (48h window)`);
  }
}
