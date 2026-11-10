# Goldirham Stack review and roadmap

Reviewed on November 10, 2026, against `main` at `f24be08`. Fixes are on the branch `fix/review-2026-11-10` (11 commits). Nothing in this review was pushed, merged, deployed or sent.

This review follows [the October 6 review](project-review-2026-10-06.md) and [`AUDIT.md`](../AUDIT.md). It rechecks their open items and adds new findings. Closed findings are not repeated.

## 1. Architecture summary

1. Goldirham Stack is a daily AI-infrastructure briefing delivered to Telegram, with Slack and email copies, a public reader at `/briefing/` and a research dashboard at `/dashboard/`.
2. Node 22 and strict TypeScript run three entry points: `src/index.ts` (editorial run), `src/scheduler.ts` (per-user delivery) and `src/webhook.ts` (bot commands).
3. pg_cron dispatches the daily digest at 22:17 UTC. It collects 68 RSS feeds and SEC filings, deduplicates, classifies with a fast model, synthesizes with a strong model, ranks, and publishes one canonical edition to Supabase.
4. pg_cron also dispatches the scheduler every 10 minutes. It reads the published edition, never generates, and claims each user's local-date slot in the database before sending.
5. The webhook on Render checks the Telegram secret, stores each update in `telegram_inbox`, and a 1-second worker handles commands. Uncertain sends are never replayed automatically.
6. The static website on Vercel reads public projections with the publishable key. Deploys are manual; merging does not update the site.
7. CI runs lint, 71 Vitest files, browser checks, `npm audit`, Semgrep, a container check, CodeQL and local Supabase migration tests.

### Checks

| Check | `main` | This branch |
| --- | --- | --- |
| `npm test` (with build) | 633 passed, 0 failed, 0 skipped, 71 files | 646 passed, 0 failed, 0 skipped, 71 files |
| `npm run test:unit` | 580 passed, 66 files | not rerun |
| `npm run lint` | pass | pass |
| `npm audit` | 0 vulnerabilities | unchanged |
| CodeQL and Dependabot alerts | 0 open | unchanged |
| Secret-scanning alerts | 1 open | unchanged (needs your action, F1) |

Tests ran on Node 26.12.1; the project targets 22.x. CI on the pushed branch is the Node 22 check. `test:unit` excludes the five integration files correctly on Windows, so that suspicion from the code sweep is dropped.

Production evidence, read-only:

- The last 200 Actions runs had one failure: a Scheduled Delivery run on 2026-11-09 at 18:10 UTC created no jobs, and the run 10 minutes later passed. A GitHub-side start failure is the likely cause (inferred).
- pg_cron started the daily digest at 22:17:01 UTC on every day from November 2 to 9.
- The November 10 delivery reached Telegram, Slack and email at 08:00:28 MYT.
- Supabase advisors report `pg_net` installed in `public` (warning), 7 tables with RLS and no policy (by design: service-role only), and 20 unused indexes.

Not verified: a query for delivery lateness, feed health since November 3 and SEC extracts since November 3 was blocked by the session's permission rules. Those checks from `TODOS.md` remain open.

## 2. Error and fix table

"Measured" means reproduced or read in code at `f24be08`. "Inferred" means the impact is reasoned, not reproduced. Every fixed row has a test that failed before the fix and passes after it, except where the row says otherwise.

