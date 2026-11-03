# Implementation history

This file keeps the project's milestone record, moved unchanged from the README on 2026-11-02. It is a historical record. Version labels are implementation milestones, not package versions, and counts and statuses describe the time of each entry. For the current state, read the [README](../README.md).

### Phase I · Foundation ✅ Shipped
- **v1** — RSS → AI → Telegram → GitHub Actions cron. 57 feeds, 10 sectors, keyword filter, conditional GET
- **v1.1** — Supabase metrics, Yahoo Finance stock prices, premium dashboard, URL + Jaccard dedup
- **v1.2** — Token tracking, 58 Vitest unit tests, dashboard shimmer loading
- **v1.3** — Interactive Telegram commands, user management, health alerts, exponential backoff
- **v2.0** — Watchlist filtering, alert system, dashboard search + pagination, conditional RSS fetching
- **v2.1** — NDJSON structured logging, enhanced error alerts, production webhook server
- **v2.2** — Inline feedback keyboard, 7-day trending, per-user scheduled delivery, idempotent delivery log

### Phase II · Intelligence ✅ Shipped
- **v3.0** — SEC filing deep analysis — parse 8-K/10-K/10-Q for 35 companies via EDGAR; extract Capex, AI Revenue, Margins, Inventory, Guidance
- **v3.0a** — Two-tier AI routing — fast model classification, strong model synthesis. Saves 40–60% on AI costs
- **v3.0b** — Two-pass SEC extraction — keyword pre-filter → fast flag → strong extract. Saves 50–70% on SEC AI costs
- **v3.0c** — 🏛️ SEC alert badge on filing articles; `is_sec_filing` stored in Supabase
- **v3.1** — 🎙️ Earnings transcript mining — Roic.ai API, two-pass AI analysis, guidance delta QoQ, Earnings Watch section in digest

### Phase III · Reliability ✅ Shipped
- **v3.2** — Fan-out delivery refactor — `generateDigest()` once, `deliverDigest()` per user; Supabase persistence fixed (upsert headers, migration-v3); Supabase CLI with numbered migrations
- **v3.3** — Real personalization — `applyUserFilter()` at delivery time using `watchlist`, `categories_enabled`, `min_impact_score` from each user's stored preferences; personalization note in digest header
- **v3.4** — CI workflow — `npm run test:unit` (26 unit tests) on every push/PR via GitHub Actions; lint gate
- **v3.5** — `withRetry<T>()` + `tryStage<T>()` utilities — pipeline stages now fail independently without crashing the run; budget cap alerts for daily and 30-day AI spend

### Phase IV · Platform ✅ Shipped
- **v4.0** — 4-step interactive onboarding (`/start`) — delivery time, watchlist, impact filter, digest length; `digest_length` preference stored in Supabase and applied at delivery (brief/standard/detailed)
- **v4.1** — Database performance — 13 indexes (GIN full-text search, partial indexes); `cleanup_old_data()` automated retention function; migration v4 + v5
- **v4.2** — Dashboard auth gate — historical credential entry screen with live Supabase verification before unlocking dashboard; replaced by generated public read-only configuration in the current source
- **v4.3** — AI response caching — SHA-256 hash of article set as cache key; 23h TTL eliminates redundant AI spend on same-day re-runs
- **v4.4** — Expandable article rows in dashboard — click to inline-expand summary, analyst reason, and source link

### Phase V · Intelligence Layer ✅ Shipped
- **v5.0** — `daily_derived_metrics` table — materialized time-series for every ticker and sector, written automatically on every pipeline run
- **v5.1** — "What Changed" digest header — `buildWhatChanged()` computes WoW mention deltas, Market Pulse block appears when ≥7 days of history is available
- **v5.2** — `/trends` command — Unicode sparkline + WoW delta + price for any ticker or sector (`/trends NVDA 30d`, `/trends sector Datacenters`)
- **v5.3** — Backfill script — seeds up to 90 days of historical data from existing `sector_activity` + `stock_mentions`; idempotent (safe to re-run)

