# 🏆 Goldirham Stack

**Daily intelligence for the AI infrastructure age.** A pipeline that collects 57+ RSS feeds, analyzes news with AI, extracts SEC filings from 35 companies, and delivers a personalized morning digest via Telegram at each user's preferred time.

Covers the **full AI infrastructure value chain**: power generation → cooling → networking → chips → AI models.

---

## Features

### 📡 News Pipeline
- **57 RSS feeds** across 2 tiers (company news + industry analysis)
- **Smart deduplication** — URL matching + **Jaccard similarity** (catches near-identical headlines from different sources)
- **10-sector classification**: Chips & GPUs, Cloud & Hyperscalers, Datacenters, Networking, Semiconductor Manufacturing, Power & Utilities, Cooling Infrastructure, AI Models & Labs, M&A, Earnings
- **200+ keyword filter** — AI/semiconductor relevance gate
- **Conditional GET caching** — ETag/Last-Modified headers per feed, 304 for unchanged content
- **Consecutive failure tracking** — feeds failing 2+ runs in a row are automatically skipped
- **RSS retry with exponential backoff** — up to 2 retries with full-jitter backoff
- **🏛️ SEC Alert Badge** — articles detected as SEC filings get a 🏛️ badge in the digest and `is_sec_filing` flag in Supabase

### 🤖 AI Processing
- **Multi-provider**: Groq (default), OpenAI, OpenRouter, or custom endpoints
- **Two-tier model routing** — fast/cheap model (llama-3.1-8b-instant) for classification; strong model (llama-3.3-70b-versatile) for synthesis — saves **40–60% on AI costs**
- **Dynamic batch sizing** — 5–15 articles/batch, targeting ~4 batches
- **Batch processing** with exponential backoff (full-jitter, up to 3 attempts)
- **Synthesis pass** — market outlook, top stocks, daily summary
- **Token tracking** — `prompt_tokens`, `completion_tokens`, `total_tokens` per run, both model names stored in Supabase

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
- **Graceful degradation** — skips when `ROIC_AI_API_KEY` is not set

### 💰 Stock Prices
- **Yahoo Finance** integration — daily price snapshots for 30+ tickers
- Fetched automatically for every stock mentioned in the AI analysis
- Stored in `stock_prices` table for dashboard history charts

### 📱 Interactive Telegram Bot

> **Note:** Interactive commands require the webhook server to be deployed (see `WEBHOOK_SETUP.md`). Under the default GitHub Actions cron, the bot is not always-on — it polls only during the brief daily run window (~3–4 min). For 24/7 command response, deploy `src/webhook.ts` to Render/Railway/Fly.io.

| Command | Description |
|---------|-------------|
| `/start` | Welcome & register your preferences |
| `/help` | Show all available commands |
| `/digest` | Show recent stored articles (filtered by your watchlist/sector if set) |
| `/digest watchlist` | Filter stored articles by your saved watchlist tickers |
| `/digest sector=Chips_&_GPUs` | Filter stored articles by sector |
| `/sources` | List all 57 tracked RSS feeds with health status |
| `/last` | Show the most recent digest summary from Supabase |
| `/trending` | See what's trending in AI infra (last 7 days) |
| `/sec NVDA` | Latest SEC filing highlights for a ticker |
| `/feedback 5` | Rate today's digest (1–5) with optional comment |
| `/settings` | View your user preferences |
| `/watchlist NVDA,AMD,AVGO` | Set your ticker watchlist |
| `/alert on` | Enable instant high-impact alerts (score 8+) |
| `/alert off` | Disable alerts |
| `/alert threshold 9` | Set minimum impact score for alerts |

### ⏰ Scheduled Delivery (Per-User, Fan-Out)
- **Generate once, deliver to all** — RSS crawl + AI runs a single time per cron tick regardless of user count; the formatted digest is fanned out per user (no redundant AI cost)
- **Real personalization at delivery** — each user's copy is filtered from the shared bundle using their stored preferences:
  - `min_impact_score` — drops articles below their threshold
  - `categories_enabled` — keeps only their selected sectors
  - `watchlist` — floats watchlist-ticker articles and stocks to the top; adds a `🎯 Filtered for you` note in the header
