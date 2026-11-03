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
- **Website**: deployed to Vercel at **https://goldirham-stack.vercel.app** — landing page, `/briefing/`, and `/dashboard/` are live. Merging to `main` does not update the site. Deploy with the CLI from a clean copy of `website/` that has a `.vercel/project.json` link: `vercel deploy --prod --skip-domain`, verify, then `vercel promote`. In Git Bash, set `MSYS_NO_PATHCONV=1` for `vercel curl`. In PowerShell, use `npx.cmd`. The local Windows `vercel build` failed with `spawn cmd.exe ENOENT`.
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
- **Daily digest cron**: `daily-digest.yml` is active and publishes only. pg_cron dispatches it at 22:17 UTC (06:17 MYT), and it started on time on 2026-11-02. Its own cron is a backstop that GitHub started 1.8 to 3.7 hours late from 2026-10-14 to 2026-11-02. A late run reuses the edition.
- **Workflow dispatch**: migration `20261102140000` has pg_cron dispatch the delivery and digest workflows through pg_net, using a fine-grained token with Actions read and write on this repo. The token is in the Vault secret `github_actions_dispatch_token`, and dispatches have returned 204 since 2026-11-02 14:50 UTC. To replace it, use `vault.update_secret` in the Supabase SQL editor, and check the first argument is the token. Never put the token in a migration. The `delivery_late` quality alert fires if dispatch stops working.
- **Per-user scheduled delivery**: `scheduled-delivery.yml` active. Its own cron asks for every 10 min, but GitHub ran it about every 4.4 hours (median gap, 2026-10-18 to 2026-11-02), so that cron is only a backstop. It fans out the current canonical editorial edition; each user's local date remains the idempotent delivery slot.
- **gh CLI**: authenticated as `ixtaqq` as of 2026-09-24; `repo` and `workflow` access were verified.
- **Website**: deployed to Vercel at **https://goldirham-stack.vercel.app** — landing page, `/briefing/`, and `/dashboard/` are live. The 2026-09-24 release uses production deployment `dpl_22o2Xxmd75k4tYz9fFzKRx5EnsbB`. Prefer the CLI from the linked website directory; use `--skip-domain` to verify a deployment before `vercel promote`. The local Windows `vercel build` failed with `spawn cmd.exe ENOENT`; a hosted build from a clean staging copy succeeded.
- **Email delivery**: the 2026-11-03 delivery logged a successful email copy. A historical run rejected `SMTP_PASS` with Gmail `535-5.7.8`. Slack/email failures remain non-fatal.
- **Production migrations**: all 40 canonical versions through `20261102150000` are applied. Supabase's GitHub integration applies migrations automatically on merge to `main`; stop affected workers before merging migration-bearing releases, not only before a CLI push. Render also deploys `main` automatically.
- **Disabled stages**: embeddings and earnings are off because their keys are not configured. Dedup falls back to Jaccard. The first SEC extracts appeared in the 2026-11-03 edition (4 extracts; the 64 earlier editions have none).
- **RSS feeds**: on 2026-11-03, Yahoo Finance's URL returned 404, VentureBeat returned 429, and AI News returned 202 with no feed, so their URLs were replaced. The Register recovered. A skipped feed runs again once its failures leave the latest 200 `pipeline_health` rows, so a dead URL shows up as a repeating fail, fail, skip pattern.

## Conventions / gotchas

- **Scheduler outcomes**: a run fails only for a real failure. A missing edition counts as waiting until 12:00 in the editorial timezone, then as failed. A slot another run owns or that awaits reconciliation counts as held and does not fail later runs. The `deliveries_held` quality alert and `npm run operations -- status` report held slots.
- **Quality alerts**: `src/pipeline/quality.ts` adds a rule table entry per check. Issues go to Slack and `digest_runs.degraded_stages` and never block publication.
- **Stuck editorial claim**: inspect the publication and AI ledger, then run `npm run operations -- release-editorial YYYY-MM-DD "evidence and reason"`. The database refuses claims under an hour old.
- **AI tickers**: `AI_TICKER_CORRECTIONS` in `src/utils/tickers.ts` fixes tickers the model invents. Add an entry when Yahoo logs a 404 for a real company. User watchlists do not use this table.
- **Live API checks**: `npm run verify:live-contracts` reads Yahoo and EDGAR only and runs weekly. Add a check there when a mock stands in for a new external API.

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

## Shared agent workflow

Read `E:\workspace\agent-homebase\PROJECT-WORKFLOW.md` for the shared workflow.
Use the globally available skills that match the task and the project checks above.