### Phase VI · Validation + Trust Layer ✅ Shipped
- **v6.0** — Inline 👍/👎 article validation — top-3 articles per digest get a "Quick Validation" follow-up with per-article buttons; `article_validations` table with idempotent per-user votes and "Already rated!" dedup toast; `thumbs_up`/`thumbs_down` aggregate counters on `articles`; `insertArticles()` returns `{id,url}[]` for fan-out safe threading
- **v6.1** — Trust-weighted ranking — vote-learned source multipliers from `article_validations` (approval rate → [0.7, 1.3] multiplier, 1-hour TTL cache); `effectiveScore = impactScore × voteMultiplier × credibilityMultiplier × sectorMultiplier × corroborationBoost` drives validation follow-up order; `/sources quality` command; hallucination detection alert (source with ≥3 votes and approvalRate < 0.25)
- **v6.2** — Static Source Credibility + Corroboration — cold-start fix: deterministic source-name → multiplier map (High 1.2x for TechCrunch/Reuters/WSJ/etc., Low 0.8x for vendor PR blogs, default 1.0x); `buildCorroborationMap()` clusters same-story articles via Jaccard similarity and adds +5% per extra corroborating source
- **v6.3** — Devil's Advocate bear cases — second AI pass for articles scoring ≥ 7/10 generates a skeptical 1–2 sentence counter-argument; stored in `bear_case TEXT` column; rendered as `⚠️` italic line in each digest article

### Phase VII · Sharper Signal ✅ Shipped
- **v7.0** — Relevance scoring pass — `relevanceScore` (1–10) added to batch AI prompt; articles scoring < 4 dropped before ranking; `effectiveScore` promoted to real typed field on `ProcessedArticle` (removed `as` casts)
- **v7.1** — Score calibration + PR wire dampening — anchored 1–10 impact rubric with tier examples; `isPRWireSource()` identifies BusinessWire/PRNewswire/GlobeNewswire etc.; PR wire articles capped at `effectiveScore = 6` regardless of content; PR wires added to credibility map at 0.8×
- **v7.2** — Novelty flag — `flagRehashes()` queries articles from the past 48 hours, computes Jaccard similarity (threshold 0.5) against incoming titles, tags matches as `isRehash`; rehashed articles get a 0.6× multiplier in the effectiveScore chain so breaking news always surfaces above repeated coverage
- **v7.3** — Test coverage — 10 new unit tests for `source-credibility.ts` and `novelty.ts`; total test count raised to 75

### Phase VIII · Semantic Core ✅ Shipped
- **v8.0** — Embeddings infrastructure — `text-embedding-3-small` vectors generated per article; stored in Supabase `pgvector` (`embedding vector(1536)` column, IVFFlat index). Graceful skip if `OPENAI_EMBEDDING_API_KEY` not set
- **v8.1** — Semantic corroboration clustering — `cosineSimilarity()` added to `dedup.ts`; `buildCorroborationMap()` uses cosine (0.85 threshold) when embeddings available, falls back to Jaccard (0.65); corroboration map rebuilt after embeddings generated each run
- **v8.2** — Semantic relevance gate — 20 canonical AI-infra seed sentences embedded once per run; articles failing cosine ≥ 0.55 against all seeds dropped after the AI relevance pre-filter; `src/processor/relevance.ts` + 4 new unit tests

