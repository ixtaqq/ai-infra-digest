import { config } from "../config";
import { logger } from "../utils/logger";
import { withRetry, HttpError, isRetryableStatus } from "../utils/retry";
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

    const batchNum = Math.floor(i / EMBED_BATCH_SIZE) + 1;

    try {
      const data = await withRetry(
        async () => {
          const resp = await fetch(EMBED_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({ model: config.ai.embeddingModel, input: inputs }),
          });

          if (!resp.ok) {
            throw new HttpError(resp.status, `HTTP ${resp.status}`);
          }

          return (await resp.json()) as { data: { index: number; embedding: number[] }[] };
        },
        {
          label: `embeddings batch ${batchNum}`,
          shouldRetry: (err) => err instanceof HttpError && isRetryableStatus(err.status),
        }
      );

      for (const item of data.data) {
        if (!batch[item.index]) continue;
        result.set(batch[item.index].url, item.embedding);
      }
    } catch (err) {
      logger.warn(`Embeddings batch ${batchNum} failed: ${(err as Error).message}`);
      if (err instanceof HttpError && err.status === 429) {
        // A 429 that survives full-jitter retries is a quota problem, not a blip.
        logger.warn(
          "Embeddings: persistent HTTP 429 from OpenAI — the OPENAI_EMBEDDING_API_KEY account is out of quota/credits. " +
            "Phase VIII features (semantic dedup, relevance gate, corroboration) will silently degrade until quota is restored. " +
            "Aborting remaining embedding batches for this run."
        );
        break;
      }
      continue;
    }
  }

  if (result.size === 0 && articles.length > 0) {
    // Configured (key present) but produced nothing — a fully degraded run, not
    // the graceful "not configured" skip above. Log at WARN; the caller also
    // emits a structured error event so this surfaces in metrics, not just stdout.
    logger.warn(
      `Embeddings: 0/${articles.length} vectors generated — Phase VIII degraded this run ` +
        `(likely OpenAI quota/429 on OPENAI_EMBEDDING_API_KEY). Falling back to Jaccard for dedup/corroboration.`
    );
  } else {
    logger.info(`Embeddings: generated ${result.size}/${articles.length} vectors`);
  }
  return result;
}
