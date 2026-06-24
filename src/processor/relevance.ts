import { config } from "../config";
import { logger } from "../utils/logger";
import { cosineSimilarity } from "../utils/dedup";

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

export async function embedSeeds(): Promise<number[][]> {
  const key = config.ai.embeddingApiKey;
  if (!key) return [];

  const resp = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model: config.ai.embeddingModel, input: RELEVANCE_SEEDS }),
  });

  if (!resp.ok) {
    logger.warn(`Seed embedding failed: HTTP ${resp.status}`);
    return [];
  }

  const data = (await resp.json()) as { data: { index: number; embedding: number[] }[] };
  const result: number[][] = new Array(RELEVANCE_SEEDS.length);
  for (const item of data.data) {
    result[item.index] = item.embedding;
  }
  return result;
}

export function passesSemanticGate(
  articleEmbedding: number[],
  seedEmbeddings: number[][]
): boolean {
  return seedEmbeddings.some(
    (seed) => cosineSimilarity(articleEmbedding, seed) >= GATE_THRESHOLD
  );
}
