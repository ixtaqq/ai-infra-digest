/**
 * Devil's Advocate — generates a skeptical bear case for high-impact articles.
 *
 * For each article scoring >= BEAR_CASE_THRESHOLD, a single batched AI call
 * asks for the strongest 1-2 sentence counter-argument: what could go wrong,
 * what's overblown, or why the market may already know. Results are attached
 * to ProcessedArticle.bearCase before formatting and persistence.
 *
 * For the single highest-scoring article, also generates a full bull/bear/context
 * thesis (v9.2 Daily Deep-Dive).
 *
 * Runs as a tryStage in generateDigest() — failure never blocks delivery.
 */

import { z } from "zod";
import { config } from "../config";
import { logger } from "../utils/logger";
import { withRetry, HttpError, isRetryableStatus } from "../utils/retry";
import type { ProcessedArticle } from "./ai";

const BEAR_CASE_THRESHOLD = 7;
const MAX_ARTICLES = 6; // bound token cost to ~800 tokens per run

interface BearCaseRow {
  /** 1-based index matching the article's position in the prompt (see buildPrompt). */
  index: number;
  bearCase?: string;
  bullCase?: string;
  contextNote?: string;
}

// index is coerced (AI occasionally returns "1" instead of 1); bearCase is
// genuinely optional at this layer — the caller drops rows missing it.
const BearCaseRowSchema = z.object({
  index: z.coerce.number(),
  bearCase: z.string().optional().catch(undefined),
  bullCase: z.string().optional().catch(undefined),
  contextNote: z.string().optional().catch(undefined),
});

const ResultsResponseSchema = z.object({
  results: z.array(z.unknown()).catch([]),
});

export interface DeepDiveResult {
  url: string;
  title: string;
  bullCase: string;
  bearCase: string;
  contextNote: string;
}

export interface BearCaseResult {
  bearCases: Map<string, string>;
  deepDive?: DeepDiveResult;
}

function buildPrompt(articles: ProcessedArticle[], deepDiveUrl: string): string {
  const items = articles
    .map(
      (a, i) => {
        const base =
          `${i + 1}. URL: ${a.url}\n` +
          `   Title: ${a.title}\n` +
          `   Summary: ${a.summary.slice(0, 200)}\n` +
          `   Impact: ${a.impact} (${a.impactScore}/10)`;
        if (a.url === deepDiveUrl) {
          return base + `\n   [DEEP_DIVE: also provide bullCase (2 sentences, optimist institutional view) and contextNote (1 sentence connecting to financials/filings if relevant)]`;
        }
        return base;
      }
    )
    .join("\n\n");

  return (
    `You are a skeptical institutional investor. For each article, write the strongest 1-2 sentence bear case: ` +
    `what could go wrong, what is overblown, or why this news may already be priced in. ` +
    `Be specific and concise. Avoid generic disclaimers.\n\n` +
    `For the article marked [DEEP_DIVE], additionally provide:\n` +
    `- bullCase: 2-sentence optimistic institutional view\n` +
    `- contextNote: 1 sentence connecting this news to related financials or filings if possible\n\n` +
    `Return valid JSON only, with one entry per article, using its numeric index (1-${articles.length}) — ` +
    `do NOT repeat the URL, just the index:\n` +
    `{ "results": [ { "index": 1, "bearCase": "...", "bullCase": "...", "contextNote": "..." } ] }\n` +
    `(bullCase and contextNote only required for the [DEEP_DIVE] article; omit or leave empty for others)\n\n` +
    `Articles:\n${items}`
  );
}

