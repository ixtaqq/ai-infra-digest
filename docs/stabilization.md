# Stabilization implementation — 2026-09-06

This implements the two prioritized milestones in the supplied implementation brief. The baseline was a clean working tree at package version 1.0.1. These changes are local and unpublished; this document does not certify production health.

## Behavior

- The dashboard renders every accumulated page, preserves expanded pagination during refresh, resets page offsets when replacing the list, and ignores superseded search/pagination responses. CSV export covers loaded rows only.
- Both digest senders share complete HTML message planning. Continuation labels, reopened tags, entities, and Unicode code points fit within the 4096-unit conservative bound.
- The scheduler exits unsuccessfully on missing configuration, required database failures, missing/invalid publications, or failed/ambiguous deliveries. No audience and no due slots remain normal idle outcomes.
- Telegram success is acknowledged in the database before optional Slack/email copies. Copy waits have a 15-second bound; a failed copy does not turn an acknowledged primary delivery into a retry.
- Required publication, audience, delivery-history, and claim operations propagate failures. Database requests have 15-second deadlines; active users are read in ordered 500-row pages.
- Stored publications validate nested articles, category arrays, token usage, prices, feeds, SEC extracts, earnings analyses, capabilities, and deep dives before delivery.
- Corroboration counts unique normalized URL hostnames in each story cluster. Repeated feed entries and multiple links on the same hostname do not inflate it. Hostnames are a conservative proxy, not proof of independent ownership, original reporting, or independent confirmation. Syndication and publisher provenance remain future work.
- Editorial run status starts as `running`; publication/delivery completion finalizes it. A failed status write is surfaced rather than silently accepted.

## Delivery recovery and rollout

There is no exactly-once guarantee spanning Telegram and PostgreSQL. A successful external send followed by an unavailable database cannot be resolved automatically.

| Stored state | Automatic retry |
|---|---|
| `success` | Never |
| `failed` | Allowed after confirmed primary rejection |
| `pending` | Never, even after the old lease duration |
| `ambiguous` | Never |

Multipart partial success, transport timeouts, and unreadable transport outcomes are ambiguous. Failed finalization leaves the claim pending (or possibly finalized if only its acknowledgement was lost). The worker reports failure and withholds copies. Operators must investigate before releasing the slot.

Before rollout, stop all old daily and scheduled delivery workers. Apply both additive migrations through the repository's normal reviewed deployment process, then start only the new workers. Do not overlap workers using the old stale-lease policy with the new policy.

For each unresolved `(chat_id, run_date)`, inspect its publication and available transport logs, then confirm receipt with the recipient when necessary. Mark it successful only with evidence of completion. Mark it failed only with evidence that no part was delivered. Leave uncertain/partial sends quarantined; do not bulk reset pending rows or change them merely because they are old. Restrict reconciliation to the service/operator role and record the reason.

If application rollback is necessary, keep workers stopped and keep the conservative claim function. Do not restore stale-pending reclamation or drop ambiguous records. The new AI ledger can remain in place unused. Roll forward after fixing the problem; no destructive rollback is needed.

## AI accounting and cache

All seven AI processor transports use the shared attempt boundary, including SDK retries, fallback attempts, direct HTTP, embeddings, and weekly thesis generation. `ai_attempts` is a private service-only ledger of stage, provider label, model, time, transport status, duration, usage, and provider-reported cost. It stores no prompts, response content, credentials, or user identifiers. HTTP success describes transport success, not semantic correctness.

Missing usage/cost is `NULL`, not zero. Known token totals and unknown-attempt counts are recorded in run metrics. In-process editorial accounting is isolated across concurrent runs. Failed ledger writes are logged explicitly and never cause a second billable model call. Consequently, durable accounting is not guaranteed during a database outage; provider invoices remain authoritative.

The old flat token-to-dollar estimate is removed. Prices are not inferred for unknown models. The rolling budget reads all private attempt pages, including retries and same-day reruns. If any price or the ledger is unavailable, spend is unknown and the existing generation policy continues with an explicit warning: **budget settings are advisory, not a strict spending cap**. A reviewed provider/model price catalog and pre-call reservations would be needed for a hard cap. Historical `ai_usage` and daily estimates are not backfilled or represented as complete billing records.

Cache identity now includes prompt/schema versions, configured provider/model identities, and source content. Cache hits do not create new billable attempts.

The weekly retention script removes AI attempts older than 90 days. Existing private/public retention remains unchanged. Console/Actions logs and backups have their platform retention; deleting private user state does not retract delivered messages or independently retained copies.

## Verification

Offline gates: `npm run lint`, `npm run build`, `npm run test:unit`, `npm test`, `npm run verify:website`, and `npm audit --audit-level=high`.

Verified locally on 2026-09-06: lint/build passed; 407 unit tests and 452 full-suite tests passed; the populated website checks passed at all four widths; the dependency audit reported zero vulnerabilities. Local commands used Node 26.7.0; CI remains pinned to the intended Node 22 runtime. The local run does not substitute for that CI result.

The website verifier requires a local server at port 4321 and Chrome/Chromium/Edge. It checks 20 → 40 → 45 rows and superseded searches at four viewport widths. On this Windows host Edge exits before starting its debugging endpoint; use `BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe` for the verifier. The verifier uses synthetic articles and does not query production data.

Database checks: `npx supabase test db --local` and `npx supabase db lint --local --fail-on error`. CI runs them against a disposable migrated database. The 18 transactional pgTAP assertions exercise public-role denial, permitted research reads, service-only claims, duplicate suppression, stale pending quarantine, ambiguous quarantine, and confirmed-failure retry. Fresh local migration application was verified. The retained `p_stale_after_seconds` RPC argument is intentionally unused for signature compatibility and produces a non-blocking database lint warning.

## Remaining gates and roadmap

Production migrations/deployment, a prior-release production-shaped upgrade rehearsal, isolated backup restore, live Telegram/SMTP/Slack checks, manual screen-reader checks, and the 14-day reliability observation remain operational work. No live messages, paid AI calls, commits, or deployments were performed for this implementation.

The broader report also proposes stored `/digest` previews, timezone-aware onboarding, private-command admission, webhook replay protection, richer publisher provenance, and a human-labelled semantic evaluation set. Those are subsequent roadmap items beyond the two prioritized milestones; they are not represented as completed here. Bare `/digest` still shows operator guidance in this checkout. Structural validation and transport accounting do not establish factual accuracy or complete coverage. Optional integrations' deployed health has not been reverified.

GitHub research informed the approach without adding dependencies: [Supabase database tests](https://github.com/supabase/supabase/blob/master/apps/docs/content/guides/database/testing.mdx), [Supabase test helpers](https://github.com/usebasejump/supabase-test-helpers), and [grammY message types](https://github.com/grammyjs/types/blob/main/message.ts). The implementation preserves the existing static website and Telegram library.
