# 🚀 AI Infrastructure Daily Digest

A Telegram bot that delivers a daily AI infrastructure news digest at **8:00 AM Malaysia Time**, covering:

- Major stock market news (NVIDIA, AMD, Broadcom, etc.)
- AI infrastructure and datacenter developments
- GPU and semiconductor industry news
- Cloud provider expansions (Microsoft, Amazon, Google)
- Earnings announcements & analyst ratings
- Key stock movers

## Architecture

```
News Sources (RSS Feeds)
      │
      ▼
News Collector (rss-parser)
      │
      ▼
AI Processor (Groq / OpenAI / Gemini / Claude)
      │
      ▼
Telegram Formatter
      │
      ▼
Telegram Bot
```

## Quick Start

### Prerequisites

1. **Node.js 18+** installed
2. **Telegram Bot Token** — message [@BotFather](https://t.me/BotFather) on Telegram to create a bot
3. **AI API Key** — sign up for one of:
   - **Groq** (free, recommended): [console.groq.com](https://console.groq.com) — Get a free API key
   - **OpenAI** (paid): [platform.openai.com](https://platform.openai.com)
   - **Google Gemini** (free tier): [aistudio.google.com](https://aistudio.google.com)

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

### Get Your Telegram Chat ID

1. Message your bot on Telegram
2. Run: `curl https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find the `chat.id` value and add it to your `.env`

### Test Run

```bash
npm run test-digest
```

## Running Automatically at 8 AM MYT

### Option A: GitHub Actions (Recommended — Free)

1. Push this repo to GitHub
2. Go to **Settings → Secrets and variables → Actions**
3. Add these repository secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `AI_API_KEY`
4. (Optional) Add repository variables:
   - `AI_PROVIDER` (default: `groq`)
   - `AI_MODEL` (default: `llama-3.3-70b-versatile`)

The workflow in `.github/workflows/daily-digest.yml` runs automatically at 8 AM MYT.

### Option B: Cron Job

```bash
# Run daily at 8 AM Malaysia time
0 8 * * * cd /path/to/ai-infra-digest && /usr/bin/node dist/index.js
```

### Option C: n8n / Self-hosted

Use the provided script `npm run start` in any scheduler (n8n, cron, etc.).

## Project Structure

```
ai-infra-digest/
├── .env.example              # Environment variables template
├── .github/workflows/        # GitHub Actions (8 AM MYT cron)
├── src/
│   ├── index.ts              # Main orchestrator
│   ├── config.ts             # Configuration loader
│   ├── collector/rss.ts      # RSS feed news collector
│   ├── processor/ai.ts       # AI summarization (multi-provider)
│   ├── formatter/telegram.ts # Telegram message formatting
│   ├── sender/telegram.ts    # Telegram bot API sender
│   └── utils/logger.ts       # Logger utility
├── scripts/
│   └── test-digest.ts        # Manual test runner
├── package.json
├── tsconfig.json
└── README.md
```

## News Sources

### Tier 1 — Company & Financial News
- NVIDIA, Microsoft, AMD official news
- MarketWatch, Yahoo Finance, CNBC, Reuters
- SEC Filings (8-K)

### Tier 2 — AI Infrastructure & Semiconductors
- Tom's Hardware, AnandTech, Ars Technica
- TechCrunch, The Verge
- Google AI Blog, OpenAI Blog, AWS AI
- VentureBeat AI, Seeking Alpha

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | ✅ | — | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | ✅ | — | Your Telegram chat/user ID |
| `AI_API_KEY` | ✅ | — | API key for your AI provider |
| `AI_PROVIDER` | ❌ | `groq` | `groq`, `openai`, `google`, `openrouter`, `custom` |
| `AI_MODEL` | ❌ | `llama-3.3-70b-versatile` | Model name for your AI provider |

## Roadmap

- [x] **v1** — MVP: RSS feeds + AI summary + Telegram delivery + GitHub Actions
- [ ] **v2** — Deduplication, ranking, sentiment tracking
- [ ] **v3** — SEC filing analysis, earnings transcripts
- [ ] **v4** — Bull/bear theses, competitive analysis
- [ ] **v5** — Portfolio tracking, trade recommendations

## Cost Estimate

| Service | Cost |
|---|---|
| GitHub Actions | Free (2000 min/month) |
| Groq API | Free (~30 articles/day ≈ $0) |
| OpenAI (paid fallback) | ~$0.50–2/month (gpt-4o-mini) |
| Telegram Bot API | Free |
| **Total** | **<$2/month** |

## Disclaimer

This is an informational tool only. **Not financial advice.** Always do your own research before making investment decisions.

---

Built with ❤️ for the AI infrastructure community.