- **Custom delivery times** — each user sets `preferred_time` via `/settings`
- **Timezone-aware** — delivery triggers at the user's local time
- **Idempotent** — `user_delivery_log` prevents duplicate deliveries on overlapping cron runs
- **GitHub Actions cron** — runs every 30 minutes, checks all active users, delivers only to those at their preferred time

### 🌐 Production Webhook Bot
- **`src/webhook.ts`** — zero-dependency Node `http` server; registers all command handlers in non-polling mode
- **`enableWebhookMode()`** — switches bot from polling to `processUpdate` before startup
- **Secret token validation** — rejects requests without matching `X-Telegram-Bot-Api-Secret-Token` header
- **Auto-registers webhook** on startup when `WEBHOOK_URL` is set
- **`Dockerfile`** — multi-stage build, runs `dist/webhook.js`, exposes port 3000
- Deploy to Render/Railway/Fly.io — see **`WEBHOOK_SETUP.md`**

### 📊 Dashboard
- **Graphite + copper terminal design** — `#0a0b0e` dark background, `#cb8a4c` copper accent, Space Grotesk display font, JetBrains Mono for data
- **Fixed rail navigation** — Overview, Pipeline, Stocks, SEC Filings, Articles sections; collapses to horizontal on mobile
- **Market pulse ribbon** — live stock ticker strip populated from Supabase
- **KPI cards** — articles processed, stocks tracked, sectors active, feed health
- **6 interactive Chart.js charts**: sector trends, stock prices, capex/AI spending, digest performance, token usage, feed health
- **Article filtering** — sector pills, impact filter, full-text search (title, summary, source, stocks)
- **Pagination** — "Load More" fetches additional 20 articles via cursor
- **SEC filings table** — capex, AI revenue, margins, guidance, impact scores
- **Auto-refresh** every 60 seconds
- Reads directly from Supabase REST API — configure credentials via ⚙️ gear icon (saved to localStorage)

### 🗄️ Database (Supabase)
- **13 tables**: `digest_runs`, `articles`, `sector_activity`, `stock_mentions`, `pipeline_health`, `capex_tracking`, `ai_usage`, `daily_metrics`, `stock_prices`, `user_preferences`, `user_delivery_log`, `sec_filings`, `earnings_transcripts`
- Managed with **Supabase CLI** — migrations in `supabase/migrations/`
- `digest_runs` tracks both models (`ai_model` + `ai_fast_model`)
- `articles` has `is_sec_filing` boolean for SEC badge articles
- RLS enabled on all tables; service role key used for writes, public read for dashboard

### 📈 Structured Logging & Metrics
- **Per-day NDJSON logs** — `logs/YYYY-MM-DD.ndjson`, written to disk and streamed to stdout
- **Event types**: `feed_fetch`, `ai_batch`, `stock_fetch`, `digest_delivery`, `error`
- **Daily summary** — `summarizeRun()` aggregates all events for a date
- **Supabase persistence** — key metrics upserted to `daily_metrics` at pipeline end

### 🔔 Error Handling & Alerts
- **Source health alerts** — if >20% of RSS feeds fail, admin gets a Telegram alert listing failing feeds
- **High-impact alert system** — articles scoring 8+/10 trigger instant alerts to opted-in users
- **Structured error events** — AI 429, Yahoo Finance failures, Supabase errors all emit `ErrorEvent` with recovery suggestions
- **Supabase error recording** — failed pipeline runs logged with error message and stack

### 🧪 Testing
- **58 tests** with **Vitest**:
  - Deduplication: 5 unit tests
  - Keyword matching: 13 unit tests
  - Stock price fetching: 3 unit tests
  - Telegram formatter: 5 unit tests
  - Supabase integration: 15 tests (requires live credentials)
  - Telegram integration: 9 tests (requires live credentials)
  - Stocks integration: 8 tests (requires live credentials)
  - Fan-out regression: 1 test — proves `collectArticles` called once for N deliveries
