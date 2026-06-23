# 🚀 AI Infra Digest

**Daily AI infrastructure intelligence** — A pipeline that collects 57+ RSS feeds, analyzes news with AI, and delivers a curated morning digest via Telegram at **8:00 AM Malaysia Time**.

Covers the **full AI infrastructure value chain**: power generation → cooling → networking → chips → AI models.

## Features

### 📡 News Pipeline
- **57 RSS feeds** across 2 tiers (company news + industry analysis)
- **Smart deduplication** — URL matching + **Jaccard similarity** (catches near-identical headlines from different sources)
- **10-sector classification**: Chips & GPUs, Cloud & Hyperscalers, Datacenters, Networking, Semiconductor Manufacturing, Power & Utilities, Cooling Infrastructure, AI Models & Labs, M&A, Earnings
- **Keyword filtering** — 200+ AI/semiconductor keywords

### 🤖 AI Processing
- **Multi-provider**: Groq (default), OpenAI, OpenRouter, or custom endpoints
- **Batch processing** (10 articles/batch) with **exponential backoff** (full-jitter retry, up to 3 attempts)
- **Synthesis pass** — generates market outlook, top stocks, and daily summary
- **Token tracking** — actual `prompt_tokens`, `completion_tokens`, `total_tokens` recorded per run

### 💰 Stock Prices
- **Yahoo Finance** integration — daily price snapshots for 30+ tracked tickers
- Automatically fetches prices for every mentioned stock after AI analysis
- Stored in Supabase for historical trend charts

### 📱 Interactive Telegram Bot
- **`/start`** — Welcome & register your preferences
- **`/digest`** — Request the latest digest
- **`/sources`** — List all 57 tracked RSS feeds with health status
- **`/last`** — Show the most recent digest summary from Supabase
- **`/settings`** — View your user preferences
- **`/watchlist NVDA,AMD,AVGO`** — Set your ticker watchlist
- **`/help`** — Show available commands

### 📊 Premium Dashboard
- **6 interactive charts**: Stock price history, sector trend, digest performance, token usage, sector bar, stock movers
- **Glassmorphism design** with gradient accents, shimmer loading skeletons, staggered entrance animations
- **Dark/light theme** toggle
- **Interactive article filtering** — click sector chart bars or use filter pills (sector, impact, search)
- **Auto-refresh** every 60 seconds
- **Chart.js** with rounded bar corners, gradient fills, custom tooltips

### 🗄️ Database (Supabase)
- **9 tables**: `digest_runs`, `articles`, `sector_activity`, `stock_mentions`, `pipeline_health`, `capex_tracking`, `ai_usage`, `daily_metrics`, `stock_prices`, `user_preferences`
- All pipeline data written automatically after each digest run
- Dashboard reads directly from Supabase REST API
- User preferences stored per Telegram chat ID

### 🔔 Health Monitoring
- **Source health alerts** — if >20% of RSS feeds fail, Telegram admin is notified with failing feed names
- **Error recording** — failed pipeline runs logged to Supabase with error details
- **GitHub Actions integration** — workflow secrets for `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`

### 🧪 Testing
- **26 unit tests** with **Vitest** covering:
  - Deduplication (5 tests — first run, URL dedup, Jaccard similarity, retention expiry)
  - Keyword matching (13 tests — tickers, sectors, case-insensitive, negative cases)
  - Stock price fetching (3 tests — empty, capped, response shape)
  - Telegram formatter (5 tests — header, articles, stock prices, value chain, empty state)
- **TypeScript strict mode** — entire project compiles cleanly

## Architecture

```
RSS Feeds (57 sources)
      │
      ▼
Step 1: News Collector (rss-parser + keyword filter)
      │
      ▼
Step 1b: Dedup (URL match + Jaccard similarity)
      │
      ▼
Step 2: AI Processor (batched analysis + synthesis)
      │
      ▼
Step 2b: Yahoo Finance (stock prices for mentioned tickers)
      │
      ▼
Step 3: Telegram Formatter (HTML, categorized, with price data)
      │
      ▼
Step 4: Telegram Bot (send + interactive commands)
      │
      ▼
Step 5: Supabase (9 tables — metrics, articles, users)
      │
      ▼
Dashboard (premium HTML/JS — reads from Supabase)
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

# Or the test script
npm run test-digest
```

### Run Tests

```bash
npm test              # Run all 26 tests
npm run test:watch    # Watch mode for development
```

## GitHub Actions (Production)

The workflow in `.github/workflows/daily-digest.yml` runs at **8:00 AM MYT** (midnight UTC).

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
├── .env.example                    # Environment template
├── .github/workflows/daily-digest.yml
├── dashboard/
│   ├── index.html                  # Premium dashboard (glassmorphism, 6 charts, filtering)
│   └── server.js                   # Static file server
├── scripts/
│   └── test-digest.ts             # Manual pipeline test
├── src/
│   ├── index.ts                   # Main orchestrator & command handler registration
│   ├── config.ts                  # Environment config loader
│   ├── collector/
│   │   └── rss.ts                 # 57 RSS feeds + keyword filter + matchesKeywords()
│   ├── formatter/
│   │   └── telegram.ts            # HTML Telegram message formatter
│   ├── processor/
│   │   └── ai.ts                  # AI batch processing + exponential backoff
│   ├── sender/
│   │   └── telegram.ts            # Bot API (polling mode, interactive commands)
│   └── utils/
│       ├── dedup.ts               # URL + Jaccard similarity deduplication
│       ├── logger.ts              # Structured timestamped logger
│       ├── stocks.ts              # Yahoo Finance price fetcher
│       └── supabase.ts           # Supabase REST CRUD (all tables + users)
├── supabase-schema.sql           # Full database schema (10 tables + RLS)
├── vitest.config.ts              # Vitest configuration
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

- [x] **v1** — Core pipeline: RSS → AI → Telegram → GitHub Actions cron
- [x] **v1.1** — Supabase metrics, stock prices, dashboard, dedup
- [x] **v1.2** — Token tracking, unit tests (26 tests), premium dashboard
- [x] **v1.3** — Interactive Telegram commands, user management, health alerts, exponential backoff, Jaccard dedup
- [ ] **v2** — SEC filing deep analysis, earnings transcript parsing
- [ ] **v3** — Article search/archive (dashboard), alert system (price thresholds, breaking news)
- [ ] **v4** — Bull/bear theses, competitive landscape analysis
- [ ] **v5** — Portfolio tracking with P&L simulation, trade recommendations

## Disclaimer

**Not financial advice.** This is an informational tool for the AI infrastructure community — always do your own research before making investment decisions.

---

Built with ❤️ — Powered by Llama 3.3 via Groq.
