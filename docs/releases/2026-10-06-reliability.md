# Reliability, delivery timing, and benchmark preparation

Status: implemented and verified locally on October 6, 2026. The user authorized commits, branch publication, and a draft PR on `codex/reliability-timing-benchmark`; merge and deployment remain pending. No database migration is needed. Existing edits to `AGENTS.md`, `CLAUDE.md`, and `docs/brand/` are outside this release.

## Changes

The repair batch from [the project review](../project-review-2026-10-06.md) is retained: Nodemailer 10.0.15, bounded HTTP requests, RSS cache/error fixes, validated watchlists, accurate save failures, reader recovery, stale-search protection, and correct boolean sort direction. Regression tests cover the demonstrated failures.

Generation now runs at **06:17 MYT** (`17 22 * * *` UTC) with `node dist/index.js --publish-only`. It creates or reuses the same durable editorial publication without claiming or sending the scheduled digest. The default channel becomes due at **08:00 in the configured editorial timezone**. Personal subscriptions retain their own local date and preferred time. The scheduler also carries the default Slack/email configuration, so those copies remain available after generation is separated from digest delivery.

Generation still performs its existing opted-in high-impact alerts and operational warnings. Those can arrive at the earlier generation time. `--publish-only` is not an offline or side-effect-free command: generation can spend AI credits, write to Supabase, and send those alerts. It was not run against production during this work.

The delivery workflow runs at minutes 7, 17, 27, 37, 47, and 57 and also after a successful daily workflow on `main` in this repository. The new completion trigger cannot check out an upstream branch or download its artifacts. A completion before a user's due time does not deliver early; a later completion catches up pending slots. A default channel that is also a due subscriber shares the existing date claim, and pending/ambiguous sends remain quarantined.

This provides 103 minutes of planned generation headroom and avoids the top-of-hour trigger. It does **not** guarantee an 8 AM arrival: the first nominal polling tick is 08:07, and GitHub can delay or drop scheduled work. See [GitHub's workflow event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule). The observed four-hour October 5 delay would exceed this headroom if it recurred. A measured delivery commitment still requires a more dependable runtime decision; none was provisioned or billed here. Earlier generation also moves the news cutoff earlier.

Publication-ready and default-delivery logs now include timestamps and publication identity. Missing-publication logs distinguish upstream readiness from transport failure. Existing personal-delivery product events retain lateness in seconds. Measure these timestamps for seven days after rollout before claiming the proposed 95%-within-15-minutes target.

## Editorial review set

[The candidate set](../../benchmarks/editorial-review-2026-10-06.json) contains 50 unique real sources: ten each from NVIDIA, AWS, Cloudflare, Google, and NASA. Each input has provenance and a SHA-256 hash. All 50 are pending human review; there are no invented reviewer identities or claimed accuracy scores.

The inputs are short RSS excerpts. This is a starting set for classification and evidence restraint, not full-article quality certification. [The review guide](../../benchmarks/README.md) specifies the rubric, limitations, export procedure, prediction format, and next coverage additions. Export rejects pending reviews, duplicates, changed text, and output overwrites. Evaluation requires matching input hashes and human claim-review metadata.

## Verification

Final local checks used Node 22.23.3:

| Command | Result |
| --- | --- |
| `npm test` | Build passed; 517 tests passed in 68 files |
| `npm run lint` | Main and script TypeScript checks passed |
| `npm audit --audit-level=high` | `found 0 vulnerabilities` |
| `node scripts/verify-website.mjs` | All checks passed at 320, 768, 1024, and 1440px; no browser errors |
| `docker build --tag goldirham-webhook:review-20261006-final .` | Production container built successfully |
| `node scripts/verify-container.mjs goldirham-webhook:review-20261006-final` | Actual isolated container passed health, non-root, writable-directory, no-env, authentication, input-shape, and unavailable-storage checks |
| `npm run review:benchmark -- status benchmarks/editorial-review-2026-10-06.json` | 50 cases; 0 reviewed; 50 pending; ready for evaluation: false |
| Offline review/export/evaluation subprocess tests | Pending/self-reviewed/mismatched inputs rejected; complete synthetic fixtures passed; existing output preserved |
| `git diff --check` | Passed; existing AGENTS/CLAUDE line-ending notices only |

The real corpus was fetched from public RSS; no AI provider was called. Synthetic unit fixtures are labeled as such and do not count as editorial review. Local SQL/real PostgREST/concurrency suites were not rerun because no schema or claim RPC changed. Remote CI, CodeQL, and Semgrep remain release checks. Live SMTP with the upgraded dependency and live scheduling remain unverified.

Before implementation, the new behavioral regressions failed as expected. Command: Node 22 running `node_modules/vitest/vitest.mjs run src/pipeline/run.test.ts src/scheduler.publication.test.ts`.

```text
Test Files  2 failed (2)
Tests  5 failed | 11 passed (16)

publishes ahead of delivery without claiming or sending a message
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times

holds the default channel until 08:00, then delivers with its durable claim
AssertionError: expected "vi.fn()" to be called with arguments: [ -100, '2026-08-19' ]
Number of calls: 0
```

The corrected tests pass in the final full suite. Vitest still emits the existing non-blocking Vite warning:

```text
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
```

## Release procedure

1. Review this change set, excluding the pre-existing instruction and brand edits. The three logical groups are the repair batch, publication/delivery timing, and benchmark preparation.
2. With the user's Git authorization, commit the scoped files on `codex/reliability-timing-benchmark`, push that branch, and open a draft PR. Run existing CI and CodeQL before any merge. No production workflow needs manual dispatch for these checks.
3. Merge only after reviewing the earlier generation cutoff and alert timing. `main` automatically deploys Render and activates the workflow changes. This release contains no migrations. Do not run a live pipeline merely to smoke-test the release: that would spend and message real recipients.
4. Deploy the website changes through the existing linked Vercel project, verify the preview, then promote the reviewed deployment. Use only its public Supabase key; do not include the service key or local private files.
5. Inspect naturally occurring publication/delivery runs. Confirm a same-day publication, successful scheduled sends, and no duplicate or uncertain replay. Keep the seven-day timing measurement distinct from the offline test result.

Human editorial review is a separate remaining action, not a release claim. A future evaluated model run also needs the user's approval if it incurs provider charges. The candidate preparation and comparison commands themselves make no model calls.
