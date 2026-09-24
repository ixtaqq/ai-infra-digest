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
- **Tests**: Vitest — offline unit tests; integration-labelled mocked suites run under `npm test`
- **CI**: GitHub Actions — `ci.yml` (lint + unit tests), `codeql.yml` (security scan)
- **Cron**: GitHub Actions — daily digest, per-user scheduled delivery (every 10 min), weekly thesis snapshots, weekly data retention
- **Website**: static HTML (`website/index.html` landing page, `website/dashboard/index.html` dashboard) — vanilla JS, Chart.js, no build step, no framework
- **Website hosting**: Vercel (project `goldirham-stack`, team `aizattaqq-s-projects`)

## How to run

```bash
npm install
cp .env.example .env        # fill in real values — .env.example must stay placeholders-only
npm run dev                 # run pipeline once (polling mode) — real Telegram send + AI spend
npm run scheduler           # per-user delivery check
npm run webhook             # webhook server (tsx, local dev)
npm run test:unit           # Unit tests, offline, no credentials needed
npm test                    # all tests, incl. mocked integration boundaries (no credentials needed)
npm run lint                # tsc --noEmit (main) + tsc -p tsconfig.scripts.json (scripts)
```

Required env vars minimum: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AI_API_KEY`. Full list in `.env.example`.

`npx tsc` doesn't resolve on this machine via bare `npx` sometimes — if it fails with "not the tsc command you are looking for", run `npm install` first (typescript wasn't fully installed), then retry.

Website preview locally: `.claude/launch.json` has a `website` config (`npx serve website -l 4321`) for use with the browser preview tool.

## What's set up so far

- **Local credentials**: this checkout has no `.env` as of 2026-09-23. Do not assume the historical local credentials are available. The website build needs `SUPABASE_URL` and `SUPABASE_ANON_KEY` or `SUPABASE_PUBLISHABLE_KEY`. Generated dashboard/config.js is untracked; never use a service-role key.
- **GitHub repo**: `ixtaqq/ai-infra-digest`, all required Actions secrets configured (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `AI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, plus `SLACK_WEBHOOK_URL`, `SMTP_USER`, `SMTP_PASS`, `DIGEST_EMAIL_TO`, `WEBHOOK_SECRET`, `WEBHOOK_URL`).
- **Daily digest cron**: `daily-digest.yml` is active (8 AM MYT / midnight UTC). The user updated the GitHub and Render bot tokens on 2026-09-24; Render successfully registered the Telegram webhook. A fresh scheduled delivery with the new GitHub secret remains to be observed.
- **Per-user scheduled delivery**: `scheduled-delivery.yml` active, runs every 10 min and fans out the current canonical editorial edition; each user's local date remains the idempotent delivery slot.
- **gh CLI**: authenticated as `ixtaqq` as of 2026-09-24; `repo` and `workflow` access were verified.
- **Website**: deployed to Vercel at **https://goldirham-stack.vercel.app** — landing page, `/briefing/`, and `/dashboard/` are live. The 2026-09-24 release uses production deployment `dpl_22o2Xxmd75k4tYz9fFzKRx5EnsbB`. Prefer the CLI from the linked website directory; use `--skip-domain` to verify a deployment before `vercel promote`. The local Windows `vercel build` failed with `spawn cmd.exe ENOENT`; a hosted build from a clean staging copy succeeded.
- **Email delivery**: a historical run rejected `SMTP_PASS` with Gmail `535-5.7.8`. Current SMTP health is unverified; Slack/email failures remain non-fatal.
- **Production migrations**: all 36 canonical versions through `20260923094449` are applied. Supabase's GitHub integration applies migrations automatically on merge to `main`; stop affected workers before merging migration-bearing releases, not only before a CLI push. Render also deploys `main` automatically.
- **Embeddings (Phase VIII)**: degraded — `OPENAI_EMBEDDING_API_KEY` was returning HTTP 401 on last run, falls back to Jaccard dedup automatically.
- **Known broken RSS feed**: "The Register" — feed XML has a malformed attribute on their end, fails after 3 retries (non-fatal, other 67 feeds unaffected).

## Conventions / gotchas

- **Never put real secrets in `.env.example`** — it's tracked in git and public. Only `.env` (gitignored) holds real values. If `.env.example` ever shows a diff with real-looking tokens, do not commit — revert with `git checkout -- .env.example` and re-verify `.env` has the value instead.
- **Supabase dashboard auth gate** wants the **anon/public** key, never the service role key — the service key has full write access bypassing RLS and must never ship client-side.
- **`website/vercel.json`** defines routing (`/`, `/dashboard`, `/dashboard/*`) — required for the dashboard route to resolve on Vercel.
- Running `npm run dev` locally has real side effects: sends an actual Telegram message, spends AI API credits, writes to Supabase. Confirm with the user before running it, per the project's general caution around side-effectful actions.

## Roadmap implementation handoff

- Read `docs/roadmap-implementation.md` for implementation status, unresolved verification, and migration rollout order.
- `/digest` and `/last` retrieve publications, not new AI generations. Personal command handlers are private-chat-only.
- Pending or ambiguous external sends are never automatically replayed. Reconciliation requires evidence, not just elapsed time.
- Canonical SQL lives in `supabase/migrations/`; historical schema snapshots are reference material.
- Dashboard scripts live in `website/dashboard/desk.js`, `data.js`, and `motion.js`; avoid inline event handlers. The reader is `website/briefing/`.
- Do not seed invented provider prices or pretend synthetic examples constitute a human-reviewed editorial benchmark.