- **26 unit tests** run offline; **32 integration tests** require live Telegram/Supabase/Yahoo credentials
- **TypeScript strict mode** — entire project compiles cleanly with `tsc --noEmit`

---

## Architecture

```
RSS Feeds (57 sources, conditional GET + ETag cache)
      │
      ▼
Step 1: News Collector (rss-parser + keyword filter + retry backoff)
      │
      ├── Step 1b: SEC EDGAR Watcher (35 companies, 8-K/10-K/10-Q)
      │
      ▼
Step 1c: Dedup (URL match + Jaccard similarity)
      │
      ▼
Step 2: AI Processor (two-tier routing)
      ├── Classification: Fast Model (llama-3.1-8b-instant)
      ├── Synthesis: Strong Model (llama-3.3-70b-versatile)
      └── SEC Two-Pass: keyword filter → fast flag → strong extract
      │
      ▼
Step 2b: Article Enrichment (🏛️ SEC badge via regex)
      │
      ▼
Step 2c: Earnings Transcript Mining (Roic.ai + two-pass AI)
      │
      ▼
Step 2d: Yahoo Finance (stock prices for mentioned tickers)
      │
      ▼
Step 3: generateDigest() → GeneratedDigest bundle (format once)
      │
      ▼
Step 4: Fan-out delivery loop
      ├── For each user: applyUserFilter(bundle, userPrefs) → re-format → send
      └── Default chat: send shared pre-formatted message (zero overhead)
      │
      ▼
Step 5: persistDigestMetrics() — writes to Supabase ONCE per generation
      ├── digest_runs, articles, sector_activity, stock_prices, daily_metrics
      └── Dashboard reads live from Supabase REST API
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
| `AI_MODEL` | ❌ | `llama-3.3-70b-versatile` | Strong model for synthesis & SEC extraction |
| `AI_FAST_MODEL` | ❌ | `llama-3.1-8b-instant` | Fast model for classification & SEC flagging |
| `SUPABASE_URL` | ❌ | — | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | ❌ | — | Supabase service role key |
| `ROIC_AI_API_KEY` | ❌ | — | Roic.ai API key for earnings transcripts |
| `WEBHOOK_URL` | ❌ | — | Public URL for webhook bot auto-registration |
| `WEBHOOK_SECRET` | ❌ | — | Secret token for webhook request validation |
| `PORT` | ❌ | `3000` | Webhook server port |

### Get Your Telegram Chat ID

1. Message your bot on Telegram
2. Run: `curl https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Find `chat.id` and add it to `.env`

### Run Locally

