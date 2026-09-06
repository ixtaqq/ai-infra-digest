import { accountedFetch } from "../utils/ai-accounting";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { config } from "../config";
import { logger } from "../utils/logger";
import { cosineSimilarity } from "../utils/dedup";
import { withRetry, HttpError, isRetryableStatus } from "../utils/retry";

const EMBED_URL = "https://api.openai.com/v1/embeddings";
const GATE_THRESHOLD = 0.55;

// 20 canonical AI infrastructure topic sentences
export const RELEVANCE_SEEDS = [
  "GPU supply chain and chip manufacturing capacity",
  "Large language model training infrastructure and compute clusters",
  "Data center construction power capacity and cooling",
  "Cloud hyperscaler capital expenditure and infrastructure investment",
  "AI accelerator chip design architecture and roadmap",
  "Semiconductor fabrication process nodes and yield rates",
  "NVIDIA AMD Intel GPU availability pricing and allocation",
  "TSMC Samsung foundry capacity and advanced packaging",
  "High bandwidth memory HBM supply and stacking technology",
  "Networking interconnect InfiniBand Ethernet for AI clusters",
  "Liquid cooling thermal management for high-density AI servers",
  "Transformer model scaling laws and training compute requirements",
  "Inference deployment serving infrastructure latency throughput",
  "Power grid utility electricity demand from AI data centers",
  "Sovereign AI national compute strategy government investment",
  "AI chip export controls sanctions and geopolitical supply risk",
  "Hyperscaler earnings guidance cloud revenue AI-driven capex",
  "Startup funding for AI infrastructure hardware and systems",
  "Open source model weights compute implications and deployment",
  "Edge AI on-device inference hardware and chips",
];

function seedCacheKey(): string {
  const hash = crypto
    .createHash("sha256")
    .update(RELEVANCE_SEEDS.join("|") + config.ai.embeddingModel)
    .digest("hex")
    .slice(0, 16);
  return hash;
}

function seedCachePath(): string {
  return path.join(config.app.cacheDir, "seed-embeddings.json");
}

function loadSeedCache(): { key: string; embeddings: number[][] } | null {
  try {
    const raw = fs.readFileSync(seedCachePath(), "utf8");
    return JSON.parse(raw) as { key: string; embeddings: number[][] };
  } catch {
    return null;
  }
}

function saveSeedCache(embeddings: number[][]): void {
  try {
    fs.mkdirSync(config.app.cacheDir, { recursive: true });
    fs.writeFileSync(seedCachePath(), JSON.stringify({ key: seedCacheKey(), embeddings }));
  } catch {
    // Non-critical — ignore write failures
  }
}

export async function embedSeeds(): Promise<number[][]> {
  const key = config.ai.embeddingApiKey;
  if (!key) return [];

  // Return cached embeddings if seed list + model haven't changed
  const cached = loadSeedCache();
  if (cached && cached.key === seedCacheKey()) {
    logger.info("Seed embeddings: cache hit — skipping OpenAI call");
    return cached.embeddings;
  }

  try {
    const data = await withRetry(
      async () => {
        const resp = await accountedFetch("relevance", "openai")(EMBED_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ model: config.ai.embeddingModel, input: RELEVANCE_SEEDS }),
        });

        if (!resp.ok) {
          throw new HttpError(resp.status, `HTTP ${resp.status}`);
        }

        return (await resp.json()) as { data: { index: number; embedding: number[] }[] };
      },
      {
        label: "seed embeddings",
        shouldRetry: (err) => err instanceof HttpError && isRetryableStatus(err.status),
      }
    );

    const result: number[][] = new Array(RELEVANCE_SEEDS.length);
    for (const item of data.data) {
      result[item.index] = item.embedding;
    }

    saveSeedCache(result);
    return result;
  } catch (err) {
    logger.warn(`Seed embedding failed: ${(err as Error).message}`);
    return [];
  }
}

export function passesSemanticGate(
  articleEmbedding: number[],
  seedEmbeddings: number[][]
): boolean {
  return seedEmbeddings.some(
    (seed) => cosineSimilarity(articleEmbedding, seed) >= GATE_THRESHOLD
  );
}
