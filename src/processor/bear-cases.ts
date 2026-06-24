/**
 * Devil's Advocate — generates a skeptical bear case for high-impact articles.
 *
 * For each article scoring >= BEAR_CASE_THRESHOLD, a single batched AI call
 * asks for the strongest 1-2 sentence counter-argument: what could go wrong,
 * what's overblown, or why the market may already know. Results are attached
 * to ProcessedArticle.bearCase before formatting and persistence.
 *
 * Runs as a tryStage in generateDigest() — failure never blocks delivery.
 */

import { config } from "../config";
import { logger } from "../utils/logger";
import type { ProcessedArticle } from "./ai";

const BEAR_CASE_THRESHOLD = 7;
const MAX_ARTICLES = 6; // bound token cost to ~800 tokens per run

interface BearCaseRow {
  url: string;
  bearCase: string;
}

function buildPrompt(articles: ProcessedArticle[]): string {
  const items = articles
    .map(
      (a, i) =>
        `${i + 1}. URL: ${a.url}\n` +
        `   Title: ${a.title}\n` +
        `   Summary: ${a.summary.slice(0, 200)}\n` +
        `   Impact: ${a.impact} (${a.impactScore}/10)`
    )
    .join("\n\n");

  return (
    `You are a skeptical institutional investor. For each article, write the strongest 1-2 sentence bear case: ` +
    `what could go wrong, what is overblown, or why this news may already be priced in. ` +
    `Be specific and concise. Avoid generic disclaimers.\n\n` +
    `Return valid JSON only:\n` +
    `{ "results": [ { "url": "...", "bearCase": "..." } ] }\n\n` +
    `Articles:\n${items}`
  );
}

function parseResponse(text: string): BearCaseRow[] {
  // Strip markdown code fences if present
  const clean = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
  try {
    const parsed = JSON.parse(clean) as { results?: BearCaseRow[] };
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

export async function generateBearCases(
  articles: ProcessedArticle[]
): Promise<Map<string, string>> {
  const qualifying = articles
    .filter((a) => a.impactScore >= BEAR_CASE_THRESHOLD)
    .slice(0, MAX_ARTICLES);

  if (!qualifying.length) return new Map();

  const url = config.ai.baseUrl || "https://api.groq.com/openai/v1";
  const key = config.ai.apiKey;
  if (!key) return new Map();

  const prompt = buildPrompt(qualifying);

  try {
    const res = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: "system", content: "You are an equity research AI. Always respond with valid JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.4,
        max_tokens: 1024,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      logger.warn(`bear-cases: AI HTTP ${res.status}`);
      return new Map();
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    const rows = parseResponse(content);

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.url && row.bearCase) {
        map.set(row.url, row.bearCase.slice(0, 300));
      }
    }

    logger.info(
      `Bear cases: generated ${map.size} for ${qualifying.length} qualifying articles (score ≥${BEAR_CASE_THRESHOLD})`
    );
    return map;
  } catch (err) {
    logger.warn(`bear-cases: ${(err as Error).message}`);
    return new Map();
  }
}
