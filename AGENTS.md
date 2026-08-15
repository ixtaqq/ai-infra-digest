# AGENTS.md — ai-infra-digest (Goldirham Stack)

Conventions and setup state for this repo. Read before making changes.

## Tech stack

- **Language**: TypeScript (strict mode, `tsc --noEmit` must pass clean)
- **Runtime**: Node.js 22
- **Dev runner**: `tsx` (no build step needed for local dev)
- **Bot**: `node-telegram-bot-api` — polling mode locally, webhook mode in production
- **AI**: Groq (default, free tier) / OpenAI / OpenRouter / custom — two-tier routing (fast model for classification, strong model for synthesis)
- **RSS**: `rss-parser`, 68 feeds, conditional GET + ETag caching
- **Email**: `nodemailer` via Gmail SMTP (requires App Password, not account password)
- **DB**: Supabase (Postgres + pgvector), managed via **Supabase CLI**, migrations in `supabase/migrations/`
- **Validation**: `zod` — all AI JSON responses parsed through zod schemas (coerces type-confused fields)
- **Tests**: Vitest — 336 unit tests offline; integration-labelled mocked suites run under `npm test`
- **CI**: GitHub Actions — `ci.yml` (lint + unit tests), `codeql.yml` (security scan)
- **Cron**: GitHub Actions — daily digest, per-user scheduled delivery (every 30 min), weekly thesis snapshots, weekly data retention
- **Website**: static HTML (`website/index.html` landing page, `website/dashboard/index.html` dashboard) — vanilla JS, Chart.js, no build step, no framework
- **Website hosting**: Vercel (project `goldirham-stack`, team `aizattaqq-s-projects`)

## How to run

```bash
npm install
cp .env.example .env        # fill in real values — .env.example must stay placeholders-only
npm run dev                 # run pipeline once (polling mode) — real Telegram send + AI spend
npm run scheduler           # per-user delivery check
npm run webhook             # webhook server (tsx, local dev)
npm run test:unit           # 336 unit tests, offline, no credentials needed
npm test                    # all tests, incl. integration (needs live credentials)
npm run lint                # tsc --noEmit (main) + tsc -p tsconfig.scripts.json (scripts)
```

Required env vars minimum: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AI_API_KEY`. Full list in `.env.example`.

`npx tsc` doesn't resolve on this machine via bare `npx` sometimes — if it fails with "not the tsc command you are looking for", run `npm install` first (typescript wasn't fully installed), then retry.

Website preview locally: `.claude/launch.json` has a `website` config (`npx serve website -l 4321`) for use with the browser preview tool.

## What's set up so far

- **Local `.env`**: filled with real Telegram bot token, Groq AI key, Supabase URL + service key. `SUPABASE_ANON_KEY` is NOT in `.env` (only service key) — dashboard auth gate needs the anon/public key separately, entered client-side in browser localStorage, never committed.
- **GitHub repo**: `ixtaqq/ai-infra-digest`, all required Actions secrets configured (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, plus `SLACK_WEBHOOK_URL`, `SMTP_USER`, `SMTP_PASS`, `DIGEST_EMAIL_TO`, `WEBHOOK_SECRET`, `WEBHOOK_URL`).
- **Daily digest cron**: `daily-digest.yml` active, running successfully daily (8 AM MYT / midnight UTC).
- **Per-user scheduled delivery**: `scheduled-delivery.yml` active, runs every 30 min.
- **gh CLI**: installed (via winget) and authenticated as `ixtaqq`.
- **Website**: deployed to Vercel at **https://goldirham-stack.vercel.app** — landing page + `/dashboard/` route both live. Deployed via `npx vercel deploy --prod` from `website/`, project linked with `vercel link --project goldirham-stack --scope aizattaqq-s-projects`. Prefer the CLI over the Vercel MCP tool for deploys — the MCP `deploy_to_vercel` tool requires inlining full file contents through the LLM context (expensive, error-prone for multi-file sites); the CLI reads straight from disk.
- **Email delivery**: currently broken — `SMTP_PASS` in `.env`/GitHub secrets is not a valid Gmail App Password (535-5.7.8 auth error). Telegram delivery unaffected (Slack/email failures are non-fatal).
- **Embeddings (Phase VIII)**: degraded — `OPENAI_EMBEDDING_API_KEY` was returning HTTP 401 on last run, falls back to Jaccard dedup automatically.
- **Known broken RSS feed**: "The Register" — feed XML has a malformed attribute on their end, fails after 3 retries (non-fatal, other 67 feeds unaffected).

## Conventions / gotchas

- **Never put real secrets in `.env.example`** — it's tracked in git and public. Only `.env` (gitignored) holds real values. If `.env.example` ever shows a diff with real-looking tokens, do not commit — revert with `git checkout -- .env.example` and re-verify `.env` has the value instead.
- **Supabase dashboard auth gate** wants the **anon/public** key, never the service role key — the service key has full write access bypassing RLS and must never ship client-side.
- **`website/vercel.json`** defines routing (`/`, `/dashboard`, `/dashboard/*`) — required for the dashboard route to resolve on Vercel.
- Running `npm run dev` locally has real side effects: sends an actual Telegram message, spends AI API credits, writes to Supabase. Confirm with the user before running it, per the project's general caution around side-effectful actions.
