# 🏆 Goldirham Stack

**Daily intelligence for the AI infrastructure age.** A pipeline that collects 68 RSS feeds, analyzes news with AI, extracts SEC filings from 35 companies, and delivers a personalized morning digest via Telegram at each user's preferred time.

Covers the **full AI infrastructure value chain**: power generation → cooling → networking → chips → AI models.

---

## Release status

The checked-in package version is **`1.0.0`** (`package.json`). The phase and `vN` labels below are implementation milestones, not package-version claims. The scheduled GitHub Actions jobs execute the current `main` branch; optional stages still depend on the credentials configured for each deployment.

### Deployment-dependent capabilities

These capabilities are implemented in the repository but are opt-in at runtime. Missing or unusable optional credentials affect only the relevant stage.

| Capability | Enable with | Behavior without a working key | Current scheduled production |
|---|---|---|---|
| **Embeddings** | `OPENAI_EMBEDDING_API_KEY` (or local `OPENAI_API_KEY`) | Uses URL/Jaccard fallbacks; vector enrichment and semantic relevance filtering are skipped or degraded | **Disabled** — no `OPENAI_EMBEDDING_API_KEY` secret is configured |
| **Earnings transcripts** | `ROIC_AI_API_KEY` | Earnings collection and analysis are skipped | **Disabled** — no `ROIC_AI_API_KEY` secret is configured |
| **AI provider fallback** | `AI_FALLBACK_API_KEY` plus optional `AI_FALLBACK_*` settings | The primary provider is used on its own | **Disabled** — no `AI_FALLBACK_API_KEY` secret is configured |

The production status above describes the current GitHub Actions secret configuration; local `.env` values can enable these stages independently. Never copy real credentials into `.env.example`, documentation, or `supabase/config.toml`.

---

## Features

### 📡 News Pipeline
- **68 RSS feeds** across 2 tiers (company news + industry analysis)
- **Smart deduplication** — URL matching + **Jaccard similarity** (catches near-identical headlines); upgraded to **cosine similarity on embeddings** (0.85 threshold) when the optional embedding capability is enabled and healthy
- **10-sector classification**: Chips & GPUs, Cloud & Hyperscalers, Datacenters, Networking, Semiconductor Manufacturing, Power & Utilities, Cooling Infrastructure, AI Models & Labs, M&A, Earnings
- **Two-layer relevance filtering** — AI scores each article's relevance (1–10, < 4 dropped); followed by an optional **semantic relevance gate** (cosine similarity vs 20 canonical AI-infra seed sentences, threshold 0.55) when embeddings are enabled and healthy
- **Conditional GET caching** — ETag/Last-Modified headers per feed, 304 for unchanged content
- **Consecutive failure tracking** — feeds failing 2+ runs in a row are automatically skipped
- **RSS retry with exponential backoff** — up to 2 retries with full-jitter backoff
- **🏛️ SEC Alert Badge** — articles detected as SEC filings get a 🏛️ badge in the digest and `is_sec_filing` flag in Supabase

### 🤖 AI Processing
- **Multi-provider**: Groq (default), OpenAI, OpenRouter, or custom endpoints
- **Two-tier model routing** — fast model (openai/gpt-oss-20b) for classification; strong model (openai/gpt-oss-120b) for synthesis
- **Dynamic batch sizing** — 5–15 articles/batch, targeting ~4 batches
- **Batch processing** with exponential backoff (full-jitter, up to 3 attempts)
- **Anchored impact rubric** — 1–10 scale with tier anchors: 1–3 routine, 4–6 notable, 7–8 significant surprise, 9–10 market-moving; scores ≥ 8 require a justification sentence
- **Synthesis pass** — market outlook, top stocks, daily summary
- **Token tracking** — `prompt_tokens`, `completion_tokens`, `total_tokens` per run, both model names stored in Supabase
- **AI response caching** — SHA-256 hash of article URLs as cache key; 23-hour TTL prevents redundant AI spend on same article set during dev re-runs
- **Cross-source grounding (v9.1)** — each article is annotated with a one-line note linking it to same-run SEC filings, earnings guidance, or stock moves for matching tickers; zero extra DB calls
- **Daily Deep-Dive (v9.2)** — the highest-scoring article gets a full bull/bear/context thesis (🟢/🔴/📊) appended to the bear-case AI pass; one prompt extension, no extra AI round-trip
- **Prompt-injection guardrails (v10.2)** — untrusted RSS content is passed to the AI as fenced, escaped JSON (not interpolated prose), with an explicit system instruction to treat article fields as data only, never as instructions — a hostile feed can't steer the model's output
- **Zod-validated AI responses (v10.2)** — every AI JSON response (classification, synthesis, SEC extraction, bear cases, thesis, earnings) is parsed through a zod schema that coerces type-confused fields (e.g. a numeric field returned as a string) instead of letting them crash downstream `.toFixed()` calls or silently corrupt state

### 🏛️ SEC Filing Intelligence
- **EDGAR watcher** — monitors 8-K, 10-K, 10-Q filings for 35 tracked companies
- **Three-pass extraction**:
  - **Pass 0 — Keyword pre-filter** (free): scans for capex, AI revenue, margin, guidance keywords
  - **Pass 1 — Fast model flagging** (~$0.0005/filing): contextual relevance check
  - **Pass 2 — Strong model extraction** (~$0.01/filing): precise number extraction on flagged filings only
- **Extracted metrics**: Capex, Capex Guidance, AI/Data Center Revenue, Gross/Operating Margins, Inventory, Revenue/EPS Guidance
- **Impact scoring** — 1–10 rating with rationale and key takeaways
- **`/sec NVDA`** — query latest filing highlights for any tracked ticker
- **SEC Highlights section** in daily digest — top 1–2 impactful filings with key numbers

