# Roadmap implementation and release checklist

Status: local implementation, not deployed. The roadmap release names are milestones, not changes to the existing package or migration version history.

## Implemented

| Area | Result | Main files |
| --- | --- | --- |
| Reader commands | `/digest` and `/last` render the latest validated publication, preserve its date, apply preferences and explicit filters, and explain missing/empty editions. Manual reads do not claim scheduled slots or generate AI content. | `src/commands/core.ts`, `src/pipeline/publication.ts` |
| Dependencies | Nodemailer 9.1.1 and Vitest 4.1.11; package lock updated. Node 22 declared in `.nvmrc` and package engines. | `package.json`, `package-lock.json` |
| Personal configuration | Private-chat guards precede command/callback side effects. Verification requests are limited to one per user per minute and five per destination per hour, atomically in Postgres. | `src/sender/telegram.ts`, foundation migration |
| Alerts | Shared transport distinguishes confirmed rejection from uncertain delivery. Pending/ambiguous claims cannot be automatically reclaimed. Selection follows final editorial filtering and adjusted ranking. | `src/pipeline/generate.ts` |
| Price watches | Invalid prices are rejected; quotes carry provider observation times. Watches fetch fresh quotes in batches of five, without the former 25-symbol cap. Only observations no older than 15 minutes trigger. Watch revisions have durable delivery identities and conditional completion. | `src/utils/stocks.ts`, `src/delivery/watches.ts` |
| Webhook intake | Validated updates are durably inserted before HTTP 200; `update_id` deduplicates intake. Bounded processing awaits asynchronous handlers. Per-chat processing is serialized at the claim boundary. Interrupted/uncertain handlers are quarantined, not replayed. | `src/webhook.ts`, `src/delivery/inbox.ts`, `src/utils/update-context.ts` |
| Editorial work | Existing editions are checked before generation. A database claim prevents overlapping generation for one editorial date. Repeated runs reuse the canonical edition. | `src/pipeline/run.ts` |
| Operational truth | `/sources` reads latest status per feed using real columns through bounded transport. Quote requests and trust-score requests have deadlines. Daily workflow restores both cache directories. | `src/commands/core.ts`, `.github/workflows/daily-digest.yml` |
| Dashboard data | Mentions aggregate over the selected period; price/sector histories and per-feed health are paginated; adjusted-score ordering matches editorial ranking terminology. Refresh interval is five minutes. | `website/dashboard/data.js`, `website/dashboard/desk.js` |
| Reader website | `/briefing/` presents the current edition, source links, counterarguments, stale states, and company evidence from coverage, filings, thesis history, and prices. Partial and capped results are labeled. | `website/briefing/` |
| Personalization | `/personalization prioritize` and `/personalization only` use the same renderer for requested and scheduled editions. Empty watchlists/matches have explicit guidance. | `src/delivery/personalization.ts`, `src/commands/preferences.ts` |
| Budget enforcement | Opt-in pre-transport reservations use reviewed model prices, worst-case input capacity and output limits. Reservations are atomic; unknown pricing, unbounded output, unknown prior spending, or insufficient budget block calls. Uncertain usage retains its full reservation. | `src/utils/budget-reservations.ts`, reader/operations migration |
| Quality tooling | Source-diverse selection precedes the article cap. Offline benchmark comparison requires at least 50 uniquely identified, human-reviewed reference cases. | `src/evaluation/`, `scripts/evaluate-benchmark.ts` |
| Recovery | Service-only status and reasoned delivery reconciliation commands; private audit trail; operational retention procedure. | `scripts/operations.ts`, `scripts/run-retention-cleanup.ts` |
| Bounded delivery | Delivery-history lookups have concurrency five; recipient delivery has concurrency three. Publication generation is still shared. | `src/scheduler.ts`, `src/utils/concurrency.ts` |
| Container | Multistage Node 22 build, production dependencies only, non-root runtime, writable cache/log directories. CI builds the container. | `Dockerfile`, `.dockerignore`, `.github/workflows/ci.yml` |

Activation reporting is available through `npm run operations -- activation`: rolling 30-day event counts, distinct users per event, and briefing requests on multiple UTC days. Research events are recorded only for successfully delivered structured research responses; neither event stores command arguments or message text. These measure interactions, not proof of comprehension or a cohort conversion rate.

## Important behavior and limitations