### Phase IX · Stabilization + Intelligence ✅ Shipped
- **v9.0** — Audit quick-wins:
  - **TypeScript clean** — fixed all 19 pre-existing type errors (named TelegramBot sub-type imports, polling union type, `disable_web_page_preview` → `link_preview_options`); `tsc --noEmit` now exits 0 and is gated in CI
  - **Pipeline reorder** — embeddings + semantic gate moved to run *before* bear cases; stops LLM spend on articles the gate drops
  - **Crash guards** — `cosineSimilarity` returns 0 on mismatched vector lengths; embeddings batch loop bounds-checks the returned index
  - **Scheduler tolerance** — the original `isTimeMatch` ±2 minute window was superseded by date-based due delivery, so a late cron tick cannot permanently miss a user
  - **Seed embedding cache** — `embedSeeds()` persists to `.cache/seed-embeddings.json` keyed by SHA-256 of seed list + model; eliminates one OpenAI API call per pipeline run after the first
  - **+8 new unit tests** (cosine similarity × 4, scheduler `isTimeMatch` × 3) — total unit suite now **55 tests**
- **v9.1 (channels)** — Slack + Gmail delivery — introduced optional external copies; the current v17.1 semantics send them only after the claimed Telegram delivery succeeds, with copy failures remaining non-fatal; `scripts/test-email.ts` verifies credentials without a full pipeline run
- **v9.1 (grounding)** — Cross-source grounding — `attachGroundingNotes()` matches each article's `affectedStocks[]` against same-run SEC extracts, earnings analyses, and stock prices; emits a compact one-liner per article (e.g. `📊 NVDA: 8-K Jun-20 (score 9/10) | capex $500M`); zero extra Supabase calls; +4 unit tests
- **v9.2** — Daily Deep-Dive — the single highest-scoring article per run gets a full `🔬 DAILY DEEP-DIVE` thesis block: bull case (🟢), bear case (🔴), and a one-sentence context note (📊) connecting the story to related financials; generated by extending the existing bear-case AI pass with two extra JSON fields — no additional API round-trip; total unit suite now **59 tests**
- **v9.3** — Security + reliability audit fixes:
  - **RLS hardening** — scoped 9 previously-`PUBLIC` write policies to `TO service_role` (the client-exposed anon key could otherwise write/delete `articles`, `digest_runs`, and 7 other tables)
  - **Dashboard XSS fix** — escaped all DB-sourced fields before `innerHTML` insertion (untrusted RSS content flows through the AI pipeline into the dashboard)
  - **Retry coverage** — embeddings, seed-embedding, and bear-case AI calls now use `withRetry` instead of silently degrading to zero output on a single 429
  - **AI provider failover** — optional `AI_FALLBACK_*` secondary provider tried once after the primary exhausts retries
  - **Budget pre-spend gate** — the 30-day cap now skips the run entirely instead of only alerting after the spend already happened
  - **Bear-case index matching** — switched from exact-URL round-trip matching to 1-based index matching; long Google News redirect URLs weren't reliably echoed back by the model, silently dropping every bear case
  - **Dead-feed detection** — feeds failing 3+ consecutive runs are now flagged distinctly from transient blips
  - **SEC EDGAR 403 fix** — descriptive `User-Agent` header per their fair-use policy
  - **Scheduled retention** — `.github/workflows/data-retention.yml` (weekly) actually invokes the `cleanup_old_data()` RPC that previously had no scheduler wired up
  - **Webhook secret** — now required whenever `WEBHOOK_URL` is set, regardless of `NODE_ENV` (superseded in v10.2 — required unconditionally)
  - Removed the stale duplicate `dashboard/` directory (`website/dashboard/` is canonical)