### 🎙️ Earnings Transcript Mining
- **Roic.ai API** — earnings call transcripts for 15 AI infra companies (NVDA, AMD, AVGO, MSFT, AMZN, etc.)
- **Two-pass AI analysis**:
  - **Pass 1 — Topic segmentation** (fast model): capex, AI revenue, supply chain, macro, guidance segments
  - **Pass 2 — Financial extraction** (strong model): revenue/EPS/capex guidance, AI revenue, management tone
- **Guidance delta** — QoQ comparison vs. stored data from Supabase with % change arrows
- **Management tone analysis** — bullish/cautious/neutral/bearish, confidence score (1–10), key phrase, risks
- **🎙️ Earnings Watch section** in digest — guidance changes, delta arrows, tone indicators
- **Deployment-dependent** — skips when `ROIC_AI_API_KEY` is not set; this stage is currently disabled in scheduled production

### 💰 Stock Prices
- **Yahoo Finance** integration — daily price snapshots for 30+ tickers
- Fetched automatically for every stock mentioned in the AI analysis
- Stored in `stock_prices` table for dashboard history charts

### 📬 Multi-Channel Delivery

Digest delivered in parallel to up to three channels after each pipeline run. Slack and email failures are non-fatal — Telegram always delivers.

| Channel | Config | Notes |
|---------|--------|-------|
| **Telegram** | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Always on; primary channel |
| **Slack** | `SLACK_WEBHOOK_URL` | Incoming webhook; HTML→mrkdwn conversion; chunked at 2 900 chars |
| **Gmail** | `SMTP_USER` + `SMTP_PASS` + `DIGEST_EMAIL_TO` | nodemailer SMTP via `smtp.gmail.com:587`; App Password required |