- Price watches are sampled at successful daily delivery, not continuous crossing detectors. Closed-market or delayed quotes older than 15 minutes do not trigger. Missing quotes leave the watch active. A failed watch attempt does not invalidate an already delivered digest.
- Uncertain external sends sacrifice automatic availability to avoid duplicates. No exactly-once claim is made across Telegram and Postgres.
- Inbox handlers interrupted after starting are marked ambiguous after ten minutes. They are not automatically resumed because a preference change or external reply may already have happened. Pending updates can be processed after restart. Deduplication of completed updates is retained for 30 days.
- Completed inbox payloads are cleared immediately. The weekly retention job clears payloads older than one day and quarantines expired pending work; with a weekly schedule this is not a strict 24-hour retention guarantee. Database backups follow the operator's separate retention policy.
- A generation process killed while running leaves its editorial claim locked. Inspect its publication and AI ledger before an operator releases the claim; waiting alone is not evidence that paid work did not occur.
- Public editions contain an allowlisted projection of editorial content. Private publication payloads, subscriber settings, delivery records, email requests, and inbox content remain service-only.
- Budget mode defaults to `advisory`. Do not enable `AI_BUDGET_MODE=enforced` until every used endpoint/model has verified pricing, a valid input-token ceiling, source URL, and review expiry in `ai_model_prices`. The monthly limit is a rolling 30-day window. Historical unknown-cost attempts block enforcement until their costs are reconciled. Pricing validation and provider billing reconciliation are operational prerequisites, not completed by this change.
- Benchmark tooling does not establish factual accuracy on its own. `unsupportedClaims` must be annotated against the source by a reviewer; it is not a model self-certification. A real reviewed corpus has not been supplied or fabricated.
- Company evidence is a dated research view, not proof of each generated claim. The 90-day coverage, 20-filing, and 12-thesis caps are visible in the UI.
- The scheduler still loads active users and performs per-user history queries, now bounded. A set-based due-user query and continuously operated delivery worker remain scale work.

## Verification on 2026-09-23

- Explicit Node executable: Node **22.23.2**. Merely wrapping `npm` in `npx --package=node@22` was insufficient on Windows because the installed npm launcher selected Node 26; the final checks used Node 22 directly with the npm CLI and a matching PATH.
- `npm run lint`: passed both TypeScript projects.
- `npm test`: build and **483 tests across 66 files passed** on the final run.
- `npm audit --audit-level=high`: **0 vulnerabilities**.
- `npm run verify:website`: dashboard and briefing at **320, 768, 1024, 1440px**; pagination 20 → 40 → 45; latest search wins; stale/partial/retry reader states; unsafe link and HTML fixtures; zero browser exceptions.
- `git diff --check`: passed. Git reports expected Windows LF/CRLF normalization notices.
- All four new migrations are applied locally. `npx supabase test db --local`: **119 checks passed** across two suites, including private/public access, worker grants, safe publication projection, deletion, reservations, and notification claims. Schema lint passed with only the retained, unused compatibility parameters `p_stale_after_seconds` reported as warnings.
- `npm run verify:local-api`: **48 real HTTP checks passed** against pinned PostgREST 14.7 and the local Supabase database. Anonymous, authenticated, and service roles were exercised. CRUD fixtures are rolled back. The same script also passed actual worker-process restart tests for durable acceptance, deduplication, payload erasure, and failed/abandoned claim quarantine. Inbox fixture rows are committed only to the named local database and removed afterward; external dispatch is replaced by an offline callback and production `.env` loading is disabled.
- `npm run verify:local-concurrency`: concurrent digest, alert, and editorial claims each had exactly one winner; inbox processing serialized one chat and progressed after completion. Only synthetic local fixture rows are cleaned up.
- `docker build --tag goldirham-webhook:local .`: passed. `node scripts/verify-container.mjs`: actual server health, non-root user, writable runtime directories, no embedded `.env`, malformed/unauthenticated request rejection, and HTTP 503 when durable acceptance is unavailable all passed with container networking disabled.
- CI now includes the real API, concurrency, and isolated container checks. They have been executed locally; the remote CI run has not been triggered.
- Deployed connectivity, real delivery, paid model calls, and restore drills remain **not verified**. No production migration/deployment or Git commit/push was performed.

### Resolved local environment error

`npx supabase db push --local --yes`:

```text
Connecting to local database...
failed to connect to postgres: failed to connect to `host=127.0.0.1 user=postgres database=postgres`: dial error (dial tcp 127.0.0.1:54322: connectex: No connection could be made because the target machine actively refused it.)
Try rerunning the command with --debug to troubleshoot the error.
```

`npx supabase test db --local`:

```text
Connecting to local database...
{"_tag":"Error","error":{"code":"LegacyDbConnectError","message":"failed to connect to postgres: effect/sql/SqlError: PgClient: Failed to connect"}}
```

Docker Desktop initially failed to start. Its historical log reported:

```text
starting services: initializing Ingest server: listening on unix://C:/Users/shaxii/AppData/Local/Docker/run/sailor-ingest.sock: rename C:/Users/shaxii/AppData/Local/Docker/run/sailor-ingest.sock C:/Users/shaxii/AppData/Local/Docker/run/sailor-ingest.sock.stale: The file cannot be accessed by the system. (listener: The file cannot be accessed by the system.)
```

Docker later started successfully and the blocked checks above passed. No Docker files were removed and no factory reset was attempted. Temporary test containers are stopped, but retained to honor the no-deletion preference.

The upgraded Vitest also emits a non-blocking warning about ESM syntax in CommonJS `vitest.config.ts` and a future Vite native config loader. Current build/tests pass; a future config-loader migration is separate.

## Release sequence — requires operational authorization

1. Review the four migrations and this verification record. To reproduce locally, run `npx supabase db start`, `npx supabase db push --local --yes`, `npx supabase test db --local`, `npx supabase db lint --local --fail-on error`, `npm run build`, `npm run verify:local-api`, and `npm run verify:local-concurrency`. The last check requires an idle local inbox.
2. Run Node 22 lint, full tests, browser verification, audit, and `docker build --tag goldirham-webhook:local .`.
3. Stop old editorial, scheduler, and webhook workers before the production migration. Old alert workers must not run against the new outcome policy.
4. After an authorized backup and migration review, apply in order: `20260922173201_foundation_delivery_safety.sql`, `20260922174405_reader_and_operations.sql`, `20260923091225_inbox_claim_serialization.sql`, `20260923094449_service_role_private_operations_grants.sql`. These are canonical migration files; historical schema snapshots are not deployment inputs.
5. Deploy the matching server and website build. Website build requires `SUPABASE_URL` and a public anon/publishable key; missing/privileged keys fail the build. Never put a service key in browser configuration.
6. With separately authorized test recipients, exercise onboarding → published retrieval → scheduled delivery → repeated retrieval → stop/delete; verify an uncertain alert is quarantined. Confirm inbox acceptance survives a worker restart and private rows remain unreadable through the public API.
7. Inspect `npm run operations -- status`. For delivery reconciliation, use `npm run operations -- resolve digest|alert ID success|failed "specific evidence and reason"`. Mark failed only with evidence that no message was accepted; that state permits another send. Never resolve a live in-flight worker's claim. Reasons are retained in a private audit record; avoid personal content.

## Remaining roadmap work

| Milestone | Remaining work / prerequisite |
| --- | --- |
| v1 exit evidence | Database, concurrent-claim, and HTTP contracts now pass. The full offline reader journey now passes through real bot routes and onboarding/render/delivery code with fake external transport and in-memory persistence. It covers setup, retrieval, scheduled delivery, replay suppression, stop, and deletion without AI requests. Local worker-process restart and abandoned-claim quarantine also pass. Controlled deployment verification and a production recovery drill with real Telegram transport still need separate authorization. |
| v1.1 | Manual accessibility audit; further dashboard domain extraction if needed (data/desk/motion scripts and event handlers are already externalized, with stricter script CSP); domain repository extraction where it reduces duplication; proactive operations monitoring and restart drills. |
| v2 | Human review of at least 50 benchmark cases and usability evidence for the reader/company view. Existing benchmark scripts are infrastructure, not a completed editorial benchmark. |
| v3 | Preference-aware alert job, quiet hours/frequency limits, evidence-change summaries, and independently durable email/Slack copies. These remain conditional on demonstrated use, healthy credentials and reviewed costs, as specified in the roadmap. |
| v4 | Set-based due-user batches; demand-driven always-on workers; measured public-read caching/indexes; deployed correlation/latency/queue monitoring; backup restore and deletion/retention drills. Production environment access and agreed service objectives are prerequisites. |