// Exported for unit tests
export function parseResponse(text: string): BearCaseRow[] {
  const clean = text.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    logger.warn(`bear-cases: failed to parse AI response as JSON (${(err as Error).message}). Raw (first 500 chars): ${clean.slice(0, 500)}`);
    return [];
  }

  const outer = ResultsResponseSchema.safeParse(parsed);
  if (!outer.success || outer.data.results.length === 0) {
    logger.warn(`bear-cases: parsed JSON had no "results" array. Raw (first 500 chars): ${clean.slice(0, 500)}`);
    return [];
  }

  const rows: BearCaseRow[] = [];
  for (const raw of outer.data.results) {
    const rawIndex =
      raw && typeof raw === "object" && "index" in raw
        ? (raw as { index?: unknown }).index
        : undefined;
    const numericIndex =
      typeof rawIndex === "number"
        ? rawIndex
        : typeof rawIndex === "string" && rawIndex.trim()
          ? Number(rawIndex)
          : Number.NaN;
    const row = BearCaseRowSchema.safeParse(raw);
    if (row.success) {
      rows.push(row.data);
    } else if (!Number.isInteger(numericIndex)) {
      logger.warn(`bear-cases: invalid AI article index ${String(rawIndex)}`);
    }
  }
  return rows;
}

export async function generateBearCases(
  articles: ProcessedArticle[]
): Promise<BearCaseResult> {
  const qualifying = articles
    .filter((a) => a.impactScore >= BEAR_CASE_THRESHOLD)
    .slice(0, MAX_ARTICLES);

  if (!qualifying.length) return { bearCases: new Map() };

  const url = config.ai.baseUrl || "https://api.groq.com/openai/v1";
  const key = config.ai.apiKey;
  if (!key) return { bearCases: new Map() };

  // The deep-dive goes to the article with the highest impactScore
  const deepDiveArticle = qualifying.reduce((best, a) =>
    a.impactScore > best.impactScore ? a : best
  );
  const deepDiveUrl = deepDiveArticle.url;

  const prompt = buildPrompt(qualifying, deepDiveUrl);

  try {
    const data = await withRetry(
      async () => {
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
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(60_000),
        });

        if (!res.ok) {
          throw new HttpError(res.status, `AI HTTP ${res.status}`);
        }

        return (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
      },
      {
        label: "bear-cases AI call",
        shouldRetry: (err) => err instanceof HttpError && isRetryableStatus(err.status),
      }
    );

    const content = data.choices?.[0]?.message?.content ?? "";
    const rows = parseResponse(content);

    if (content && rows.length === 0) {
      logger.warn(`bear-cases: AI response yielded 0 usable rows. Raw (first 500 chars): ${content.slice(0, 500)}`);
    }

    const bearCases = new Map<string, string>();
    let deepDive: DeepDiveResult | undefined;

    for (const row of rows) {
      // Match by 1-based index into the prompt's article list — robust against
      // the model mangling/truncating long URLs (e.g. Google News redirect links)
      // when asked to echo them back verbatim.
      if (!Number.isInteger(row.index) || row.index < 1 || row.index > qualifying.length) {
        logger.warn(`bear-cases: invalid article index ${row.index}; expected an integer from 1 to ${qualifying.length}`);
        continue;
      }
      const article = qualifying[row.index - 1];
      if (!article) {
        logger.warn(`bear-cases: invalid article index ${row.index}; expected an integer from 1 to ${qualifying.length}`);
        continue;
      }
      if (!row.bearCase) continue;
      bearCases.set(article.url, row.bearCase.slice(0, 300));

      if (article.url === deepDiveUrl && row.bullCase && row.contextNote) {
        deepDive = {
          url: article.url,
          title: deepDiveArticle.title,
          bullCase: row.bullCase.slice(0, 400),
          bearCase: row.bearCase.slice(0, 400),
          contextNote: row.contextNote.slice(0, 200),
        };
      }
    }

    logger.info(
      `Bear cases: generated ${bearCases.size} for ${qualifying.length} qualifying articles (score ≥${BEAR_CASE_THRESHOLD})${deepDive ? " + deep-dive" : ""}`
    );
    return { bearCases, deepDive };
  } catch (err) {
    logger.warn(`bear-cases: ${(err as Error).message}`);
    return { bearCases: new Map() };
  }
}