### Phase X · Hardening + Thesis Layer ✅ Shipped
- **v10.0 (code health)** — retry helpers deduplicated into `utils/retry.ts`; generic `supabase.queryRows<T>()` replaces 7 hand-rolled fetch call sites; PostgREST params URL-encoded; `resetSkippedFeeds()` per run; LLM article rows validated/normalized at the trust boundary; all 10 dead RSS feeds repaired (68/68 healthy, was 57/68)
- **v10.0 (tests)** — 59 → 84 unit tests: bear-cases parsing/index-matching, Slack mrkdwn + chunking, email template, budget gate; new tests immediately caught + fixed a bug where Slack digests had every link silently stripped
- **v10.0 (perf)** — AI batches run with concurrency 2 (was sequential); `.ai-cache/` prunes expired entries; embeddings abort with an operator-facing quota warning on persistent 429
- **v10.0 (supply chain)** — GitHub Actions pinned to commit SHAs; container runs as non-root `node` user; `scripts/` now type-checked in CI
- **v10.1** — 🧭 Bull/Bear Thesis Snapshots — weekly batched AI pass over 30d of `daily_derived_metrics` + latest SEC filings for the top-10 tickers; `ticker_theses` table; `/thesis NVDA` command; dashboard Thesis Snapshots card; `.github/workflows/weekly-thesis.yml` (Sunday 4 AM UTC)
- **v10.2 — Full codebase audit + remediation** — see [`AUDIT.md`](../AUDIT.md) for the complete report (30 findings, root-cause analysis, 3-horizon roadmap). Every Critical/High finding fixed, plus the full Short-Term checklist:
  - **Security** — untrusted RSS content now passed to the AI as fenced/escaped JSON with explicit anti-injection instructions (was raw prose interpolation); RSS titles/content HTML-stripped at collection time in addition to render-time escaping; `WEBHOOK_SECRET` required unconditionally to start the webhook server; NDJSON logs untracked from git
  - **Reliability** — `fetchTranscript()`'s 429 retry now caps at 2 attempts (was unbounded recursion); scheduler delivery is now claimed atomically per `(chat_id, run_date)` immediately before sending, closing a double-delivery race under overlapping cron runs; run dates computed in the configured timezone instead of UTC
  - **Data integrity** — a zod validation layer now sits in front of every AI JSON response (`ai.ts`, `sec.ts`, `bear-cases.ts`, `thesis.ts`, `earnings.ts`), coercing type-confused fields (e.g. `"8"` instead of `8`) instead of crashing `.toFixed()` calls downstream — caught and fixed a live instance of this exact bug in `processor/earnings.ts` while adding coverage
  - **Performance** — `metrics.ts` and `dedup.ts` switched from sync to async file I/O; onboarding sessions now expire after 30 minutes with a periodic sweep (was unbounded growth)
  - **CI/CD** — all 5 workflows hardened with explicit `permissions: contents: read`, standardized on Node 22, and now alert Slack on failure
  - **Tests** — expanded mocked coverage for the previously-uncovered AI/collector and operational boundaries; the current suite reports **425 passing tests across 57 files** (380 unit tests across 54 files)
  - **Cleanup** — removed the redundant `node-telegram-bot-api` postinstall patch duplicated in `Dockerfile`/CI (the `package.json` postinstall already covers it via `npm ci`); consolidated `escapeHtml()` into one shared module
- **v11** — `/coverage` command + Thesis Evolution History. Diagnosed via `/office-hours`: the original "Thesis Evolution Dashboard" pitch didn't match the validated incident (daily article coverage confusion, not the weekly AI narrative) — pivoted to two smaller, correct slices instead of one oversized wrong one:
  - `/coverage TICKER [days]` — recent per-article coverage history for a ticker, pulled straight from `articles` (no new table)
  - `ticker_thesis_history` table — every weekly thesis snapshot kept (not just latest); `/thesis TICKER` shows a 6-week confidence timeline with WoW deltas; dashboard Thesis Snapshots card gained a matching timeline view (T7)

### Phase XI · Diagnosed one-at-a-time via `/office-hours` ✅ Complete
Each roadmap candidate ran through the same demand-first diagnostic before any code — one shipped, one was already done, one was killed:
- **✅ Shipped — v12, Price Watch**: `/watch TICKER PRICE` — one-shot, informational-only threshold ping (not the "instant trading alert" originally pitched — the actual evidence only supported an ambient awareness check). Checked once per existing digest generation cycle, no new polling infrastructure. New `price_watches` table; watched tickers are unioned into the daily stock-price fetch ahead of article tickers so a watch never silently fails to fire on a quiet news day.
- **✅ Already shipped, no new work — Source Leaderboard**: turned out `/sources quality` already ranks every source by vote-learned trust multiplier with color-coded tiers — the roadmap item was redundant with an existing command.
- **❌ Killed — Related Prior Coverage**: diagnosed and cut for lack of demand evidence (pushed twice on Q1, both times came back "hasn't actually happened") — logged in `TODOS.md` (`TODO-4`) so it isn't silently re-proposed without new evidence.