| Severity | File | Problem and root cause | Fix | Status |
| --- | --- | --- | --- | --- |
| Critical | `.env.example:3` at commit `a1fb492` | A live Telegram bot token is in public git history. Secret-scanning alert #1 has been open since 2026-08-12. Anyone can send as the bot or move its webhook. (measured; owner confirmed the token is live) | Revoke in BotFather, set the new token in Render and the Actions secret, close the alert as revoked. History rewrite is not needed. | Open: owner action |
| Medium | `src/scheduler.ts:131`, `delivery/deliver.ts`, `sender/telegram.ts`, `pipeline/generate.ts` | Delivery runs printed each subscriber's Telegram first name, or chat ID, into public Actions logs. The November 10 run printed one name. (measured) | Log counts only; `npm run operations -- status` lists unresolved slots from the database. | Fixed, `531a7af` |
| Medium | `sender/telegram.ts:981,1011` | A planning error ("Unbalanced Telegram HTML") throws before anything is sent. Per-user sends recorded it as `ambiguous`, which `claim_user_delivery` never retries; the default-chat send let the throw escape and left its claim `pending`. (code measured, trigger inferred) | Plan the parts before the first network call; a planning failure is a definite failure. | Fixed, `1a4deb8` |
| Medium | `pipeline/generate.ts:441` | The high-impact alert stage ran outside `tryStage`, and `getAllActiveUsers` throws on a failed read, so one Supabase error dropped the day's edition after the AI spend. (code measured, impact inferred) | Run it as an optional stage and report the failure. | Fixed, `9e6d74d` |
| Medium | `pipeline/generate.ts:522,678` | The generation-failure and feed-health alerts put raw error text into Telegram HTML, so an error like `</rss>` gets the alert rejected. The feed-health path logged "sent" regardless of the result. (code measured, impact inferred) | Escape the text; log the real send result. | Fixed, `8c23a78` |
| Medium | `website/vercel.json` | The live `/briefing/` page has no CSP, `X-Frame-Options`, `nosniff` or `Referrer-Policy`; `/briefing` has all of them. `/:path*` does not match a trailing slash. (measured with curl) | One `/(.*)` rule for every path. Takes effect only after a Vercel deploy. | Fixed in repo, `a0e4d7d`; not deployed |
| Medium | `sender/telegram.ts:884-909` | Vote counters use GET then PATCH `current + 1`, so concurrent votes lose increments. Whether HTTP 201 means "new row" under `ignore-duplicates` is unverified. Open since October 6. The counter's `catch` also swallows errors with no log. (measured) | One service-only RPC that inserts the vote and increments in one transaction. Needs a migration. | Open: needs approval |
| Low | `pipeline/generate.ts:579` | Market Pulse wrote sector names such as "Chips & GPUs" into Telegram HTML unescaped. 12 of the 14 editions from October 28 to November 10 carried a raw `&`. Telegram accepted them, but its HTML mode requires `&amp;`. (measured) | Escape entity names. Slack's format also expects `&amp;`. | Fixed, `c4bb207` |
| Low | `pipeline/run.ts:171` | When marking a failed run also failed, the second error replaced the original in the logs. (measured) | Log the finalization failure and rethrow the original. | Fixed, `5ba4209` |
| Low | `pipeline/generate.ts:584`, `pipeline/run.ts:162` | Market Pulse and the validation follow-up swallowed errors with no log line. (measured) | Log a warning; the outcome is unchanged. | Fixed, `4c17335` |
| Low | `src/webhook.ts:165` | The rate limiter counted every request (health checks, wrong paths, forged POSTs) before the secret check. Behind Render's proxy all clients may share one address (inferred), so junk traffic could get real updates a 429. | Count only authenticated update POSTs. The new test pins the corrected contract; the old bug was at the call site and the test cannot fail against it. | Fixed, `c709f21` |
| Low | `src/onboarding.ts:336,371,388` | Callback data is client-supplied; onboarding stored any time, score or length value and echoed the time unescaped. A forged "99:99" never comes due. (measured) | Accept only values the keyboard offered. | Fixed, `45bc376` |
| Low | `commands/trends.ts:69` | `/trends NVDA 99999999999d` built an invalid date and replied "temporarily unavailable"; `0d` sent `limit=0`. (measured) | Clamp to 1-365 days. | Fixed, `4ad825f` |

Checked and not a bug:

- Onboarding saves `Asia/Kuala_Lumpur` because its buttons are labelled in MYT, so that matches what the user chose.
- The 7 RLS-on-no-policy tables are service-role-only by design.
- `webhook.ts` already uses `timingSafeEqual`, a 1 MB body cap and a required secret.
- The reader builds its DOM with `textContent` only.
- `delete_user_data` clears `telegram_inbox`.
- `ai_attempts` holds no user identity.

Decision for you: `reconciliation_audit.identity` keeps a chat identity after `/delete`. That looks like a deliberate audit trail; if so, say so in the privacy notes.

## 3. Improvements ranked by impact versus effort

Effort: S is up to a day, M is several days, L is weeks.

