# TODOS

## Backlog

### [TODO-1] Persist corroboration_count, grounding_text, effective_score to DB

**What:** Add 3 columns to the `articles` table. Update `insertArticles()` in `src/index.ts` to write them on each pipeline run.

**Why:** Currently these are ephemeral — computed in `generateDigest()` and lost after the run. Persisting them would enable historical confidence trend analysis, an admin dashboard, and makes the web layer independently queryable from the DB (future-proofing against reading a file).

**Pros:** Unlocks historical analysis; makes the web layer independent of the pipeline's file output; enables backfill passes.

**Cons:** Requires a new Supabase migration; schema drift risk; the in-memory approach (1A, chosen for Phase C) already works and doesn't need this.

**Context:** Phase C chose to write `digest.json` directly from the in-memory pipeline state rather than persisting to DB first (decision 1A, engineering review 2026-06-29). This TODO captures the persistence path for when historical dashboard features become worth it.

**Depends on:** Phase C complete. `articles` table schema at `supabase/migrations/20260625200000_v80_articles_embedding.sql`. `insertArticles()` call site at `src/index.ts:709-725`.

### [TODO-2] Ground the weekly /thesis narrative in the same data /coverage shows

**What:** When `generateTheses()` builds its prompt (`src/processor/thesis.ts`), include recent per-article coverage for each ticker (from `articles`, the same source `/coverage` queries) alongside the `daily_derived_metrics` aggregates it already uses.

**Why:** As of the Thesis Evolution / /coverage design (2026-07-04), the weekly AI-generated bull/bear narrative and the per-article coverage feed pull from unrelated data with no connection between them. The founder's actual validated pain point (Q1 evidence, office-hours session) was about article-level coverage trend, not the weekly narrative — grounding the narrative in the same article data would make `/thesis`'s reasoning traceable back to what `/coverage` shows.

**Pros:** Makes the weekly thesis narrative explainable ("why does the AI think this") by tying it to visible article coverage; reduces the risk of the two features drifting into answering different questions.

**Cons:** Larger prompt (more tokens, marginal cost increase); no evidence yet that this connection matters in practice — speculative until both features have real usage.

**Context:** Discovered during the `/plan-eng-review` outside-voice challenge on the Thesis Evolution History plan — the reviewer's strategic critique revealed the original incident (NVDA, Blackwell delay, 2026-07-02) was about daily digest article coverage, not the weekly `/thesis` snapshot, prompting the founder to pivot to building `/coverage` first. This TODO captures the follow-up idea of connecting the two once both exist.

**Depends on:** `/coverage` command shipped (see `docs/thesis-evolution-design.md`); `processor/thesis.ts`'s `generateTheses()`/`buildPrompt()`.

### [TODO-3] Catalyst Tracker may not need new infrastructure — check before building

**What:** Before building any real "Catalyst Tracker" feature, check whether it can be a query/reminder against data already collected (`collector/sec.ts`'s SEC filing dates, `collector/earnings.ts`'s earnings dates) rather than new tracking infrastructure — the same pattern that turned "Thesis Evolution Dashboard" into a simple `articles` table query (`/coverage`) instead of a new schema.

**Why:** Catalyst Tracker was cut from Phase X scope for lacking evidence (office-hours session, 2026-07-04), but if/when real evidence for it shows up later, this insight should be checked first instead of re-deriving it from scratch or defaulting to "needs a new table."

**Pros:** Could save an entire migration/table if the existing collectors already have what's needed; keeps the same discipline (query existing data before building new storage) that this session's review already validated once.

**Cons:** Speculative until Catalyst Tracker actually has real demand evidence — this is a note for future-you, not actionable today.

**Context:** Directly analogous to the `/coverage` pivot from this session's `/plan-eng-review`: the outside voice's strategic critique caught that "Thesis Evolution Dashboard" as originally scoped (new history table) didn't match the validated incident, and a query against existing data (`articles`) did. Worth checking the same question for Catalyst Tracker before building it.

**Depends on:** Catalyst Tracker acquiring real Q1 (demand) evidence per the `/office-hours` diagnostic — not before.