### Phase XII · Production Hardening ✅ Shipped
- **v12.1 — Command routing fix**: `registerCommand()` only ever stored handlers in a Map — actual dispatch needed a hand-written `onText` block per command, and those existed for just 6. `/alert`, `/sec`, `/trends`, `/thesis`, `/coverage`, and `/watch` (plus `/digest watchlist` / `/digest sector=X`) were registered, documented, and fully tested at the handler level — but **silently unreachable from the live bot**, going back as far as v2.0. Verified via `git log -S` that dispatch for them never existed in any commit. Replaced with one generic dispatcher (longest-prefix match, `@botname` stripping, unknown-command check derived from the registry itself); new `telegram.routing.test.ts` drives the *real* `initCommands()` against a fake bot so this class of gap can't silently recur.
- **v13 — Command usage logging**: every bot command now writes a durable `command_usage` row (plus the existing NDJSON metrics) — fire-and-forget on both legs, never affects the command that triggered it. Directly answers "does this feature actually get used?" instead of guessing — including the open question from Price Watch's own design doc.
- **v13 — CodeQL**: static security analysis added to CI (`security-extended` query pack), the one AUDIT.md meta-recommendation that hadn't shipped yet.
- **v13 — Schema drift fix**: `supabase-schema.sql` was documenting 13 tables against an actual 18 — refreshed with the 6 missing tables and a header note that `supabase/migrations/` is the canonical source going forward.
- Deployed the webhook server live (Render) and verified end-to-end: `/health` 200, Telegram's `getWebhookInfo` showing the URL registered with zero pending/failed updates, and a full command smoke test (`/watch`, `/coverage`, `/thesis`, `/trends`, `/alert`, `/digest watchlist`) all responding with real data.

### Phase XIII · Intelligence Connections ✅ Shipped
Two `TODOS.md` items connecting existing features instead of adding new surface:
- **v14 — Persist article intelligence fields** (`TODO-1`): `corroboration_count`, `grounding_text`, and `effective_score` were computed fresh every pipeline run and discarded afterward — now persisted to `articles`, unlocking historical confidence-trend analysis without recomputation. Found and fixed a real bug in the same code path: `is_sec_filing` was declared, passed by the caller, and silently dropped before ever reaching the `INSERT` — the 🏛️ SEC badge flag had never actually been written to the database.
- **v14 — Ground the weekly thesis in coverage data** (`TODO-2`): `/thesis`'s AI narrative and `/coverage`'s per-article feed used to pull from unrelated data with no connection between them. `generateTheses()` now includes each ticker's recent headlines (one batched query, not one per ticker) and is explicitly instructed to ground its bull/bear case in them — verified by asserting the actual headline text reaches the AI request body, not just that the data was fetched.

### Phase XIV · Correctness + Operational Clarity ✅ Implemented in current source
- **v14.1 — Correctness First**: conditional RSS failures are isolated per feed; historical failure streaks stop at the newest success; brief/standard/detailed Telegram output now renders the intended amount of article detail; successful and failed runs persist the configured AI provider instead of hard-coding Groq.
- **v14.2 — Operational Parity**: local and hosted digest runs receive the same optional embedding, earnings, fallback, and budget configuration; every run logs and persists a credential-free capability report with degraded stages; `npm run preflight` validates local configuration and `npm run preflight:network` performs read-only authentication checks without sending a digest, email, or model request.