| Rank | Improvement | Impact / effort | Evidence and trade-off |
| --- | --- | --- | --- |
| 1 | Revoke the bot token (F1) | High / S | The only finding an outsider can act on today. About 15 minutes of bot downtime. |
| 2 | Deploy the website header fix | High / S | `/briefing/` is live without its CSP. Needs a Vercel deploy from a clean `website/` copy. |
| 3 | Run a database restore drill | High / S | Listed as not done since September (`docs/roadmap-implementation.md`). A local restore from a dump costs nothing and proves the backups. |
| 4 | Make votes one transaction (F7) | Medium / M | Lost increments skew trust scores. Needs a migration, a backfill decision for historical counts, and workers stopped before merge. |
| 5 | Drain the webhook on SIGTERM | Medium / S | Render redeploys on every merge to `main`. A killed handler leaves an inbox row that turns `ambiguous` after 10 minutes and needs a manual resolve. |
| 6 | Remove `'unsafe-inline'` from the site CSP and add SRI to Chart.js | Medium / S | One inline script at `website/index.html:813` is the only reason for it. Chart.js loads from jsDelivr with no `integrity`. |
| 7 | Type-check or lint `website/*.js` | Medium / S | `desk.js` is 1,414 lines that no linter or type-checker reads. `// @ts-check` plus `checkJs` in a small tsconfig is the cheapest start. |
| 8 | Drop the initial schema's `USING (true)` read policies | Medium / S | Nine tables still carry PUBLIC read policies from `20240101000000`; access now rests on column grants alone. Verify `anon`'s real privileges first; that query was not run in this review. |
| 9 | Cut a release | Medium / S | 30 commits sit past `v1.2.0` once this branch merges, and `package.json` still says `1.2.0`. |
| 10 | Add a Dependabot cooldown | Low / S | No release-age buffer today. Dependabot documents a `cooldown` key; confirm the syntax against GitHub's docs before committing, because CI does not validate this file. |
| 11 | Document the 9 env vars missing from `.env.example` | Low / S | `PORT`, `WEBHOOK_PATH`, `TELEGRAM_MODE`, `AI_FALLBACK_BASE_URL`, `OPENAI_API_KEY`, `CONFIG_SCOPE`, `RUNTIME_SCOPE`, `TELEGRAM_BOT_MODE`, plus the website's `SUPABASE_ANON_KEY` / `SUPABASE_PUBLISHABLE_KEY`. |
| 12 | Install `@vitest/coverage-v8` and add `test:coverage` | Low / S | Coverage is configured but its provider is not installed. Report coverage first; add thresholds later. |
| 13 | Split `sender/telegram.ts` by command group when next touched | Low / M | 1,200 lines mixing transport, commands and votes. Move one tested piece at a time. |

Leave alone for now: the 20 unused indexes (one user; usage will change), moving `pg_net` out of `public` (pg_cron dispatch depends on it, and moving it risks the dispatch path), and the `vitest.config.ts` ESM warning (cosmetic).

### Dependency PRs

| PR | Change | Checked | Recommendation |
| --- | --- | --- | --- |
| #28 | `node-telegram-bot-api` 1.1.1 → 1.2.0, `openai` 7.47 → 7.52, `@types/node` 22.20.0 → 22.20.5, `vitest` 5.0.5 → 5.1.0 | Clean install from its lockfile; the postinstall `exports` patch still applies; lint passes; 633 of 633 tests. All versions are at least 5 days old. | Merge |
| #27 | `github/codeql-action` 4.39.1 → 4.39.3 | CI green | Merge |
| #24 | `typescript` 5.9.3 → 7.0.2 | Clean install compiles and passes 616 of 616 tests, but the branch is cut from an older `main` (20 files differ). | Defer to its own batch: rebase, read the 6.0 and 7.0 release notes, then merge alone |
| #26 | Docs: production state as of November 3 | Adds the "Release notes for v1.2.0" link to the README twice | Remove the duplicate line, then merge |

## 4. Feature proposals

| Feature | Problem it solves | Effort | Impact | Risks or dependencies |
| --- | --- | --- | --- | --- |
| Edition archive with date links | The reader shows only the latest edition, so a past briefing cannot be reopened or shared. | S | High | `public_editions` already holds every edition; needs pagination and a stable URL per date. |
| Weekly watchlist recap | Readers with a watchlist must read every edition to see what changed for their companies. | M | High | Built from editions, prices and thesis history already stored. Label observed changes apart from inferred causes; any AI summary adds cost. |
| Publisher attribution for Google News links | Google News items share one hostname, so corroboration undercounts publishers (`TODOS.md`). | M | Medium | Resolving redirects means extra requests per item; cache results. |
| Alert quiet hours and a daily cap | High-impact alerts can arrive at night and have no frequency limit (roadmap v3 item). | M | Medium | Needs a preference column and a migration; claims stay atomic. |
| Delivery-timing card on the dashboard | Lateness is recorded in `product_events` but only visible through `npm run operations`. | S | Medium | Public data must not expose chat IDs; show aggregates only. |
| Correction record | A wrong claim in a sent edition has no visible correction. | M | Medium | Originals must stay immutable; decide who may publish a correction. |
| `/ask` over the archive | Readers cannot query past coverage in their own words. | L | Medium | Needs embeddings, which are off because no key is configured; adds model cost per question. |

