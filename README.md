# 🏆 Goldirham Stack

**Daily intelligence for the AI infrastructure age.** — A pipeline that collects 57+ RSS feeds, analyzes news with AI, and delivers a curated morning digest via Telegram at each user's preferred delivery time.

Covers the **full AI infrastructure value chain**: power generation → cooling → networking → chips → AI models.

## Features

### 📡 News Pipeline
- **57 RSS feeds** across 2 tiers (company news + industry analysis)
- **Smart deduplication** — URL matching + **Jaccard similarity** (catches near-identical headlines from different sources)
- **10-sector classification**: Chips & GPUs, Cloud & Hyperscalers, Datacenters, Networking, Semiconductor Manufacturing, Power & Utilities, Cooling Infrastructure, AI Models & Labs, M&A, Earnings
- **Keyword filtering** — 200+ AI/semiconductor keywords
- **Conditional GET caching** — stores ETag/Last-Modified headers per feed, returns 304 for unchanged content, reducing bandwidth and parse time
- **Consecutive failure tracking** — feeds failing 2+ times in a row are automatically skipped
- **RSS retry with exponential backoff** — up to 2 retries per feed with full-jitter backoff

### 🤖 AI Processing
- **Multi-provider**: Groq (default), OpenAI, OpenRouter, or custom endpoints
- **Dynamic batch sizing** — automatically adjusts batch size (5–15 articles) to target ~4 batches, optimizing token cost vs. quality
- **Batch processing** with **exponential backoff** (full-jitter retry, up to 3 attempts)
- **Synthesis pass** — generates market outlook, top stocks, and daily summary
- **Token tracking** — actual `prompt_tokens`, `completion_tokens`, `total_tokens` recorded per run

### 💰 Stock Prices
- **Yahoo Finance** integration — daily price snapshots for 30+ tracked tickers
- Automatically fetches prices for every mentioned stock after AI analysis
- Stored in Supabase for historical trend charts

### 📱 Interactive Telegram Bot

| Command | Description |
|---------|-------------|
| `/start` | Welcome & register your preferences |
| `/help` | Show all available commands |
| `/digest` | Request the latest digest |
| `/digest watchlist` | Filter digest by your saved watchlist tickers |
| `/digest sector=Chips_&_GPUs` | Filter digest by sector |
| `/sources` | List all 57 tracked RSS feeds with health status |
| `/last` | Show the most recent digest summary from Supabase |
| `/trending` | See what's trending in AI infra (last 7 days) |
| `/feedback 5` | Rate today's digest (1–5) with optional comment |
| `/settings` | View your user preferences |
| `/watchlist NVDA,AMD,AVGO` | Set your ticker watchlist |
| `/alert on` | Enable instant high-impact alerts (score 8+) |
| `/alert off` | Disable alerts |
| `/alert threshold 9` | Set minimum impact score for alerts |

#### Inline Feedback Keyboard
`/feedback` without arguments shows an inline keyboard with star rating buttons (1–5) and a comment option.

### ⏰ Scheduled Delivery (Per-User)
- **Custom delivery times** — each user sets their `preferred_time` via `/settings`
- **Timezone-aware** — delivery triggers at the user's local time in their configured timezone
- **Idempotent** — `user_delivery_log` table prevents duplicate deliveries via upsert
- **GitHub Actions cron** — runs every 30 minutes, checks all active users, delivers only to those at their preferred time

### 📊 Premium Dashboard
- **Luxury fintech design** — gold `#D4A24C` accent, warm dark `#080605` background, Playfair Display serif typography
- **Fixed sidebar navigation** — Overview, Pipeline, Stocks, SEC Filings, Articles, Feedback sections
- **KPI cards** with animated value counters and gold-trimmed hover effects
- **Sector activity chart** with 7d/30d/90d range tabs, gold progress bars for top sectors
- **Quote widget** — AI infrastructure intelligence quote in serif italic
- **6 interactive charts**: Stock price history, sector trends, capex/AI spending, digest performance, token usage, feedback pulse
- **Chart.js** with gold palette, custom glass tooltips, smooth animations
- **Interactive article filtering** — click sector chart bars or use filter pills (sector, impact, search)
- **Dashboard pagination** — "Load More" button fetches additional 20 articles via cursor, dedup by URL
- **Full-text article search** — search bar queries Supabase by title, summary, source, category, and stocks, with Cmd+K shortcut
- **Auto-refresh** every 60 seconds