### Phase XV · Modular Core ✅ Implemented in current source
- **v15.0 — Pipeline boundaries**: the former all-in-one `src/index.ts` is now a thin entry point over focused generation, persistence, delivery, personalization, and orchestration modules. The public exports used by the scheduler and test suite remain stable.
- **v15.1 — Command domains**: Telegram handlers are grouped into core, preference, trend, and research modules behind one `registerDigestCommands()` entry point. The real command dispatcher regression suite verifies that every registered command remains reachable.

### Phase XVI · Measurable Signal Quality ✅ Implemented in current source
- **v16.0 — Ranking explanations**: every article now carries a versioned breakdown of its impact/relevance inputs, source and sector trust, editorial credibility, corroboration, novelty penalty, PR-wire cap, final score, and concise human-readable reasons. Detailed Telegram digests expose the useful reasons without dumping raw internals.
- **v16.1 — Ranking validation loop**: explanations persist in `articles.ranking_explanation`; the dashboard shows them in expanded article rows and adds a daily ranking-quality view that tracks approval rate and average effective score for reader-validated articles.
- **v16.2 — Ranking-order correctness**: category lists are re-sorted after effective scores are calculated, so the visible sector sections now use the same trust-weighted order as validation prompts and persistence.

### Phase XVII · Personal Delivery Parity ✅ Implemented in current source
- **v17.0 — Personalized channel copies**: users can opt into email or Slack copies with `/delivery`; each copy is generated from the same per-user watchlist, sector, score, and digest-length result as Telegram.
- **v17.1 — Safe delivery semantics**: Telegram remains the primary claimed delivery. External copies send only after it succeeds, remain non-fatal, and are recorded in delivery details, preventing a failed copy from causing a duplicate Telegram retry.
- **v17.2 — Private destinations**: email addresses and Slack webhook URLs live only in the service-role-protected `user_preferences` table. Slack input is restricted to HTTPS Incoming Webhook hosts, and `/settings` never echoes a webhook URL.
- **v17.3 — Public delivery metrics**: `delivery_metrics_daily` exposes aggregate delivery performance without Telegram chat IDs or per-user destinations.
- **v18.0 — Reliability completion**: high-impact alerts use retryable per-user/content claims; dashboard search uses the `idx_articles_fts` GIN index through a least-privilege RPC; onboarding and delivery-lateness events remain service-role private; GitHub runners restore atomic RSS/dedup caches across runs.

Catalyst Tracker and a `node-telegram-bot-api`→grammY migration remain
unscheduled pending usage or maintenance evidence. Related Prior Coverage
remains rejected; see `TODOS.md`.

### 2026-11 · Data accuracy and delivery timing ✅ Shipped

Entries from here on are added as work ships.

- **v1.2.0** — Real stock moves from the prior session close, SEC extraction that reads real filing numbers and Form 6-K, pg_cron workflow dispatch, scheduler states, five quality alerts, weekly live API contract checks, and a stuck-claim release command.
- **After v1.2.0** — "Why it moved", three replacement feeds, ticker corrections, one search result per URL, a 30-day URL memory, a Slack control-sequence fix, and a repair of 1,251 historical price rows. See `docs/releases/unreleased.md`.

## Migration history to 2026-08-23

`supabase/migrations/` is the canonical list. This table stops at `20260823074758` and is not updated.