Still rejected or parked, per `TODOS.md`: Related Prior Coverage (no demand evidence) and the catalyst tracker (check existing SEC and earnings data first).

## 5. Roadmap

### Now: this week

| Title | One line | Effort | Success criterion |
| --- | --- | --- | --- |
| Revoke the bot token | Revoke, set the new token in Render and Actions, close alert #1. | S | Render logs "Webhook registered with Telegram", the next delivery run is green, `/digest` replies, alert #1 is closed. |
| Ship the fix branch | Push `fix/review-2026-11-10`, open a PR, merge on green CI. | S | CI and CodeQL green on Node 22; the next delivery log shows counts and no names or chat IDs. |
| Deploy the website | Vercel deploy with `--skip-domain`, check, promote. | S | `curl -I` on `/`, `/briefing/`, `/dashboard/` and `/briefing/reader.js` all return the CSP. |
| Merge the safe dependency PRs | Merge #27 and #28; fix and merge #26. | S | CI green after each merge; no new runtime errors in the next digest run. |

### Next: 2 to 4 weeks

| Title | One line | Effort | Success criterion |
| --- | --- | --- | --- |
| Restore drill | Restore a production dump into a local Supabase and run the SQL tests and a read of the latest edition. | S | The restored database passes `supabase test db` and serves the latest edition; the time taken is recorded. |
| Atomic votes | Replace GET-then-PATCH with one RPC. | M | 100 parallel distinct votes give exactly 100; a duplicate vote changes nothing; an injected failure rolls back both writes. |
| Webhook shutdown drain | Stop the worker, finish the current update, close the server on SIGTERM. | S | A redeploy during a command leaves no `ambiguous` inbox row. |
| Stricter site CSP | Move the inline script to a file, drop `'unsafe-inline'`, add SRI to Chart.js. | S | Browser checks pass at all four widths with no CSP violations in the console. |
| Release v1.3.0 | Version, changelog and tag through `agent-os:release`. | S | Tag exists, release notes list every change since `v1.2.0`, `package.json` matches. |
| Website JS checks | Add `checkJs` for `website/`. | S | CI fails on a type error in `desk.js`. |

### Later: 1 to 3 months

| Title | One line | Effort | Success criterion |
| --- | --- | --- | --- |
| Edition archive | Date navigation and links on `/briefing/`. | S | Any past date opens its edition; a missing date shows a clear empty state. |
| Delivery-timing card | Show on-time share and lateness on the dashboard. | S | The card matches `npm run operations -- status` for the same week. |
| Weekly watchlist recap | One message per week per watchlist. | M | Every change links to a dated source; delivery is idempotent per user and week. |
| Alert quiet hours and cap | Respect a quiet window and a daily maximum. | M | No alert is sent inside a user's quiet window; the cap holds under overlapping runs. |
| TypeScript 7 | Rebased #24 as its own batch. | S | Lint, tests and the container check pass on Node 22. |

### Later still: 3 months and beyond

| Title | One line | Effort | Success criterion |
| --- | --- | --- | --- |
| Publisher attribution | Resolve Google News links to the real publisher. | M | Corroboration counts distinct publishers on a sample of 50 stories. |
| Correction record | Attach dated corrections to published stories. | M | The original text stays readable; each correction shows author, reason and time. |
| `/ask` over the archive | Answer questions from stored editions with citations. | L | On a reviewed set of 30 questions, every answer cites a stored article and none cites a missing one. |

## 6. Top three recommendations

1. **Revoke the bot token today.** It is the one finding someone outside can use right now: with it they can message every subscriber as the bot or redirect its webhook. The fix takes minutes and only you can do it.
2. **Ship this branch, then deploy the website.** The branch closes three faults that drop an edition, strand a delivery slot or lose an operator alert, and stops names from reaching public logs. The header fix does nothing until the site is redeployed.
3. **Run the restore drill before more features.** Every other safeguard here (claims, ledgers, reconciliation) assumes the database can be recovered, and that has never been tested. A local drill is free and turns an assumption into a measured recovery time.

I would keep the current architecture. The evidence points to operational fixes, not a rewrite.