> **Gmail setup gotcha:** `SMTP_PASS` must be a **[Google App Password](https://myaccount.google.com/apppasswords)** (16 chars, no spaces) — **not your normal account password**, which Gmail's SMTP will reject with `535-5.7.8 Username and Password not accepted`. App Passwords require 2-Step Verification to be enabled on the account first. This is the most common first-run email failure.

Test Gmail credentials locally without a full pipeline run:
```bash
npx tsx scripts/test-email.ts   # reads SMTP_* from .env; verifies auth + sends a test mail
```

### 📱 Interactive Telegram Bot

> **Note:** Interactive commands require the webhook server to be deployed (see `WEBHOOK_SETUP.md`). The scheduled GitHub Actions jobs do not run an always-on command listener. For 24/7 command response, deploy `src/webhook.ts` to Render/Railway/Fly.io.

| Command | Description |
|---------|-------------|
| `/start` | 4-step onboarding: delivery time → watchlist → impact filter → digest length |
| `/help` | Show all available commands |
| `/digest` | Show recent stored articles (filtered by your watchlist/sector if set) |
| `/digest watchlist` | Filter stored articles by your saved watchlist tickers |
| `/digest sector=Chips_&_GPUs` | Filter stored articles by sector |
| `/sources` | List all 68 tracked RSS feeds with health status |
| `/sources quality` | Show source trust scores ranked by approval rate (vote-learned multipliers) |
| `/last` | Show the most recent digest summary from Supabase |
| `/trending` | See what's trending in AI infra (last 7 days, snapshot) |
| `/trends NVDA 30d` | Sparkline + WoW delta for any ticker (default: NVDA, 30 days) |
| `/trends sector Datacenters 30d` | Sparkline + WoW delta for a sector |
| `/sec NVDA` | Latest SEC filing highlights for a ticker |
| `/coverage NVDA 14` | Recent per-article coverage history for a ticker (default: 14 days) |
| `/thesis NVDA` | Bull/bear thesis for a ticker — last 6 weekly snapshots with confidence deltas (no arg: top 5 by confidence) |
| `/feedback 5` | Rate today's digest (1–5) with optional comment |
| `/delivery` | Configure opt-in personalized email or Slack copies |
| `/delivery email you@example.com` | Send the same personalized digest to email after Telegram succeeds |
| `/delivery slack WEBHOOK_URL` | Send the same personalized digest to a private Slack Incoming Webhook |
| `/settings` | View or edit your user preferences |
| `/settings time 08:00` | Set preferred delivery time; also supports `timezone`, `min_score`, `length`, and `categories` |
| `/stop` | Stop scheduled delivery; `/unsubscribe` is an alias |
| `/resume` | Resume delivery with saved preferences after completed onboarding |
| `/delete_my_data` | Delete private user rows and disable delivery; `/delete` is an alias |
| `/watchlist NVDA,AMD,AVGO` | Set your ticker watchlist |
| `/alert on` | Enable instant high-impact alerts (score 8+) |
| `/alert off` | Disable alerts |
| `/alert threshold 9` | Set minimum impact score for alerts |
| `/watch NVDA 130` | One-shot price watch — notified once when NVDA crosses $130, then it clears |
| `/watch NVDA off` | Clear a price watch |
| `/watch list` | Show your active price watches |

### ⏰ Scheduled Delivery (Per-User, Fan-Out)
- **Generate once, deliver to all** — RSS crawl + AI runs a single time per cron tick regardless of user count; the formatted digest is fanned out per user (no redundant AI cost)
- **Real personalization at delivery** — each user's copy is filtered from the shared bundle using their stored preferences:
  - `min_impact_score` — drops articles below their threshold
  - `categories_enabled` — keeps only their selected sectors
  - `watchlist` — floats watchlist-ticker articles and stocks to the top; adds a `🎯 Filtered for you` note in the header
  - `digest_length` — `brief` trims summaries to one line; `standard` (default) sends full bullets; `detailed` includes analyst rationale
- **Custom delivery times** — each user sets `preferred_time` via `/start` onboarding or `/settings`
- **Optional delivery copies** — `/delivery` adds email or Slack copies using the same filters and digest length; Telegram stays primary so retry/idempotency behavior remains deterministic
- **Timezone-aware** — delivery triggers at the user's local time; the run date itself is computed in the configured timezone (not UTC), so digests, delta comparisons, and delivery logs never drift a day off during part of the day
- **Idempotent and retryable** — delivery is claimed atomically per `(chat_id, run_date)` through the `claim_user_delivery` RPC immediately before sending; failed claims can retry and stale pending leases can be reclaimed without allowing concurrent sends
- **GitHub Actions cron** — runs every 10 minutes, checks all active users, and delivers anyone whose preferred local time has passed without a successful delivery for that date
- **Budget caps** — daily cap triggers a Telegram alert; the 30-day rolling cap is a real **pre-spend gate** — once hit, the run is skipped entirely (no AI calls made) until spend drops below the cap

### 🌐 Production Webhook Bot
- **`src/webhook.ts`** — zero-dependency Node `http` server; registers all command handlers in non-polling mode
- **`enableWebhookMode()`** — switches bot from polling to `processUpdate` before startup
- **Secret token validation** — rejects requests without matching `X-Telegram-Bot-Api-Secret-Token` header; `WEBHOOK_SECRET` is required unconditionally to start the server (not just once `WEBHOOK_URL` is set) — an unauthenticated listener is never safe, regardless of whether the webhook has been registered with Telegram yet
- **Auto-registers webhook** on startup when `WEBHOOK_URL` is set
- **`Dockerfile`** — multi-stage build, runs `dist/webhook.js`, exposes port 3000
- Deploy to Render/Railway/Fly.io — see **`WEBHOOK_SETUP.md`**

### 📊 Dashboard
- **Graphite + copper terminal design** — `#0a0b0e` dark background, `#cb8a4c` copper accent, Space Grotesk display font, JetBrains Mono for data
- **Public read-only access** — Vercel generates an untracked `dashboard/config.js` from `SUPABASE_URL` plus `SUPABASE_ANON_KEY`/`SUPABASE_PUBLISHABLE_KEY`; RLS keeps writes and private tables out of the browser. The settings panel remains available for local or alternate Supabase projects.
- **Fixed rail navigation** — Overview, Pipeline, Stocks, SEC Filings, Articles sections; collapses to horizontal on mobile
- **Market pulse ribbon** — live stock ticker strip populated from Supabase
- **KPI cards** — articles processed, stocks tracked, sectors active, feed health
- **6 interactive Chart.js charts**: sector trends, stock prices, capex/AI spending, digest performance, token usage, feed health
- **Article filtering** — sector pills, impact filter, indexed Postgres full-text search (title, summary, source, category)
- **Expandable article rows** — click any row to inline-expand: full summary, analyst reason, and source link; chevron rotates on open
- **Pagination** — "Load More" fetches additional 20 articles via cursor
- **SEC filings table** — capex, AI revenue, margins, guidance, impact scores
- **Auto-refresh** every 60 seconds
- Reads directly from Supabase REST API

### 📊 Intelligence Layer (v5)
- **`daily_derived_metrics` table** — polymorphic time-series store: `entity_type IN ('ticker', 'sector')`, one row per entity per day
- Written automatically at the end of every pipeline run via `writeDerivedMetrics()`
- **"What Changed" header** — `buildWhatChanged()` queries the last 8 days, computes WoW mention deltas, surfaces top movers (≥20% change) in the digest header as a Market Pulse block
- **`/trends NVDA 30d`** — Unicode sparkline (▁▂▄▆█) of daily mention counts + WoW delta + current price; works for any ticker or sector
- **Backfill script** — `scripts/backfill-derived-metrics.ts` seeds historical data from existing `sector_activity` + `stock_mentions` rows; idempotent (safe to re-run); `--days=90` for full history
- **Idempotent upsert** — `UNIQUE(date, entity_type, entity)` + `resolution=merge-duplicates`; re-running the pipeline on the same day is always safe

### 👍 Article Validation (v6)
- **Inline 👍/👎 buttons** — after every digest delivery, a compact "Quick Validation" follow-up message lists the top 3 highest-impact articles with per-article thumbs buttons
- **`article_validations` table** — one row per user per article (`UNIQUE(article_id, chat_id)`); double-vote silently ignored with "Already rated!" toast
- **Aggregate counters** — `thumbs_up` / `thumbs_down` columns on `articles` table updated atomically after each new vote
- **`insertArticles()` returns IDs** — Supabase `return=representation` gives `{id, url}[]` back; IDs flow through `persistDigestMetrics()` → `sendValidationFollowUp()` without changing the fan-out architecture
- **Fan-out safe** — validation follow-up sent independently to each user in the scheduler loop after the single `persistDigestMetrics()` call; never blocks digest delivery

### 🗄️ Database (Supabase)
- **22 tables**: `digest_runs`, `articles`, `sector_activity`, `stock_mentions`, `pipeline_health`, `capex_tracking`, `ai_usage`, `daily_metrics`, `stock_prices`, `user_preferences`, `user_delivery_log`, `sec_filings`, `earnings_transcripts`, `daily_derived_metrics`, `article_validations`, `ticker_theses`, `ticker_thesis_history`, `price_watches`, `command_usage`, `delivery_metrics_daily`, `alert_delivery_log`, `product_events`
- Managed with **Supabase CLI** — migrations in `supabase/migrations/`
- `digest_runs` tracks both models (`ai_model` + `ai_fast_model`)
- `articles` has `is_sec_filing` boolean, `thumbs_up` / `thumbs_down` aggregate validation counters, `bear_case TEXT` (skeptical counter-argument for high-impact articles), an optional `embedding vector(1536)` from OpenAI `text-embedding-3-small`, and `corroboration_count` / `grounding_text` / `effective_score` (v14 — persists ranking/grounding data that used to be computed in-memory each run and discarded afterward)
- `user_preferences` has `digest_length` column (`brief` | `standard` | `detailed`)
- `daily_derived_metrics` has `entity_type`, `entity`, mention counts, sentiment, impact scores, price data
- `article_validations` — per-user vote log; `UNIQUE(article_id, chat_id)` prevents double-voting
- `ticker_theses` — latest-only bull/bear snapshot per ticker (`UNIQUE(ticker)`); `ticker_thesis_history` — every weekly snapshot kept (`UNIQUE(ticker, week_of)`), powers the `/thesis TICKER` timeline and dashboard history card
- `price_watches` — one-shot price thresholds (`UNIQUE(chat_id, ticker)` upserts on re-set); service-role-only RLS, no public read (per-user private data, unlike the public-read thesis tables)
- `command_usage` — append-only bot-command invocation log (v13); service-role-only RLS, answers "does this feature actually get used?" with data instead of guesses
- RLS enabled on all tables; writes scoped `TO service_role` (migration `20260629000000`), public dashboard reads limited to non-private analytics tables, and `user_preferences` remains service-role-only
- **Performance indexes** — 16+ indexes including GIN full-text search, partial indexes for SEC filings and active users, time-series indexes on `daily_derived_metrics`, article validation lookup
- **Automated retention** — `cleanup_old_data()` prunes articles (90d), pipeline health (30d), AI usage (90d), delivery and alert logs (90d), private product events (180d), and capex tracking (365d). Triggered weekly by `.github/workflows/data-retention.yml` — no manual `pg_cron` setup required.

### 📈 Structured Logging & Metrics
- **Per-day NDJSON logs** — `logs/YYYY-MM-DD.ndjson`, written to disk and streamed to stdout
- **Event types**: `feed_fetch`, `ai_batch`, `stock_fetch`, `digest_delivery`, `error`
- **Daily summary** — `summarizeRun()` aggregates all events for a date
- **Supabase persistence** — key metrics upserted to `daily_metrics` at pipeline end

### 🔔 Error Handling & Alerts
- **Source health alerts** — if >20% of RSS feeds fail, admin gets a Telegram alert listing failing feeds
- **Dead feed detection** — feeds failing 3+ consecutive runs are flagged as likely dead/URL-changed (distinct from a transient blip) in logs and error events
- **High-impact alert system** — articles scoring 8+/10 trigger idempotent instant alerts to opted-in users; a service-role claim prevents repeats across overlapping or rerun pipelines
- **Budget cap** — daily threshold alerts; 30-day rolling cap actually blocks the run pre-spend (see Scheduled Delivery above)
- **AI provider failover** — optional `AI_FALLBACK_*` secondary provider tried once if the primary exhausts all retries, so one provider outage doesn't abort the whole digest; disabled in current scheduled production until its key is configured
- **`withRetry<T>()`** — exponential backoff + full-jitter for AI calls (including embeddings and bear-case generation); non-retryable errors (401) bypass retry
- **`tryStage<T>()`** — never-throws wrapper for optional stages (SEC, earnings, stocks); one stage failing never crashes the pipeline
- **Structured error events** — AI 429, Yahoo Finance failures, Supabase errors all emit `ErrorEvent` with recovery suggestions

### 🧪 Testing & CI
- **336 passing unit tests** with **Vitest** in the offline CI gate (`npm run test:unit`, 44 test files):
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
- **`npm run test:unit`** is the passing offline gate. **`npm test`** also includes the three integration-labelled mocked suites; the current repository run reports 381 passing tests across 47 files.
- **CI workflow** — `.github/workflows/ci.yml` runs `npm run lint` (`tsc --noEmit`) then `npm run test:unit` on every push/PR to main; all current workflows declare explicit `permissions: contents: read` and run on Node 22
- **CodeQL** (v13) — `.github/workflows/codeql.yml` runs static security analysis (`javascript-typescript`, `security-extended` query pack) on every push/PR plus a weekly full scan; `github/codeql-action` steps SHA-pinned like every other action in this repo
- **TypeScript strict mode** — entire project compiles cleanly with zero errors (`tsc --noEmit`)
- **Full audit** — see [`AUDIT.md`](AUDIT.md) for the complete findings report (30 items across security/bugs/performance/architecture/tests/deps) and remediation checklist

---

## Architecture

```
RSS Feeds (68 sources, conditional GET + ETag cache)
      │
      ▼
Step 1: News Collector (rss-parser + keyword filter + retry backoff)
      │
      ├── Step 1b: SEC EDGAR Watcher (35 companies, 8-K/10-K/10-Q)
      │
      ▼
Step 1c: Dedup (URL match + Jaccard; optional cosine similarity when embeddings are available)
      │
      ▼
Step 2: AI Processor (two-tier routing)
      ├── Cache check: SHA-256(article URLs) → .ai-cache/ (23h TTL)
      ├── Classification: Fast Model (openai/gpt-oss-20b)
      ├── Synthesis: Strong Model (openai/gpt-oss-120b)
      └── SEC Two-Pass: keyword filter → fast flag → strong extract
      │
      ▼
Step 2a0: Relevance Filter — drop articles with AI relevanceScore < 4
      │
      ▼
Step 2d: Optional embeddings (v8.0) — text-embedding-3-small via OpenAI; rebuild corroboration map with cosine (v8.1)
         Seed embeddings cached to .cache/seed-embeddings.json (keyed by content hash)
      │
      ▼
Step 2e: Optional Semantic Relevance Gate (v8.2) — cosine vs 20 seed sentences, threshold 0.55
         Runs before bear cases to avoid wasted LLM spend on off-topic articles
      │
      ▼
Step 2a: Article Enrichment (🏛️ SEC badge, bear cases)
      │
      ▼
Step 2a1: Novelty Check — flag rehashes (48h Jaccard, 0.6× multiplier)
      │
      ▼
Step 2b: Optional Earnings Transcript Mining (Roic.ai + two-pass AI)
      │
      ▼
Step 2c: Yahoo Finance (stock prices for mentioned tickers)
      │
      ▼
Step 3b: writeDerivedMetrics() — upsert sector + ticker rows to daily_derived_metrics
      │
      ▼
Step 3c: buildWhatChanged() — query last 8 days, compute WoW movers (≥20%)
      │
      ▼
Step 3: generateDigest() → GeneratedDigest bundle (format once, includes whatChanged)
      │
      ▼
Step 4: Fan-out delivery loop
      ├── For each user: applyUserFilter(bundle, userPrefs) → re-format → send
      │     applies: min_impact_score, categories_enabled, watchlist boost, digest_length trim
      │     whatChanged Market Pulse block injected in header when ≥7 days history available
      └── Default chat: send shared pre-formatted message (zero overhead)
      │
      ▼
Step 5: persistDigestMetrics() — writes to Supabase ONCE per generation
      ├── digest_runs, articles (returns {id,url}[]), sector_activity, stock_prices, daily_metrics
      └── Returns Map<url,id> for validation follow-up
      │
      ▼
Step 6: sendValidationFollowUp() — per user, after persist
      ├── Top-3 articles by impact score → 👍/👎 inline keyboard
      └── va_* callback handler records vote → article_validations + thumbs counter
```

---

## Quick Start

### Prerequisites

- **Node.js 22**
- **Telegram Bot Token** — [@BotFather](https://t.me/BotFather)
- **AI API Key** — [Groq](https://console.groq.com) (free) / [OpenAI](https://platform.openai.com) / [OpenRouter](https://openrouter.ai)
- **Supabase account** — [supabase.com](https://supabase.com)

### Setup

```bash
npm install
cp .env.example .env
# Edit .env with your API keys
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Your Telegram chat/user ID |
| `AI_API_KEY` | ✅ | — | API key for your AI provider |
| `AI_PROVIDER` | ❌ | `groq` | `groq`, `openai`, `openrouter`, `custom` |
| `AI_MODEL` | ❌ | `openai/gpt-oss-120b` | Strong model for synthesis & SEC extraction |
| `AI_FAST_MODEL` | ❌ | `openai/gpt-oss-20b` | Fast model for classification & SEC flagging |
| `AI_FALLBACK_PROVIDER` | ❌ | — | Secondary provider tried only if the primary fails after all retries (`openai`, `groq`, `openrouter`, `custom`) |
| `AI_FALLBACK_API_KEY` | ❌ | — | API key for the fallback provider — set this to enable failover |
| `AI_FALLBACK_MODEL` | ❌ | `gpt-4o-mini` | Strong model on the fallback provider |
| `AI_FALLBACK_FAST_MODEL` | ❌ | `gpt-4o-mini` | Fast model on the fallback provider |
| `SUPABASE_URL` | ❌ | — | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ❌ | — | Supabase service role key |
| `OPENAI_EMBEDDING_API_KEY` | ❌ | — | Optional OpenAI key for `text-embedding-3-small` vectors; can share `OPENAI_API_KEY` if using OpenAI provider. Without a working key, deduplication uses URL/Jaccard fallbacks and the semantic gate is skipped; persistent HTTP 429 also degrades to those fallbacks for that run |
| `ROIC_AI_API_KEY` | ❌ | — | Optional Roic.ai API key for earnings transcripts; without it, the earnings stage is skipped |
| `WEBHOOK_URL` | ❌ | — | Public URL for webhook bot auto-registration |
| `WEBHOOK_SECRET` | ❌* | — | Secret token for webhook request validation. *Required to start `src/webhook.ts` at all (not just when `WEBHOOK_URL` is set) — not needed for `npm run dev`/`npm run scheduler` |
| `PORT` | ❌ | `3000` | Webhook server port |
| `SLACK_WEBHOOK_URL` | ❌ | — | Slack Incoming Webhook URL for digest delivery |
| `SMTP_USER` | ❌ | — | Gmail address that *owns* the App Password (e.g. `sender@gmail.com`) |
| `SMTP_PASS` | ❌ | — | 16-char Gmail App Password (no spaces; 2FA required on the account) |
| `DIGEST_EMAIL_TO` | ❌ | — | Recipient email address for digest delivery |
| `AI_BUDGET_DAILY_USD` | ❌ | `0.50` | Daily AI spend cap; Telegram alert when breached |
| `AI_BUDGET_MONTHLY_USD` | ❌ | `5.00` | 30-day rolling AI spend cap |
| `MAX_ARTICLES_FOR_AI` | ❌ | `35` | Maximum deduplicated articles sent to the AI per run (clamped to 1–100) |

### Get Your Telegram Chat ID

1. Message your bot on Telegram
2. Run: `curl https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Find `chat.id` and add it to `.env`

### Run Locally

```bash
npm run dev          # Run pipeline once (polling mode)
npm run scheduler    # Run per-user delivery check
npm run webhook      # Start webhook server (tsx, local dev)
npm run preflight    # Validate local configuration without network calls
npm run preflight:network # Read-only authentication checks; sends nothing
npm run test:unit    # Run 336 unit tests (offline, no credentials needed)
npm test             # Run the full suite, including mocked integration-labelled tests

# Backfill historical derived metrics (run once after first pipeline runs)
npx tsx scripts/backfill-derived-metrics.ts --days=5    # test with 5 days first
npx tsx scripts/backfill-derived-metrics.ts --days=90   # full 90-day history
```

---

## Database (Supabase CLI)

Migrations live in `supabase/migrations/` and are managed with the Supabase CLI.

### First-time setup

```bash
npx supabase login
npx supabase link --project-ref <your-ref>   # ref from your Supabase dashboard URL
```

### Apply migrations

```bash
npm run db:push      # Apply pending migrations to remote DB
npm run db:status    # List migration history
npm run db:diff      # Generate migration from schema changes
npm run db:pull      # Sync remote schema to local
```

### Local reset

```bash
npm run db:reset     # Reset the local database with migrations and the safe seed file
```

This command requires the local Supabase/Docker stack but does not require Supabase login, a linked project, or application secrets. `supabase/seed.sql` is intentionally comment-only, so reset creates a clean schema without inserting credentials or sample data.

### Migration history

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

---

## GitHub Actions (Production)

### Daily Digest

`.github/workflows/daily-digest.yml` — runs at **8:00 AM MYT** (midnight UTC). Generates and sends the digest to the default `TELEGRAM_CHAT_ID`.

### Scheduled Per-User Delivery

`.github/workflows/scheduled-delivery.yml` — runs **every 10 minutes** with overlapping runs serialized. It queries active users, finds those whose `preferred_time` is due and not successfully delivered for their local date, generates once, and fans out. Delayed GitHub cron ticks remain eligible because due state is date-based rather than a narrow clock window.

### Data Retention

`.github/workflows/data-retention.yml` — runs **weekly (Sunday 3 AM UTC)**, calling the `cleanup_old_data()` Supabase RPC (see `scripts/run-retention-cleanup.ts`) to prune high-volume operational and private event data according to the retention periods above. Supports manual `workflow_dispatch`.

### Weekly Thesis Snapshots

`.github/workflows/weekly-thesis.yml` — runs **weekly (Sunday 4 AM UTC)**, generating bull/bear thesis snapshots for the top-10 most-mentioned tickers from 30 days of `daily_derived_metrics` + `sec_filings` data (one batched strong-model call, ~$0.01/week); upserts into `ticker_theses`. Query via `/thesis NVDA` or the dashboard's Thesis Snapshots card. Supports manual `workflow_dispatch`.

### CI

`.github/workflows/ci.yml` — runs on every push and PR to `main`. Executes `tsc --noEmit` (type gate) then unit tests (336 tests, no credentials needed, fast).

### CodeQL

`.github/workflows/codeql.yml` — runs on every push/PR to `main` plus a weekly full scan (Monday 5 AM UTC). Static security analysis over `javascript-typescript` with the `security-extended` query pack; results surface in the repo's Security tab. Added in v13 as the one AUDIT.md meta-recommendation that hadn't been implemented yet.

### GitHub Actions secrets

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `TELEGRAM_CHAT_ID` | Default chat ID |
| `AI_API_KEY` | Groq/OpenAI API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SLACK_WEBHOOK_URL` | Slack Incoming Webhook URL (optional) |
| `SMTP_USER` | Gmail sender address (optional) |
| `SMTP_PASS` | Gmail App Password — 16 chars, no spaces (optional) |
| `DIGEST_EMAIL_TO` | Recipient email address (optional) |
| `WEBHOOK_SECRET` | Webhook validation secret (required for Render/Railway) |
| `OPENAI_EMBEDDING_API_KEY` | Embedding API key (optional; absent in current scheduled production) |
| `ROIC_AI_API_KEY` | Earnings transcript API key (optional; absent in current scheduled production) |
| `AI_FALLBACK_API_KEY` | Secondary AI provider key (optional; absent in current scheduled production) |

Repository variables can configure optional model names, custom base URLs, fallback
provider selection, and `AI_BUDGET_DAILY_USD` / `AI_BUDGET_MONTHLY_USD`; unset
variables use the workflow defaults. Both digest workflows pass the same AI,
embeddings, earnings, fallback, and budget settings when they are configured, so
hosted runs do not silently lose locally enabled stages.

---

## Webhook Deployment (Always-On Bot)

To make interactive commands work 24/7, deploy the webhook server:

```bash
npm run build && npm run start:webhook   # production
```

A `Dockerfile` is included. Set env vars `TELEGRAM_BOT_TOKEN`, `WEBHOOK_URL`, `WEBHOOK_SECRET` on your host. The server auto-registers the webhook with Telegram on startup.

See **`WEBHOOK_SETUP.md`** for Render/Railway/Fly.io deployment steps.

---

## Project Structure

```
ai-infra-digest/
├── .env.example
├── AUDIT.md                                  # Full codebase audit — findings, root causes, roadmap, checklist
├── .github/workflows/
│   ├── ci.yml                                # Push/PR: lint + unit tests
│   ├── codeql.yml                            # v13 — push/PR + weekly: CodeQL security analysis
│   ├── daily-digest.yml                      # 8 AM MYT cron
│   ├── scheduled-delivery.yml               # Every 30 min, per-user fan-out
│   ├── data-retention.yml                    # Weekly: calls cleanup_old_data() RPC
│   └── weekly-thesis.yml                     # Weekly: bull/bear thesis snapshots
├── Dockerfile                                # Webhook bot container
├── WEBHOOK_SETUP.md                          # Webhook deployment guide
├── website/
│   ├── index.html                            # Public landing page
│   ├── build-dashboard-config.mjs             # Vercel-only config artifact generator; no client key is tracked
│   └── dashboard/
│       └── index.html                        # Graphite+copper terminal dashboard (public read + expand/collapse)
├── scripts/
│   ├── test-digest.ts                        # Manual pipeline test
│   ├── test-email.ts                         # Standalone Gmail SMTP credential tester (verify auth before a full run)
│   ├── preflight.ts                          # Local config audit + optional read-only credential checks
│   ├── backfill-derived-metrics.ts           # Backfill daily_derived_metrics from historical data
│   ├── run-retention-cleanup.ts              # Calls cleanup_old_data() RPC — used by data-retention.yml
│   └── migration-v3.sql                      # Reference: applied via Supabase CLI
├── supabase/
│   ├── config.toml                           # Supabase CLI project config
│   ├── seed.sql                               # Safe, empty local-reset seed
│   └── migrations/                           # Numbered migration files
├── src/
│   ├── index.ts                              # Thin process entry point; wires commands and pipeline execution
│   ├── index.commands.test.ts                # /coverage, /thesis, /watch command handler tests
│   ├── index.faninout.test.ts                # Fan-out regression (generate once, deliver N times) + price watch delivery tests
│   ├── commands/
│   │   ├── register.ts                       # Single command-registration entry point
│   │   ├── core.ts                           # /digest, /sources, /last
│   │   ├── preferences.ts                    # /alert, /watch, /delivery, /feedback
│   │   ├── trends.ts                         # /trending, /trends, /sources quality
│   │   └── research.ts                       # /sec, /coverage, /thesis
│   ├── delivery/
│   │   ├── deliver.ts                        # Telegram/Slack/email fan-out and price-watch delivery
│   │   └── personalization.ts                # Per-user filtering and digest-length shaping
│   ├── pipeline/
│   │   ├── run.ts                            # Generate once, then deliver to the default recipient
│   │   ├── generate.ts                       # Collection, enrichment, ranking, and digest assembly
│   │   ├── persist.ts                        # Database writes, metrics, trends, and budget alerts
│   │   ├── trending.ts                       # Shared trending-item contract
│   │   └── types.ts                          # GeneratedDigest boundary type
│   ├── scheduler.ts                          # Per-user cron runner; due-state fan-out by local date
│   ├── scheduler.test.ts                     # isDeliveryDue/getDeliveryDate unit tests
│   ├── onboarding.ts                         # 4-step interactive onboarding state machine
│   ├── webhook.ts                            # Zero-dep webhook HTTP server
│   ├── config.ts                             # Env config loader (incl. budget caps)
│   ├── collector/
│   │   ├── rss.ts                            # 68 RSS feeds, conditional GET, retry backoff
│   │   ├── sec.ts                            # SEC EDGAR watcher — 35 companies
│   │   └── earnings.ts                       # Roic.ai earnings transcript fetcher
│   ├── formatter/
│   │   └── telegram.ts                       # HTML Telegram formatter (personalization note support)
│   ├── processor/
│   │   ├── ai.ts                             # Two-tier AI batch processing + ProcessedArticle type (incl. bearCase, embedding)
│   │   ├── bear-cases.ts                     # Devil's Advocate — batched AI bear case generation for high-impact articles
│   │   ├── embeddings.ts                     # v8.0 — generateEmbeddings() via OpenAI text-embedding-3-small (20-article batches)
│   │   ├── relevance.ts                      # v8.2 — 20 seed sentences + embedSeeds() (disk-cached) + passesSemanticGate()
│   │   ├── thesis.ts                         # v10.1 — weekly bull/bear thesis generation + history insert; v14 — collectRecentCoverage() grounds the prompt in /coverage's article data
│   │   ├── sec.ts                            # SEC two-pass extraction
│   │   └── earnings.ts                       # Earnings two-pass analysis + guidance delta
│   ├── sender/
│   │   ├── telegram.ts                       # Bot API; generic command dispatcher (v12.1) routes every registerCommand()-registered handler; sendValidationFollowUp, va_* callback
│   │   ├── telegram.routing.test.ts          # v12.1/v13 — proves every registered command is actually dispatchable + usage-logging behavior
│   │   ├── slack.ts                          # Slack Incoming Webhook — HTML→mrkdwn, chunked delivery
│   │   └── email.ts                          # Gmail SMTP via nodemailer — HTML email template
│   ├── webhook.test.ts                       # Webhook router unit tests
│   ├── tests/
│   │   ├── supabase.integration.test.ts      # Mocked Supabase REST boundary tests
│   │   ├── telegram.integration.test.ts      # Mocked Telegram Bot API boundary tests
│   │   └── stocks.integration.test.ts        # Mocked Yahoo Finance boundary tests
│   └── utils/
│       ├── grounding.ts                      # v9.1 — attachGroundingNotes(): cross-reference tickers vs SEC/earnings/stock data in-memory
│       ├── ai-cache.ts                       # File-based AI response cache (SHA-256 key, 23h TTL)
│       ├── ai-schema.ts                      # v10.2 — shared zod nullableFinancialNumber (used by processor/sec.ts + earnings.ts)
│       ├── escape.ts                         # v10.2 — escapeHtml() + stripHtmlTags() (single source, used at collection + render time)
│       ├── derived-metrics.ts                # daily_derived_metrics writer + query helpers
│       ├── dedup.ts                          # URL + Jaccard/cosine dedup + cosineSimilarity() + buildCorroborationMap() (async cache I/O)
│       ├── helpers.ts                        # sleep() + todayInTimezone() (v10.2 — timezone-correct run-date helper)
│       ├── source-credibility.ts             # Static source-name → credibility multiplier + isPRWireSource() PR wire detection
│       ├── novelty.ts                        # 48h rehash detection — flags isRehash via Jaccard similarity against recent DB articles
│       ├── ranking.ts                        # v16 auditable score calculation + concise ranking reasons
│       ├── trust-scores.ts                   # Vote-learned source/sector multipliers from article_validations (1h TTL cache)
│       ├── price-watch.ts                    # v12 — pure inferDirection()/isTriggered() helpers for one-shot price watches
│       ├── logger.ts                         # Structured timestamped logger
│       ├── metrics.ts                        # NDJSON event logging (async file writes); emitCommandUsage() (v13)
│       ├── metrics.test.ts                   # v13 — emitCommandUsage() event-shape tests
│       ├── retry.ts                          # withRetry<T> + tryStage<T> utilities
│       ├── stocks.ts                         # Yahoo Finance price fetcher
│       └── supabase.ts                       # Supabase REST CRUD (22 tables); article/SEC persistence; retryable delivery and alert claims; private product events
├── supabase-schema.sql                       # Historical schema reference snapshot — migrations/ is canonical, see header note
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

---

## News Sources

**Tier 1 — Company & Financial (50 feeds)**
NVIDIA, Microsoft, AMD, Broadcom, Amazon, Google, Meta, TSMC, Intel, Qualcomm, Oracle, IBM, Micron, ASML, Super Micro, Dell, ARM, Arista, Cisco, Marvell, Applied Materials, Lam Research, KLA, Tokyo Electron, Digital Realty, Equinix, Constellation Energy, Vistra, GE Vernova, Siemens Energy, Vertiv, Schneider Electric, Eaton, Anthropic, xAI, Mistral AI, Cohere, SK hynix, Samsung, GlobalFoundries + MarketWatch, Yahoo Finance, CNBC, Reuters Tech, Bloomberg Tech, FT Tech, Barron's, WSJ Markets, Investor's Business Daily, SEC Filings (EDGAR current filings feed)

**Tier 2 — Industry News (18 feeds)**
Tom's Hardware, ServeTheHome, Ars Technica, TechCrunch, The Verge, Seeking Alpha, SemiAnalysis, The Register, Datacenter Dynamics, Semiconductor Engineering, Google AI Blog, OpenAI, AWS AI, VentureBeat AI, AI News, Medium AI, AI Business, ZDNet AI

---

## Cost Estimate

| Service | Cost |
|---|---|
| GitHub Actions | Free (2,000 min/month; ~120 min/month used) |
| Groq fast model (~80% of tokens) | ~$0.004/day |
| Groq strong model (~20% of tokens) | ~$0.003/day |
| SEC two-pass (~5 filings/day) | ~$0.02/day |
| Supabase | Free tier (500 MB, 50k rows) |
| Telegram Bot API | Free |
| Yahoo Finance | Free |
| **Total** | **< $1/month** |

---

## Implementation history

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
- **v9.1 (channels)** — Slack + Gmail delivery — digest fans out to Telegram, Slack (Incoming Webhook, HTML→mrkdwn), and Gmail (nodemailer SMTP) in parallel; `Promise.allSettled` keeps Slack/email failures non-fatal; `scripts/test-email.ts` for fast credential verification without a full pipeline run
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
- **v10.2 — Full codebase audit + remediation** — see [`AUDIT.md`](AUDIT.md) for the complete report (30 findings, root-cause analysis, 3-horizon roadmap). Every Critical/High finding fixed, plus the full Short-Term checklist:
  - **Security** — untrusted RSS content now passed to the AI as fenced/escaped JSON with explicit anti-injection instructions (was raw prose interpolation); RSS titles/content HTML-stripped at collection time in addition to render-time escaping; `WEBHOOK_SECRET` required unconditionally to start the webhook server; NDJSON logs untracked from git
  - **Reliability** — `fetchTranscript()`'s 429 retry now caps at 2 attempts (was unbounded recursion); scheduler delivery is now claimed atomically per `(chat_id, run_date)` immediately before sending, closing a double-delivery race under overlapping cron runs; run dates computed in the configured timezone instead of UTC
  - **Data integrity** — a zod validation layer now sits in front of every AI JSON response (`ai.ts`, `sec.ts`, `bear-cases.ts`, `thesis.ts`, `earnings.ts`), coercing type-confused fields (e.g. `"8"` instead of `8`) instead of crashing `.toFixed()` calls downstream — caught and fixed a live instance of this exact bug in `processor/earnings.ts` while adding coverage
  - **Performance** — `metrics.ts` and `dedup.ts` switched from sync to async file I/O; onboarding sessions now expire after 30 minutes with a periodic sweep (was unbounded growth)
  - **CI/CD** — all 5 workflows hardened with explicit `permissions: contents: read`, standardized on Node 22, and now alert Slack on failure
  - **Tests** — expanded mocked coverage for the previously-uncovered AI/collector and operational boundaries; the current suite reports 381 passing tests
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

---

## Disclaimer

**Not financial advice.** Informational tool for the AI infrastructure community — always do your own research before making investment decisions.

---

Built with ❤️ — Powered by Llama 3.3 70B (strong) + Llama 3.1 8B (fast) via Groq · Optional embeddings via OpenAI `text-embedding-3-small` when configured.