| File | Description |
|---|---|
| `20240101000000_initial_schema.sql` | 13 tables + RLS policies |
| `20240601000000_v2_user_alerts.sql` | `alerts_enabled`, `alerts_min_score` columns |
| `20260624000000_v3_missing_columns.sql` | `ai_fast_model`, `is_sec_filing`, missing tables, RLS for new tables |
| `20260624120000_v4_indexes_retention.sql` | 13 performance indexes + `cleanup_old_data()` retention function |
| `20260624150000_v5_digest_length.sql` | `digest_length` column on `user_preferences` |
| `20260625000000_v6_daily_derived_metrics.sql` | `daily_derived_metrics` table + 2 time-series indexes + RLS |
| `20260626000000_v7_article_validations.sql` | `article_validations` table + `thumbs_up`/`thumbs_down` on `articles` + RLS |
| `20260627000000_v63_articles_bear_case.sql` | `bear_case TEXT` column on `articles` |
| `20260625100000_security_rls.sql` | Tighten RLS: service-role-only for `user_preferences`, `user_delivery_log`, `earnings_transcripts`; public read + service write for `sec_filings` |
| `20260625200000_v80_articles_embedding.sql` | Enable `pgvector`; `embedding vector(1536)` column + IVFFlat index on `articles` |
| `20260625300000_v9_daily_metrics_trending.sql` | `trending_json`, `trending_entities` columns on `daily_metrics` |
| `20260625400000_v9_daily_metrics_feedback.sql` | `feedback_ratings` column on `daily_metrics` |
| `20260629000000_v9_rls_writes_service_role.sql` | Security fix: scope the 9 `"Allow service full access"` policies (`digest_runs`, `articles`, `sector_activity`, `stock_mentions`, `pipeline_health`, `capex_tracking`, `ai_usage`, `daily_metrics`, `stock_prices`) to `TO service_role` — they previously had no `TO` clause and defaulted to `PUBLIC`, letting the client-exposed anon key write/delete |
| `20260703000000_v10_ticker_theses.sql` | `ticker_theses` table (bull/bear thesis snapshots, `UNIQUE(ticker)`) + RLS (public read, service write) |
| `20260704000000_v11_ticker_thesis_history.sql` | `ticker_thesis_history` table (`UNIQUE(ticker, week_of)`) — every weekly snapshot kept, not just the latest; public read + service write |
| `20260704010000_v12_price_watches.sql` | `price_watches` table (`UNIQUE(chat_id, ticker)`) — one-shot price threshold pings; service-role-only RLS (private per-user data) |
| `20260704020000_v13_command_usage.sql` | `command_usage` table — append-only bot-command invocation log; service-role-only RLS |
| `20260707000000_v14_articles_intelligence_fields.sql` | `corroboration_count`, `grounding_text`, `effective_score` columns on `articles` — persist ranking/grounding data that was computed in-memory every run and discarded afterward |
| `20260810000000_v141_capability_status.sql` | `capabilities` JSONB + `degraded_stages` on `digest_runs` — records which optional stages were enabled or degraded without storing credentials |
| `20260810010000_v16_ranking_explanations.sql` | `ranking_explanation` JSONB on articles + daily validation-quality view |
| `20260810020000_v17_personal_delivery_channels.sql` | Private per-user email + Slack destinations for personalized copies |
| `20260810030000_v171_private_delivery_hardening.sql` | Removes stale PUBLIC policy/grants from private delivery settings; makes ranking view SELECT-only |
| `20260810040000_v172_rls_policy_cleanup.sql` | Removes remaining stale PUBLIC write policies, protects validation chat IDs, and fixes retention-function search path |
| `20260810082355_v173_delivery_metrics_public.sql` | Public daily delivery aggregates maintained from the private delivery log; exposes no chat IDs or destination details |
| `20260815075950_delivery_reliability.sql` | Retryable delivery leases, stale-claim recovery, and the service-role-only `claim_user_delivery` RPC |
| `20260815090616_v18_alert_idempotency_and_article_search.sql` | Idempotent alert claims, private product-funnel events, and indexed public article-search RPC |
| `20260815091624_v181_onboarding_resume.sql` | Explicit onboarding-completion marker used by safe `/resume` activation |
| `20260815091946_v182_consent_correction.sql` | Inactive-by-default users, removes inferred legacy consent, and records resume activation events |
| `20260819112411_canonical_digest_publications.sql` | Immutable daily editorial publications, publication-linked delivery records, private email verification, privacy RPCs, and explicit Data API grants |
| `20260823074758_private_digest_feedback.sql` | Private, atomic feedback storage; five-response public aggregates; legacy feedback archival; deletion and retention updates |