### 🗄️ Database (Supabase)
- **11 tables**: `digest_runs`, `articles`, `sector_activity`, `stock_mentions`, `pipeline_health`, `capex_tracking`, `ai_usage`, `daily_metrics`, `stock_prices`, `user_preferences`, `user_delivery_log`
- All pipeline data written automatically after each digest run
- Dashboard reads directly from Supabase REST API
- User preferences stored per Telegram chat ID (watchlist, alert settings, categories, delivery time)

### 📈 Structured Logging & Metrics
- **Per-day NDJSON logs** — `logs/2025-06-23.ndjson` both written to disk and streamed to stdout
- **Event types**: `feed_fetch`, `ai_batch`, `stock_fetch`, `digest_delivery`, `error`
- **Daily summary aggregation** — `summarizeRun()` reads all events for a date and produces a `RunSummary`
- **Supabase persistence** — key metrics also upserted to `daily_metrics` table at pipeline end

### 🔔 Error Handling & Alerts
- **Source health alerts** — if >20% of RSS feeds fail, Telegram admin is notified with failing feed names
- **Conditional RSS fetching** — consistently failing feeds (2+ consecutive failures) are automatically skipped
- **High-impact alert system** — articles scoring 8+/10 trigger instant Telegram notifications to opted-in users
- **Enhanced error alerts with recovery actions** — AI 429 rate limits, Yahoo Finance failures, Supabase connection errors all emit structured `ErrorEvent` metrics with human-readable recovery suggestions
- **Error event metric** — emitted for every failure with source, severity, status code, and recovery action
- **Supabase error recording** — failed pipeline runs logged to Supabase with error details
- **GitHub Actions integration** — workflow secrets for `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`

### 🌐 Production Webhook Support
- `setupWebhook()` — stops polling, deletes old webhook, sets new one with optional secret token
- `switchToPolling()` — deletes webhook, resumes polling (for local dev)
- `startWebhookBot()` — registers commands + sets webhook in one call
- **`WEBHOOK_SETUP.md`** — deployment guides for Vercel, Cloudflare Workers, Railway/Render/Fly.io

### 📱 Trending Now
- **Daily trending computation** — top tickers and sectors by mention count, average impact score, and dominant sentiment
- **Stored in `daily_metrics`** — JSON-serialized `TrendingItem[]` with top 3 articles per entity
- **`/trending` command** — views last 7 days of trending data with sentiment emojis

### 🧪 Testing
- **58 unit tests** with **Vitest** covering:
  - Deduplication (5 tests)
  - Keyword matching (13 tests)
  - Stock price fetching (8 tests)
  - Telegram formatter (5 tests)
  - Supabase integration (15 tests)
  - Telegram integration (9 tests)
  - Stocks integration (8 tests)
- **TypeScript strict mode** — entire project compiles cleanly

## Architecture

```
RSS Feeds (57 sources, conditional GET with ETag cache)
      │
      ▼
Step 1: News Collector (rss-parser + keyword filter + retry backoff)
      │
      ▼
Step 1b: Dedup (URL match + Jaccard similarity)
      │
      ▼
Step 2: AI Processor (dynamic batch sizing + synthesis)
      │
      ▼
Step 2b: Yahoo Finance (stock prices for mentioned tickers)
      │
      ▼
Step 3: Telegram Formatter (HTML, categorized, with price data)
      │
      ▼
Step 4: Telegram Bot (send + interactive commands + webhook support)
      │
      ▼
Step 5: Supabase (11 tables + per-user delivery logging)
      │
      ├── Dashboard (premium HTML/JS — reads from Supabase)
      └── NDJSON logs (per-day files + stdout streaming)
```

