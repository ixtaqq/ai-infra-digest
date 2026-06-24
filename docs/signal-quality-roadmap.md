# Signal Quality Roadmap — Phase VII–IX

**Status:** Approved · 2026-06-24  
**Framing:** Hybrid B-wins → A-core → C-depth  
**Constraint:** Solo, nights-and-weekends, sub-$1/month AI cost budget

---

## Background

v6.3 ships a complete trust flywheel: vote-learned trust scores, static credibility tiers, corroboration boost, and Devil's Advocate bear cases. The foundation is solid.

Four signal quality leak points remain:

| # | Problem | Impact |
|---|---------|--------|
| 1 | Relevance gate is 200+ keyword OR-match | Lets off-topic filler through |
| 2 | Dedup/corroboration uses title-only Jaccard | Misses semantic dups; undercounts corroboration |
| 3 | Impact score from one-shot prompt | Uncalibrated; vendor PR and Reuters treated equally |
| 4 | No novelty detection | Rehashed 3-day-old stories score as high as breaking news |

This roadmap fixes them in order of infrastructure cost.

---

## Phase VII — Sharper Signal (v7.0–v7.3)

*Prompt refinement only. Zero new infrastructure. Immediate lift.*

### v7.0 — Relevance scoring pass

**Files:** `src/processor/ai.ts`

Add an explicit `relevanceScore` (1–10) field to the existing batch AI prompt alongside `impactScore`. The model already sees the article content — adding a second score field costs zero tokens beyond the JSON field name.

```
relevanceScore: How relevant is this to AI infrastructure specifically?
1 = off-topic (general tech news, crypto, consumer AI)
5 = tangentially relevant (general cloud, adjacent ML)
10 = core (GPU supply chain, model training infra, LLM deployment, data center)
```

Filter: drop articles with `relevanceScore < 4` before the `effectiveScore` calculation in `generateDigest()`. This kills filler before it competes for digest slots.

**Interface change:** Add `relevanceScore?: number` to `ProcessedArticle`.  
**Effort:** ~2 hours.

---

### v7.1 — Score calibration + vendor PR dampening

**Files:** `src/processor/ai.ts`, `src/utils/source-credibility.ts`

Rewrite the impact score rubric with anchored examples:

```
1–3: Routine update, minor version bump, company blog post
4–6: Notable but expected (quarterly earnings in line, incremental product update)
7–8: Significant surprise (major acquisition, unexpected capacity announcement, regulatory action)
9–10: Market-moving (hyperscaler capex shock, geopolitical supply disruption, breakthrough benchmark)

Require a one-sentence justification for any score ≥ 8.
```

Add PR wire dampening: if `source` matches any of `["BusinessWire", "PR Newswire", "Globe Newswire", "Business Wire"]`, cap `impactScore` at 6 regardless of content. Add these to the `LOW_CREDIBILITY_SOURCES` set in `source-credibility.ts`.

**Effort:** ~2 hours.

---

### v7.2 — Novelty flag from history

**Files:** `src/processor/` (new file `novelty.ts`), `src/index.ts`, `src/processor/ai.ts`

Before the batch AI scoring pass, query the `articles` table for titles published in the last 48 hours. For each incoming article, compute word overlap with recent titles (same simple tokenization as the existing Jaccard dedup). If overlap ≥ 0.5 with any recent article, tag `isRehash: true`.

Apply a 0.6× multiplier to `effectiveScore` for rehashed articles. This doesn't filter them out entirely — a rehash with new corroborating sources is still worth showing — but they stop competing with breaking news.

**Interface change:** Add `isRehash?: boolean` to `ProcessedArticle`.  
**Reuses:** existing `supabaseFetch` pattern, `jaccardSimilarity` from `dedup.ts`.  
**Effort:** ~2 hours.

---

### v7.3 — Test coverage + effectiveScore typing

**Files:** `src/processor/ai.ts`, `src/utils/trust-scores.ts`, `src/utils/source-credibility.ts`, `src/processor/dedup.ts`, `tests/`

**effectiveScore as real field:** Remove `(article as any)` casts. Add `effectiveScore: number` to `ProcessedArticle` and set it in the scoring loop.

**New unit tests (target: 50+ total, up from 34):**

| Test suite | What it covers |
|---|---|
| `trust-scores.test.ts` | Cache TTL expiry, unknown-source fallback, multiplier bounds |
| `source-credibility.test.ts` | High/low/default tier lookup, PR wire dampening cap |
| `corroboration.test.ts` | Cluster formation, boost multiplier, threshold boundary |
| `bear-cases.test.ts` | Threshold filtering (only ≥ 7), 300-char truncation, empty-map on failure |
| `novelty.test.ts` | Overlap calculation, rehash flag, effectiveScore dampening |

**Effort:** ~3 hours.

---

## Phase VIII — Semantic Core (v8.0–v8.3)

*The flagship architectural bet. Builds on Phase VII's validated foundation.*