```bash
npm run dev          # Run pipeline once (polling mode)
npm run scheduler    # Run per-user delivery check
npm run webhook      # Start webhook server (tsx, local dev)
npm test             # Run all 58 tests
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

### Migration history

| File | Description |
|---|---|
| `20240101000000_initial_schema.sql` | 13 tables + RLS policies |
| `20240601000000_v2_user_alerts.sql` | `alerts_enabled`, `alerts_min_score` columns |
| `20260624000000_v3_missing_columns.sql` | `ai_fast_model`, `is_sec_filing`, missing tables, RLS for new tables |

---

## GitHub Actions (Production)

### Daily Digest

`.github/workflows/daily-digest.yml` — runs at **8:00 AM MYT** (midnight UTC). Generates and sends the digest to the default `TELEGRAM_CHAT_ID`.

### Scheduled Per-User Delivery

`.github/workflows/scheduled-delivery.yml` — runs **every 30 minutes**. Queries active users, finds those whose `preferred_time` matches now, generates once, fans out.

### Required Secrets

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `TELEGRAM_CHAT_ID` | Default chat ID |
| `AI_API_KEY` | Groq/OpenAI API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |

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
├── .github/workflows/
│   ├── daily-digest.yml                  # 8 AM MYT cron
│   └── scheduled-delivery.yml            # Every 30 min, per-user fan-out
├── Dockerfile                            # Webhook bot container
├── WEBHOOK_SETUP.md                      # Webhook deployment guide
├── dashboard/
│   ├── index.html                        # Graphite+copper terminal dashboard
│   └── server.js                         # Static file server
├── scripts/
│   ├── test-digest.ts                    # Manual pipeline test
│   ├── migration-v2.sql                  # Alert system columns
│   └── migration-v3.sql                  # Missing columns + tables (v3)
├── supabase/
│   ├── config.toml                       # Supabase CLI project config
│   └── migrations/                       # Numbered migration files
├── src/
│   ├── index.ts                          # generateDigest, deliverDigest, applyUserFilter, persistDigestMetrics
│   ├── scheduler.ts                      # Per-user cron runner (fan-out)
│   ├── webhook.ts                        # Zero-dep webhook HTTP server
│   ├── config.ts                         # Env config loader
│   ├── collector/
│   │   ├── rss.ts                        # 57 RSS feeds, conditional GET, retry backoff
│   │   ├── sec.ts                        # SEC EDGAR watcher — 35 companies
│   │   └── earnings.ts                   # Roic.ai earnings transcript fetcher
│   ├── formatter/
│   │   └── telegram.ts                   # HTML Telegram formatter (personalization note support)
│   ├── processor/
│   │   ├── ai.ts                         # Two-tier AI batch processing
│   │   ├── sec.ts                        # SEC two-pass extraction
│   │   └── earnings.ts                   # Earnings two-pass analysis + guidance delta
│   ├── sender/
│   │   └── telegram.ts                   # Bot API, polling/webhook mode switch, command handlers
│   ├── tests/
│   │   ├── index.faninout.test.ts        # Fan-out regression (generate once, deliver N times)
│   │   └── webhook.test.ts               # Webhook router unit tests (7 cases)
│   └── utils/
│       ├── dedup.ts                      # URL + Jaccard similarity dedup
│       ├── logger.ts                     # Structured timestamped logger
│       ├── metrics.ts                    # NDJSON event logging
│       ├── stocks.ts                     # Yahoo Finance price fetcher
│       └── supabase.ts                   # Supabase REST CRUD (13 tables)
├── supabase-schema.sql                   # Full schema reference (13 tables + RLS)
├── vitest.config.ts
├── package.json
└── tsconfig.json
```

---

## News Sources

**Tier 1 — Company & Financial (37 feeds)**
NVIDIA, AMD, Broadcom, Microsoft, Amazon, Google, Meta, TSMC, Intel, Qualcomm, Oracle, IBM, Micron, ASML, Super Micro, Dell, ARM, Arista, Cisco, Marvell, Applied Materials, Lam Research, KLA, Digital Realty, Equinix, Constellation Energy, Vistra, GE Vernova, Siemens Energy, Vertiv, Schneider Electric, Eaton, Anthropic, xAI, Mistral AI, Cohere + MarketWatch, Yahoo Finance, CNBC, Reuters, Bloomberg Tech, FT Tech, Barron's, WSJ Markets

**Tier 2 — Industry News (20 feeds)**
Tom's Hardware, AnandTech, Ars Technica, TechCrunch, The Verge, Seeking Alpha, SemiAnalysis, The Register, Datacenter Dynamics, Semiconductor Engineering, Google AI Blog, OpenAI, AWS AI, VentureBeat AI, AI News, Medium AI, AI Business, ZDNet AI

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

## Roadmap

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

### Phase IV · Platform 🔨 Next
- **v3.4** — CI workflow — `npm test` (unit tests only) on every push via GitHub Actions; lint gate
- **v3.5** — `/digest` returns today's AI-generated digest on demand (cached from last pipeline run)
- **v4.0** — Dashboard 2.0 — Supabase Auth, public digest pages, SEC-derived charts (capex barometer, AI revenue index), CMD+K search for SEC filings
- **v4.1** — Earnings archive + historical trend charts on dashboard

### Phase V · Research 🔭 Future
- **v5** — Article archival, historical trend analysis, price threshold alerts, bull/bear thesis per ticker, competitive landscape analysis

---

## Disclaimer

**Not financial advice.** Informational tool for the AI infrastructure community — always do your own research before making investment decisions.

---

Built with ❤️ — Powered by Llama 3.3 70B (strong) + Llama 3.1 8B (fast) via Groq.