## Quick Start

### Prerequisites

- **Node.js 18+**
- **Telegram Bot Token** — message [@BotFather](https://t.me/BotFather)
- **AI API Key** — [Groq](https://console.groq.com) (free) / [OpenAI](https://platform.openai.com) / [OpenRouter](https://openrouter.ai)
- **Supabase account** (optional, for dashboard) — [supabase.com](https://supabase.com)

### Setup

```bash
cd ai-infra-digest

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your API keys
nano .env
```

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Your Telegram chat/user ID |
| `AI_API_KEY` | ✅ | — | API key for your AI provider |
| `AI_PROVIDER` | ❌ | `groq` | `groq`, `openai`, `openrouter`, `custom` |
| `AI_MODEL` | ❌ | `llama-3.3-70b-versatile` | Model name |
| `SUPABASE_URL` | ❌ | — | Supabase project URL (for dashboard) |
| `SUPABASE_SERVICE_KEY` | ❌ | — | Supabase service role key (for dashboard) |

### Get Your Telegram Chat ID

1. Message your bot on Telegram
2. Run: `curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find the `chat.id` value and add it to `.env`

### Test Locally

```bash
# Run the pipeline once
npm run dev

# Or run the scheduler to check user delivery times
npm run scheduler
```

### Run Tests

```bash
npm test              # Run all 58 tests
npm run test:watch    # Watch mode for development
```

## GitHub Actions (Production)

### Daily Digest (Default)

The workflow in `.github/workflows/daily-digest.yml` runs at **8:00 AM MYT** (midnight UTC).

### Scheduled Delivery (Per-User)

The workflow in `.github/workflows/scheduled-delivery.yml` runs **every 30 minutes**, queries all active users, and delivers the digest to users whose `preferred_time` + `timezone` matches the current time.

### Required Secrets

| Secret | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Your bot token |
| `TELEGRAM_CHAT_ID` | Your chat ID |
| `AI_API_KEY` | Groq/OpenAI API key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |

### Optional Variables

| Variable | Default |
|---|---|
| `AI_PROVIDER` | `groq` |
| `AI_MODEL` | `llama-3.3-70b-versatile` |

## Dashboard

Start the dashboard server locally:

```bash
node dashboard/server.js
# Visit http://localhost:8080
```

The dashboard reads from your Supabase database — configure credentials via the gear icon ⚙️ in the top-right corner (they save to localStorage).

## Project Structure

```
ai-infra-digest/
├── .env.example                          # Environment template
├── .github/workflows/
│   ├── daily-digest.yml                  # 8 AM MYT cron (default delivery)
│   └── scheduled-delivery.yml            # Every 30 min (per-user delivery)
├── WEBHOOK_SETUP.md                      # Production webhook deployment guide
├── dashboard/
│   ├── index.html                        # Premium dashboard (gold fintech, sidebar nav, 6 charts)
│   └── server.js                         # Static file server
├── scripts/
│   ├── test-digest.ts                    # Manual pipeline test
│   └── migration-v2.sql                  # Supabase migration for alert system columns
├── src/
│   ├── index.ts                          # Main orchestrator, pipeline runner, command handlers
│   ├── scheduler.ts                      # Cron-friendly per-user delivery scheduler
│   ├── config.ts                         # Environment config loader
│   ├── collector/
│   │   └── rss.ts                        # 57 RSS feeds + conditional GET caching + retry backoff
│   ├── formatter/
│   │   └── telegram.ts                   # HTML Telegram message formatter
│   ├── processor/
│   │   └── ai.ts                         # AI batch processing + dynamic batch sizing + backoff
│   ├── sender/
│   │   └── telegram.ts                   # Bot API (polling + webhook, interactive commands, inline keyboards)
│   └── utils/
│       ├── dedup.ts                      # URL + Jaccard similarity deduplication
│       ├── helpers.ts                    # Shared utilities (sleep)
│       ├── logger.ts                     # Structured timestamped logger
│       ├── metrics.ts                    # NDJSON structured logging (5 event types + summary)
│       ├── stocks.ts                     # Yahoo Finance price fetcher
│       └── supabase.ts                   # Supabase REST CRUD (11 tables + delivery log)
├── supabase-schema.sql                   # Full database schema (11 tables + RLS)
├── vitest.config.ts                      # Vitest configuration
├── package.json
├── tsconfig.json
└── README.md
```

## News Sources

### Tier 1 — Company & Financial News (37 feeds)
NVIDIA, AMD, Broadcom, Microsoft, Amazon, Google, Meta, TSMC, Intel, Qualcomm, Oracle, IBM, Micron, ASML, Super Micro, Dell, ARM, Arista, Cisco, Marvell, Applied Materials, Lam Research, KLA, Tokyo Electron, Digital Realty, Equinix, Constellation Energy, Vistra, GE Vernova, Siemens Energy, Vertiv, Schneider Electric, Eaton, Anthropic, xAI, Mistral AI, Cohere + MarketWatch, Yahoo Finance, CNBC, Reuters, Bloomberg Tech, FT Tech, Barron's, WSJ Markets, IBD, SEC Filings

### Tier 2 — Industry News (20 feeds)
Tom's Hardware, AnandTech, Ars Technica, TechCrunch, The Verge, Seeking Alpha, SemiAnalysis, The Register, Datacenter Dynamics, Semiconductor Engineering, Google AI Blog, OpenAI, AWS AI, VentureBeat AI, AI News, Medium AI, AI Business, ZDNet AI

## Cost Estimate

| Service | Cost |
|---|---|
| GitHub Actions | Free (2000 min/month) |
| Groq API (Llama 3.3 70B) | ~$0.15/1M tokens — ~$0.01/day |
| OpenAI (fallback) | ~$0.50–2/month |
| Supabase | Free tier (500 MB, 50k rows) |
| Telegram Bot API | Free |
| Yahoo Finance | Free |
| **Total** | **<$2/month** |

## Roadmap

### Phase I · Foundation. ✅ Shipped
- **v1** — Core pipeline: RSS → AI → Telegram → GitHub Actions cron. 57 feeds, 10 sectors, keyword filtering, conditional GET caching
- **v1.1** — Supabase metrics, stock prices (Yahoo Finance), premium dashboard, URL + Jaccard dedup
- **v1.2** — Token tracking, 58 unit tests (Vitest), dashboard upgrades with shimmer loading animations
- **v1.3** — Interactive Telegram commands, user management, health alerts, exponential backoff, Jaccard dedup v2
- **v2.0** — Watchlist filtering, alert system (on/off/threshold), dashboard search + pagination, conditional RSS fetching
- **v2.1** — NDJSON structured logging, enhanced error alerts with recovery actions, production webhook support
- **v2.2** — Feedback with inline keyboard, trending (7-day rolling), per-user scheduled delivery, idempotent delivery log

### Phase II · Intelligence. 🔨 Building
- **v3** — SEC filing deep analysis — parse 8-K, 10-K, 10-Q filings for 35 companies. Extract Capex, AI Revenue, Margins, Inventory, forward guidance
- **v3** — Earnings transcript parsing — download and analyze calls. Extract Capex guidance, AI revenue mentions, management tone signals

### Phase III · Interaction. 📈 Planned
- Telegram bot enhancement — /digest, /trending, /watchlist, /alert, /sec, /feedback
- Watchlist filtering & price threshold alert system
- Premium live dashboard — 6 charts, search, pagination, gold fintech aesthetic
- Per-user scheduled delivery with timezone-aware cron

### Phase IV · Research. 🔭 Future
- **v4** — Article archival & historical trend analysis across sectors and tickers. Price threshold alerts
- **v5** — Bull/bear thesis generation per ticker, competitive landscape analysis, personal portfolio tracking with P&L

## Disclaimer

**Not financial advice.** This is an informational tool for the AI infrastructure community — always do your own research before making investment decisions.

---

Built with ❤️ — Powered by Llama 3.3 via Groq.