**New dependency:** OpenAI `text-embedding-3-small` — $0.02/1M tokens. At ~200 tokens/article and ~200 articles/day, annual cost ≈ $0.30. Well within budget.  
**New config:** `OPENAI_EMBEDDING_API_KEY` (can reuse `OPENAI_API_KEY` if already set).  
**New infra:** Supabase pgvector extension + `embedding vector(1536)` column on `articles`.

---

### v8.0 — Embeddings infrastructure

**Migration:** `supabase/migrations/20260801000000_v80_articles_embedding.sql`

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS embedding vector(1536);
CREATE INDEX ON articles USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

**New file:** `src/processor/embeddings.ts`

```typescript
export async function generateEmbeddings(
  articles: ProcessedArticle[]
): Promise<Map<string, number[]>>
```

Batches articles 20 at a time (OpenAI limit), calls `text-embedding-3-small` on `title + " " + summary`. Returns `Map<url, embedding>`. Runs as `tryStage` — failure silently skips; pipeline continues without embeddings.

Store embeddings in `ArticleData.embedding` and persist via `insertArticles()`.

**Effort:** ~3 hours.

---

### v8.1 — Semantic dedup and corroboration

**Files:** `src/processor/dedup.ts`

Replace title-only Jaccard in `buildCorroborationMap()` with cosine similarity on stored embeddings where available. Fallback to Jaccard when embeddings are absent (first run, API failure).

**Threshold:** 0.85 cosine similarity = same story cluster (conservative; tune downward after observing real data).

Same-cluster articles get corroboration boost as before, but counts are now accurate — "NVIDIA supply chain article + Reuters confirmation + Bloomberg follow-up" correctly clusters instead of appearing as three distinct stories.

**Effort:** ~3 hours.

---

### v8.2 — Semantic relevance gate

**Files:** `src/processor/relevance.ts` (new or modify existing keyword gate)

Embed 20 canonical AI-infra topic sentences at startup (constants, embedded once, cached in memory):

```
"GPU supply chain and chip manufacturing capacity"
"Large language model training infrastructure and compute"
"Data center construction and power capacity"
"Cloud hyperscaler capital expenditure and infrastructure investment"
... (16 more)
```

Gate: article passes if max cosine similarity to any seed ≥ 0.55. Replaces the keyword OR-match as the primary gate. Keep keyword gate as cheap pre-filter (reject obvious non-tech before hitting the API).

**Effort:** ~2 hours.

---

### v8.3 — Related/prior coverage in dashboard

**Files:** `src/utils/supabase.ts`, `website/dashboard/index.html`, `dashboard/index.html`

After inserting today's articles, query pgvector for the top 3 semantically similar articles from the past 7 days using `<=>` cosine distance operator. Store as `related_urls TEXT[]` on `ArticleData`.

Render in dashboard expandable row: "Related: [title1] · [title2]" with links. Gives users context on whether a story is developing.

**Effort:** ~2 hours.

---

## Phase IX — Depth & Synthesis (v9.0–v9.2)

*Deeper takes and narrative synthesis. Requires Phase VIII semantic clustering.*

### v9.0 — Theme synthesis

After dedup/clustering (Phase VIII), group the day's top articles into 2–3 semantic clusters. For each cluster, one AI call generates a 2–3 sentence narrative ("the big picture today: ..."). Rendered as section headers in the Telegram digest above each cluster's articles. Replaces the current flat category grouping for high-impact stories.

**Effort:** ~3 hours.

---

### v9.1 — Cross-source grounding

Join `articles` with existing `earnings_data` and `stock_data` tables via ticker overlap in `affected_stocks`. If a matching SEC filing or earnings beat/miss exists within ±3 days, attach a grounding note rendered as a footnote in the digest:

```
📊 $NVDA beat EPS by 12% (reported 2 days ago)
```

**Effort:** ~3 hours.

---

### v9.2 — Daily deep-dive

Expand the highest-`effectiveScore` article's bear case into a full 3–5 sentence thesis using cross-source grounding data from v9.1. Include: bull case, bear case, relevant price/earnings context. Delivered as a separate Telegram message at digest end or expandable section.

**Effort:** ~3 hours.

---

## Cross-cutting (opportunistic, not a phase)

These improvements are done **when already touching the relevant file** — not as standalone tasks:

- **Extract bot command handlers** from `src/index.ts` into `src/commands/` (one file per command group: `digest.ts`, `sources.ts`, `alerts.ts`). `index.ts` is currently 1,578 lines. Do this when modifying command handlers for v7.x.
- **Centralize Supabase fetch** — the `getSupabaseConfig()! + fetch` pattern is duplicated ~6×. Route through the existing `supabaseFetch` utility.

---

## Estimated effort

| Phase | Versions | Hours | Timeline |
|---|---|---|---|
| VII — Sharper Signal | v7.0–v7.3 | ~9h | 2–3 weekends |
| VIII — Semantic Core | v8.0–v8.3 | ~10h | 3–4 weekends |
| IX — Depth & Synthesis | v9.0–v9.2 | ~9h | 3 weekends |
| **Total** | | **~28h** | **~2–3 months** |