The controlled rollout and its Git commit/push were authorized on 2026-09-23. Production mutation remains gated on deployment access, stopping the old workers, and a verified database backup. Real-recipient tests remain a separate step.

## Production preflight on 2026-09-23

- The connected Supabase account identifies `Ai-Infra-digest` (`hxldibicsyydkannudha`) as healthy. Its 32 applied migration versions match the repository through `20260906080818_ai_attempt_ledger`; exactly the four new migrations remain pending.
- A read-only query found 25 publications, including the 2026-09-23 edition. The correct date column is `publication_date`.
- The GitHub app has access to `ixtaqq/ai-infra-digest`; remote `main` matches local base `4fa307366a080f86d23c5b065993eab3cc188cf2`.
- The connected Vercel account can list `goldirham-stack` and its ready production deployment. Its project-details tool currently fails input validation, so deployment should use the project's preferred CLI path after login.
- This checkout has no `.env`, no Supabase project link, and no Vercel project link. GitHub, Supabase, and Vercel CLIs are signed out. Render sign-in is required in both the in-app browser and Chrome. No workers have been stopped and no production data or deployments have been changed during this preflight.

Access checks returned:

```text
gh auth status
You are not logged into any GitHub hosts. To log in, run: gh auth login

npx supabase projects list
{"_tag":"Error","error":{"code":"LegacyPlatformAuthRequiredError","message":"Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable."}}

npx vercel whoami
> Logged out.
> Run `vercel deploy --temporary` to create a temporary deployment you can claim later, or `vercel login` to log in.

Vercel get_project
Input validation error: Invalid arguments for tool get_project: idOrName: Invalid input: expected string, received undefined

Initial publication-date query (corrected to publication_date)
ERROR:  42703: column "editorial_date" does not exist
```

Use the existing production projects; do not create a temporary Vercel project or reset database credentials to work around missing login. Continue with the release sequence above after access and backup prerequisites are satisfied.

## Resolved verification failures

The first combined npm invocation used a Windows-incompatible command separator inside npm's command runner:

```text
npm error Missing script: "lint;"
```

Commands were rerun separately. A new parameterized fixture initially failed the TypeScript check:

```text
src/delivery/personalization.test.ts(40,81): error TS2345: Argument of type '(watchlist: string | undefined) => void' is not assignable to parameter of type '(...args: [] | [string]) => Awaitable<void>'.
src/delivery/personalization.test.ts(41,93): error TS2322: Type 'string | undefined' is not assignable to type 'string[] | undefined'.
```

The fixture now passes objects to Vitest's parameter table. During the reader-copy update, `npm test` exposed two mismatched copy expectations in successive runs:

```text
FAIL src/index.commands.test.ts > /coverage command > shows a not-configured message when Supabase is unavailable
Expected: "not configured"
Received: "Coverage history is temporarily unavailable. Please try again later."

FAIL src/index.commands.test.ts > /watch command > shows a reader-facing unavailable message when Supabase is unavailable
Expected: "temporarily unavailable"
Received: "Supabase not configured. Price watches require a database."
```

The command copy and assertions are now consistent. The final full suite passed.

## Database verification follow-up

`npx supabase test db --local` initially failed after Docker was restored:

```text
psql:/workspace/Projects/ai-infra-digest/supabase/tests/foundation.test.sql:50: ERROR:  permission denied for table price_watches
HINT:  Grant the required privileges to the current role with: GRANT SELECT, DELETE ON public.price_watches TO service_role;
CONTEXT:  SQL statement "DELETE FROM public.price_watches WHERE chat_id = p_chat_id"
PL/pgSQL function public.delete_user_data(bigint) line 14 at SQL statement
Result: FAIL
```

Inspection found 13 older tables without explicit service-role persistence grants on a fresh local schema. The fourth migration grants worker CRUD and sequence access to those named tables; public grants are unchanged. Each privilege is now tested independently. Supabase documents grants and RLS as separate access controls in its [API security guide](https://supabase.com/docs/guides/api/securing-your-api).

The migration command completed but emitted a non-blocking CLI catalog-cache warning:

```text
Warning: failed to cache migrations catalog: error exporting pg-delta catalog: edge-runtime script produced no output:
Error: Connection terminated unexpectedly
```

Subsequent database tests, lint, real HTTP contracts, and concurrent claims all passed. This warning concerns the CLI's cached catalog, not an unapplied migration.
