import { config } from "../config";
import { logger } from "../utils/logger";
import type { ProcessedArticle } from "./ai";

const EMBED_BATCH_SIZE = 20;
const EMBED_URL = "https://api.openai.com/v1/embeddings";

export async function generateEmbeddings(
  articles: ProcessedArticle[]
): Promise<Map<string, number[]>> {
  const key = config.ai.embeddingApiKey;
  if (!key) {
    logger.warn("OPENAI_EMBEDDING_API_KEY not set — skipping embeddings");
    return new Map();
  }

  const result = new Map<string, number[]>();

  for (let i = 0; i < articles.length; i += EMBED_BATCH_SIZE) {
    const batch = articles.slice(i, i + EMBED_BATCH_SIZE);
    const inputs = batch.map((a) => `${a.title} ${a.summary}`.trim());

    const resp = await fetch(EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: config.ai.embeddingModel, input: inputs }),
    });

    if (!resp.ok) {
      logger.warn(`Embeddings batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} failed: HTTP ${resp.status}`);
      continue;
    }

    const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
    for (const item of data.data) {
      if (!batch[item.index]) continue;
      result.set(batch[item.index].url, item.embedding);
    }
  }

  logger.info(`Embeddings: generated ${result.size}/${articles.length} vectors`);
  return result;
}