## Test inventory at the v13 and v14 milestones

These per-file counts are not updated. Run `npm test` for current totals.

- Deduplication + cosine similarity: 9 unit tests (`cosineSimilarity` — identical, orthogonal, mismatched length, zero vectors; `deduplicateArticles` — 5 cases, now async)
- Keyword matching: 13 unit tests
- Stock price fetching: 3 unit tests
- Telegram formatter: 7 unit tests
- Webhook router: 7 unit tests
- Fan-out regression: 1 test — proves `collectArticles` called once for N deliveries
- Source credibility: 6 unit tests (`getSourceCredibility`, `isPRWireSource`)
- Novelty detection: 4 unit tests (`flagRehashes` — fetch success, empty, non-ok, network error)
- Cross-source grounding: 4 unit tests (`attachGroundingNotes` — SEC/earnings/stock matching)
- Semantic relevance: 4 unit tests (`passesSemanticGate`, `embedSeeds` — success, HTTP error)
- Scheduler: 5 unit tests (`isDeliveryDue` and `getDeliveryDate` — on-time, delayed-cron, pre-window, midnight, and local-date cases)
- **AI batch processing** (`processor/ai.test.ts`): 8 tests — `normalizeArticles` zod coercion/defaults, `processArticles` success/retry/all-fail/malformed-synthesis paths (mocked chat completions)
- **SEC extraction** (`processor/sec.test.ts`): 6 tests — including the exact numeric-string-in-a-financial-field case that used to crash `.toFixed()`
- **Earnings analysis** (`processor/earnings.test.ts`): 5 tests — numeric coercion, guidance delta computation, graceful degradation on unparseable output
- **Earnings collection** (`collector/earnings.test.ts`): 9 tests — including a regression guard for the 429 retry-cap fix (no more unbounded recursion)
- **SEC EDGAR collection** (`collector/sec.test.ts`): 10 tests — filing age/form-type filtering, `getTopFilings` scoring
- **Thesis snapshots** (`processor/thesis.test.ts`): 14 tests — response parsing/validation, end-to-end generation, history-insert independent-failure behavior, `collectRecentCoverage()` batched-query grouping/capping (v14), and an end-to-end assertion that real headline text reaches the AI prompt
- **Embeddings** (`processor/embeddings.test.ts`): 4 tests — batch mapping, 429 circuit breaker, non-429 continue-to-next-batch
- **Price watch** (`utils/price-watch.test.ts`): 6 tests — direction inference (above/below/tie-break), trigger boundary conditions
- **Command handlers** (`index.commands.test.ts`): 22 tests — `/coverage`, `/thesis`, `/watch`, and private delivery-destination behavior
- **Digest fan-out + price watch delivery** (`index.faninout.test.ts`): 13 tests — generate-once/deliver-many regression, personalized channel copies, delivery claim/retry state, triggered/untriggered watches, combined notifications, and ticker-cap ordering
- **Command routing seam** (`sender/telegram.routing.test.ts`): 42 tests — drives the *real* `initCommands()` against a fake bot and asserts every `registerCommand()`-registered name is actually dispatchable through an `onText` route, plus settings validation, private-data deletion, longest-prefix matching, `@botname` stripping, and command-usage logging
- **Supabase deletion boundary** (`utils/supabase.test.ts`): 3 tests — private-table allowlist, partial failure reporting, and unsafe chat-ID rejection
- **Command usage metrics** (`utils/metrics.test.ts`): 2 tests (v13) — `emitCommandUsage()` NDJSON event shape, multi-word command keys preserved verbatim
- Supabase boundary tests: 28 mocked REST-response tests — no live credentials
- Telegram boundary tests: 9 mocked Bot API tests — no live credentials
- Stocks boundary tests: 8 mocked Yahoo Finance tests — no live credentials
