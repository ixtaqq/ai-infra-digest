# Goldirham Stack review and roadmap

Reviewed on October 6, 2026, in `E:\workspace\Projects\finance\ai-infra-digest`.

This review used Agent Homebase's workflow, technical-writing adapter, and ship-check, with pstack's root-cause and direct-verification principles. Changes are local and uncommitted. Existing changes to `AGENTS.md`, `CLAUDE.md`, and `docs/brand/` were preserved. No deployment, paid model call, real-recipient send, or database migration was performed.

## 1. Architecture summary

1. Goldirham Stack delivers AI infrastructure news and company research to Telegram readers; the repository records a deployed production release.
2. Node 22 and strict TypeScript run three entry points: `src/index.ts`, `src/scheduler.ts`, and `src/webhook.ts`.
3. The editorial pipeline collects RSS, SEC filings, and optional earnings transcripts, then deduplicates, analyzes, ranks, and publishes an edition.
4. Supabase stores canonical publications, public reader projections, preferences, delivery claims, an update inbox, metrics, and AI accounting.
5. The scheduler reads a shared edition and delivers personalized Telegram messages, optional email/Slack copies, and sampled price-watch alerts.
6. The webhook authenticates and stores Telegram updates before acknowledgment; the inbox worker awaits command processing and quarantines uncertain work.
7. Static JavaScript powers the landing page, briefing reader, and Chart.js dashboard on Vercel; the webhook runs on Render.
8. GitHub Actions runs scheduled work and CI; Vitest covers offline behavior, with separate browser, SQL, HTTP, concurrency, and container verification scripts.

### Analysis evidence and checks

Read the entry points, pipeline and delivery boundaries, collectors, REST helpers, command routing, website data/reader code, package and TypeScript configuration, CI/scheduled workflows, migrations relevant to public/private data, and the existing release handoff.

| Check | Before changes | After changes |
| --- | --- | --- |
| `npm test`, including its TypeScript prebuild | 488 tests in 66 files passed | 504 tests in 67 files passed |
| `npm run lint` | Passed both TypeScript projects | Passed both TypeScript projects |
| `npm audit --audit-level=high` | Failed: one high-severity vulnerable package, Nodemailer | Passed: `found 0 vulnerabilities` |
| `node scripts/verify-website.mjs` | Existing browser checks passed | Existing checks plus query-order, missing-config, and invalid-search regressions passed |
| `git diff --check` | Not recorded before changes | Passed; Git emitted existing AGENTS/CLAUDE LF/CRLF notices |

The initial shell used Node 26.7.0. Final build, tests, lint, and browser verification used Node **22.23.3**. The full suite includes the mocked integration suites. Browser checks exercised 320, 768, 1024, and 1440px widths, article pagination, keyboard expansion, search ordering, stale/partial/retry states, and unsafe HTML/link fixtures; `browserErrors` was empty.

SQL, real PostgREST, concurrency, container, and Semgrep suites were inspected but not rerun in this review. No SQL or container changes were made. Website configuration generation and a hosted build were not run: this checkout has no `.env`, and the static reader was verified with fixtures. Offline mail composition passed with the installed Nodemailer; that does not test live SMTP credentials after the upgrade.

Read-only production evidence updates the historical handoff:

- The last three daily runs returned success. The [October 5 daily run](https://github.com/ixtaqq/ai-infra-digest/actions/runs/37263069973) was a `schedule` event, started at **12:20:17 PM MYT**, and logged pipeline completion at **12:22:50 PM**. Its configured cron is **8:00 AM MYT**.
- That run logged `Slack: digest delivered (5 messages)` and `Email: digest delivered`. Embeddings and earnings were disabled because their optional keys were absent. The earlier 401/SMTP failures in repository notes are historical, not evidence of a current outage.
- Two of the last three per-user scheduler runs succeeded. The [failed October 5 scheduler run](https://github.com/ixtaqq/ai-infra-digest/actions/runs/37253529526) started at **9:58:38 AM MYT**, before that day's edition existed.
- These logs establish successful transport calls and a publication-timing failure. They do not prove that every recipient read a message or establish a delivery SLA.

## 2. Error and fix table

Line references below refer to the reviewed working tree. High means a dependency-security or pipeline-availability issue; Medium means incorrect user behavior or data consistency; Low means misleading diagnostics or a latent API defect.

| Severity | File | Problem and root cause | Fix | Status |
| --- | --- | --- | --- | --- |
| High | `package.json:46`, `package-lock.json` | Nodemailer 9.1.1 is covered by current security advisories; the previous range cannot install the fixed major version. | Pin 10.0.15; update lockfile; compose real MIME messages offline through both application mail functions. | Fixed locally; audit clean |
| High | `src/collector/rss.ts:90` | RSS clears its timeout after response headers, before `response.text()`. A stalled body keeps collection waiting. | Clear the timer in `finally`, after body consumption. | Fixed; failing-before/passing-after regression |
| High | `src/collector/sec.ts:122`, `src/collector/sec.ts:297`, `src/collector/earnings.ts:118`, `src/utils/novelty.ts:19`, `src/utils/derived-metrics.ts:115`, `src/utils/derived-metrics.ts:158`, `src/utils/derived-metrics.ts:189`, `src/sender/telegram.ts:876`, `src/sender/telegram.ts:895`, `src/sender/telegram.ts:902` | These raw HTTP paths bypassed the existing bounded REST helper and had no application deadline. Optional enrichment or vote processing could stall a worker. | Add a 15-second abort signal per request, covering response bodies. Preserve current failure handling and avoid replaying uncertain writes. | Fixed; seven new timeout regressions cover collectors, novelty, and metrics; vote signal additions reviewed/typechecked |
| Medium | `src/sender/telegram.ts:660` | `/watchlist` only split and uppercased input. It saved markup, punctuation, empty lists, and duplicates; the success response interpolated input into HTML. | Reuse `normalizeTickerSymbols`, reject malformed lists before writing, deduplicate valid symbols, and escape output. | Fixed; routing regressions |
| Medium | `src/collector/rss.ts:325` | The 304 return bypassed the success-cache update, retaining previous consecutive failures and old validators after recovery. | Route 304 through the shared success-cache update, with zero returned articles. | Fixed; cache recovery regression |
| Medium | `website/briefing/reader.js:9` | Missing reader config threw synchronously while constructing the promises, before `Promise.allSettled` could handle failures. Company search remained in a loading state. | Make `readerQuery` async so the existing per-section failure UI receives rejected promises. | Fixed; browser regression at all four widths |
| Low | `src/collector/rss.ts:103` | Non-2xx responses were converted to an empty XML body; an HTTP 503 was reported as `Unable to parse XML.` | Throw the HTTP status before XML parsing. | Fixed; diagnostic regression |
| Low | `website/briefing/reader.js:48` | Invalid ticker submissions did not advance the request revision. A pending earlier search could overwrite the validation message. | Advance revision before input validation. | Fixed; delayed-response browser regression |
| Low | `website/dashboard/data.js:5` | `ascending: false` generated `asc`, while `true` generated `desc`. Current production callers do not use this boolean, but the helper contract was inverted. | Use `ascending === true` for ascending order; retain descending default and explicit multi-column order. | Fixed; browser query-contract regression |
| Low | `src/sender/telegram.ts:685` | Failed watchlist persistence claimed an in-memory session fallback that does not exist. | Report save failure and invite retry. | Fixed; routing regression |
| High | `.github/workflows/daily-digest.yml:6`, `src/scheduler.ts:157` | Independent schedules allow due-user delivery to run before publication. The observed daily trigger arrived over four hours after the configured time. | Proposed: generate ahead of the delivery target, trigger catch-up after successful publication, measure freshness, and select a scheduling runtime if timing is a product commitment. | Open operational issue; no hosted change made |
| Medium | `src/sender/telegram.ts:894` | Vote aggregates use GET-current then PATCH-current-plus-one. Concurrent votes can read the same count and lose an increment. HTTP 201 is also used as insertion evidence for an ignore-duplicates request, which needs a real API contract check. | Proposed: one service-only transaction returns whether insertion occurred and atomically updates counters. Verify duplicates, parallel voters, and rollback. | Open data-consistency finding from code review; requires coordinated database/application work |

The Nodemailer report includes high-severity cross-transport TLS identity and address-parsing advisories. This app uses a fixed Gmail transport; no exploit was demonstrated here. [Upstream security advisory](https://github.com/advisories/GHSA-6vj9-mwq6-2f5v), [10.0.15 release](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.15). The [10.0.0 release notes](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.0) require Node 20+, compatible with this project's Node 22 target.

### Minimal changes and reproduction

Security dependency:

```diff
- "nodemailer": "^9.1.1"
+ "nodemailer": "10.0.15"
```

RSS body deadline and HTTP diagnostics:

```diff
 const response = await fetch(url, { headers, signal: controller.signal });
-clearTimeout(timer);
 ...
-return { body: null, status: response.status, etag, lastModified };
+throw new Error(`HTTP ${response.status}`);
 ...
-} catch (error) {
+} finally {
   clearTimeout(timer);
-  throw error;
 }
```

Other unbounded HTTP calls each add this option, following the existing REST transport's deadline:

```diff
 const response = await fetch(url, {
+  signal: AbortSignal.timeout(15_000),
```

RSS recovery removes the early 304 return and uses the existing cache-success path:

```diff
-const result = await parserFor(feed.url).parseString(httpResult.body || "");
+const result = httpResult.status === 304
+  ? { items: [] }
+  : await parserFor(feed.url).parseString(httpResult.body || "");
```

Watchlist validation reuses the existing domain helper:

```diff
-const tickers = tickersStr.toUpperCase().split(/[,; ]+/).filter(Boolean);
+const values = tickersStr.toUpperCase().split(/[,;\s]+/).filter(Boolean);
+const tickers = normalizeTickerSymbols(values);
+if (!tickers.length || values.some(value => !tickers.includes(value))) {
+  // Send the fixed validation message and return before persistence.
+}
-${tickers.join(", ")}
+${escapeHtml(tickers.join(", "))}
-Your preferences will be used for this session only.
+Please try again later.
```

This excerpt compresses the reply boilerplate; `git diff -- src/sender/telegram.ts` contains the complete executable change.

Reader failures and request order:

```diff
-const readerQuery = (table, opts) => {
+const readerQuery = async (table, opts) => {
 ...
 async function loadCompany(ticker) {
+  const revision = ++companyRevision;
   // Normalize and validate ticker.
-  const revision = ++companyRevision;
```

Dashboard sort direction:

```diff
-opts.ascending === false ? 'asc' : 'desc'
+opts.ascending === true ? 'asc' : 'desc'
```

Reproduce the fixes with the commands below. These use offline fixtures; the mail test uses Nodemailer's stream transport and sends no email.

```powershell
npm run lint
npm test
npm audit --audit-level=high
python -m http.server 4321 --bind 127.0.0.1 --directory website
# In a second terminal, while the local server is running:
npm run verify:website
git diff --check
```

On this machine, the npm PowerShell launcher selected Node 26 even after changing PATH. Final checks used this explicit invocation, with Node 22 first on PATH for child processes:

```powershell
$node22 = 'C:\Users\shaxii\AppData\Local\npm-cache\_npx\52027bd8fc0022aa\node_modules\node\bin\node.exe'
$npmCli = 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js'
$env:Path = (Split-Path $node22) + ';' + $env:Path
& $node22 $npmCli test
& $node22 $npmCli run lint
& $node22 $npmCli audit --audit-level=high
& $node22 scripts/verify-website.mjs
```

### Failure evidence, before fixes

`npm audit --audit-level=high` exited 1:

```text
# npm audit report

nodemailer  <=10.0.8
Severity: high
Nodemailer: Process-global DNS cache reuses TLS `servername` across transports, enabling cross-tenant SMTP credential disclosure - https://github.com/advisories/GHSA-6vj9-mwq6-2f5v
Nodemailer: Nested structured recipient arrays bypass the parser depth limit and cause stack exhaustion DoS - https://github.com/advisories/GHSA-8vvx-rff5-p5rq
Nodemailer: Quoted local-part can produce malformed envelope recipient through RFC 5322 comment parsing - https://github.com/advisories/GHSA-g57g-f23g-4646
Nodemailer: Quadratic backtracking in the addressparser free-text fallback allows remote denial of service - https://github.com/advisories/GHSA-v53p-9fqp-m79j
Nodemailer addressparser: O(n^2) on comment-joined addresses enables a remote DoS (reachable via mailparser) - https://github.com/advisories/GHSA-prgh-xp8r-p3m5
fix available via `npm audit fix --force`
Will install nodemailer@10.0.15, which is a breaking change
node_modules/nodemailer

1 high severity vulnerability
```

The targeted installation used `npm install nodemailer@10.0.15 --save-exact --ignore-scripts`, not the suggested blanket force fix. It emitted this environment warning, before final verification switched to explicit Node 22:

```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'ai-infra-digest@1.1.0',
npm warn EBADENGINE   required: { node: '22.x' },
npm warn EBADENGINE   current: { node: 'v26.7.0', npm: '11.19.0' }
npm warn EBADENGINE }
```

`& $node22 node_modules/vitest/vitest.mjs run src/collector/rss.test.ts src/sender/email.test.ts` exited 1 before the RSS patch. Verbatim failure excerpts:

```text
FAIL  src/collector/rss.test.ts > fetchFeedWithStatus > aborts stalled response bodies and exhausts the bounded retries
AssertionError: expected +0 to be 3 // Object.is equality

-   "error": "HTTP 503",
+   "error": "Unable to parse XML.",

FAIL  src/collector/rss.test.ts > fetchFeedWithStatus > resets cached failure history when an unchanged feed recovers
AssertionError: expected "vi.fn()" to be called at least once

Tests  3 failed | 20 passed (23)
```

`& $node22 node_modules/vitest/vitest.mjs run src/tests/http-timeouts.integration.test.ts` exited 1 before the deadline additions:

```text
Tests  7 failed (7)
AssertionError: expected false to be true // Object.is equality
```

The seven cases cover stalled SEC submissions, SEC document text, earnings, novelty history, entity metrics, recent metrics, and a metrics write. All seven now settle through their expected failure path within the simulated deadline.

`& $node22 node_modules/vitest/vitest.mjs run src/sender/telegram.routing.test.ts` exited 1 before watchlist validation:

```text
Tests  5 failed | 47 passed (52)
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received: "⚠️ Couldn't save watchlist (Supabase not configured). Your preferences will be used for this session only."
```

The recorded preference writes included `"<B>NVDA</B>"`, `"&"`, an empty list, and a duplicated `NVDA`.

`& $node22 scripts/verify-website.mjs` exited 1 before the reader fixes, reporting the following at every tested width:

```json
"missingConfigHandled": false,
"invalidSearchWon": false
```

The query-order regression also failed before its one-line fix:

```text
Error: Query ordering regression: ["date.desc","date.asc","date.desc","date.asc,id.asc"]
```

Read-only inspection used `gh run view 37253529526 --repo ixtaqq/ai-infra-digest --log-failed`. Its production failure included:

```text
[05/10/2026, 09:58:54] [WARN] No canonical publication is ready for editorial date 2026-10-05
Error: Scheduled delivery incomplete: 0 delivered, 1 failed
##[error]Process completed with exit code 1.
```

The existing, non-blocking Vitest warning remains:

```text
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.
```

Do not change the whole application to ESM solely to silence this warning. A future isolated config migration is sufficient.

## 3. Improvements ranked by impact versus effort

Effort estimates are engineering effort: **S** is roughly 1–2 days, **M** is 3–7 days, and **L** is 2–4 weeks or more. They are planning estimates, not delivery commitments. Success thresholds below are proposed acceptance criteria, not measured current performance.

| Rank | Improvement | Impact / effort | Evidence and trade-off |
| --- | --- | --- | --- |
| 1 | Establish publication and delivery timing targets; add publication-triggered catch-up and choose an appropriate scheduler. | High / M | The October 5 run missed the configured time by hours. `src/scheduler.ts:157` correctly refuses an absent edition. Moving schedules can add operating cost; approval is needed before billable setup. |
| 2 | Make article-processing recovery explicit. Retain inputs through publication and record which articles were actually considered. | High / M | `src/utils/dedup.ts:215` saves all newly seen inputs before selection at `src/pipeline/generate.ts:203` and before AI/publication success. RSS 304 handling retains headers but not bodies. Verify crash/retry behavior before choosing a checkpoint design. More durable input retention has storage and retention costs. |
| 3 | Build the real reviewed editorial benchmark and gate prompt/model changes on it. | High / M | `src/evaluation/benchmark.ts:9` already requires 50 cases; `scripts/evaluate-benchmark.ts:12` already enforces accuracy/error gates. The release notes explicitly say the reviewed corpus is missing. Human annotation is the dependency. |
| 4 | Make feedback insertion and public counters one transaction. | High / M | `src/sender/telegram.ts:894` performs a read-modify-write. Private vote rows used by trust scores are separate from public counters. A service-only RPC needs migration tests and coordinated rollout; historical counters need a separately reviewed reconciliation policy. |
| 5 | Complete enforced-budget activation prerequisites. | High / M | `src/utils/budget-reservations.ts:5` defaults to advisory; enforcement already exists. Verify actual model prices, input ceilings, expiry, and unknown prior usage before enabling it. Unreviewed prices must continue to block calls. |
| 6 | Schedule dependency checks and updates. | High / S | CI audits only when CI runs; `.github/` has no Dependabot configuration. The current security update illustrates the gap. Keep updates reviewable and retain the offline mail test. |
| 7 | Add request/run identifiers and explicit degraded-stage outcomes to logs. | Medium / S | `src/utils/logger.ts:11` emits free-form console lines. Several optional paths return empty results. Structured context would distinguish missing data from unavailable data; never include prompts, keys, webhook URLs, or recipient details. |
| 8 | Batch due-user/history lookup when measured load justifies it. | Medium / M | `src/scheduler.ts:97` loads all active users; `src/scheduler.ts:125` performs one history request per due user. Bounded concurrency protects services but does not remove O(users) requests. Preserve atomic claims. |
| 9 | Strengthen CSP after extracting inline scripts; review production grants as a release check. | Medium / M | `website/vercel.json:14` allows inline script execution. Existing escaping and URL checks are useful, but CSP can provide another boundary. The Supabase public projection already has explicit grants; reverify the actual deployed permissions rather than assuming them. |
| 10 | Expand behavior tests at boundaries, especially votes and restart recovery. | Medium / M | New timeout/browser regressions found gaps despite 488 passing baseline tests. `src/dashboard-security.test.ts` also relies on source-text assertions. Prefer executed behavior and contract checks where a failure can affect readers. |
| 11 | Consolidate current operational truth and Node setup instructions. | Medium / S | README/AGENTS/release notes contain different historical credential states; the latest logs show SMTP success and disabled optional enrichment. Date operational observations and document an explicit Node 22 launcher on Windows. |
| 12 | Extract command and storage domains incrementally when those areas change. | Medium / M | `src/sender/telegram.ts` and `src/utils/supabase.ts` combine many behaviors. Move one tested domain at a time; a framework rewrite would add risk without solving the observed timing or quality problems. |

GitHub documents that scheduled workflows can be delayed or dropped during load. That supports treating Actions schedules as best effort; it does not establish the precise platform cause of the October 5 delay. [GitHub scheduling guidance](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows).

## 4. Feature proposals

These extend the current product; existing `/digest`, watchlists, company evidence, source health, weekly thesis snapshots, and budget tooling are not presented as new features.

| Feature | Reader/operator problem solved | Effort | Impact | Risks or dependencies |
| --- | --- | --- | --- | --- |
| Edition archive and date navigation | Readers can retrieve a particular briefing instead of only the latest edition, making past decisions traceable. | S | High | Reuse public editions; paginate and preserve immutable publication dates. |
| Weekly watchlist change report | Summarize what changed for watched companies across editions, price snapshots, and thesis history, reducing daily-reading burden. | M | High | Separate observed changes from inferred causes; validate missing-week behavior and any additional AI cost. |
| Editorial corrections and follow-up record | Readers can see corrected claims and later evidence attached to the original edition. | M | High | Preserve original publications, date corrections, define who can publish them, and avoid silently rewriting history. |
| Operator recovery console | Show delayed publication, quarantined updates, and uncertain deliveries with evidence needed for a decision. | M | High | Service-only authentication, private audit trail, and explicit reconciliation. Never add a blind replay button. |
| Claim-level source citations | Link factual claims to exact supporting passages so readers can verify generated summaries. | L | High | Source-text retention/licensing, citation validation, human benchmark, and model-cost limits. |
| Private saved research and notes | Let a reader collect articles and annotate company theses across visits. | L | Medium | Website currently exposes public research; private accounts, ownership checks, export/deletion, and retention policies are additional work. |

## 5. Roadmap

### Now: this week, October 6–12

| Title | One-line scope | Effort | Success criterion |
| --- | --- | --- | --- |
| Review and release the repair batch | Ship the security, timeout, watchlist, and reader fixes through the existing release process. | S | CI and browser checks pass; dependency audit remains clean; authorized deployment shows no new send or reader failures. |
| Delivery timing decision and baseline | Agree on publication-ready time, acceptable lateness, and the scheduling runtime. | S | Seven days of publication/delivery timestamps are measurable; late or absent publication is distinguishable from failed delivery. |
| Recovery and vote design | Specify input checkpoint semantics and the atomic vote transaction before schema work. | S | Reviewer-approved failure scenarios cover partial generation, retries, duplicate votes, parallel votes, and uncertain sends. |

### Next: 2–4 weeks

| Title | One-line scope | Effort | Success criterion |
| --- | --- | --- | --- |
| Reliable publication and catch-up | Generate ahead of reader deadlines and connect completed publication to pending-user delivery. | M | Proposed target: at least 95% of due deliveries within 15 minutes for seven days; no duplicate sends in overlap/restart tests. |
| Recoverable ingestion | Persist eligible input/processing state through publication with a defined retention policy. | M | Kill the pipeline after collection, selection, and AI completion; retry retains intended stories without duplicating a published edition. |
| Atomic feedback | Insert each vote and update counters in one database transaction. | M | Duplicate requests change no count; 100 distinct concurrent votes yield exactly 100 increments; injected failure rolls back both changes. |
| Reviewed quality baseline | Annotate at least 50 diverse cases and run the existing evaluator on a frozen baseline. | M | Complete coverage; relevance/ticker accuracy each at least 95%, mean impact error at most 1, and zero annotated unsupported claims, or a documented failing baseline to improve. |
| Budget activation | Validate model pricing and reconcile unknown usage before enabling enforced reservations. | M | Known-price calls reserve before transport; unknown/stale pricing and exhausted budgets block transport; concurrent reservations respect caps. |
| Maintenance and diagnostics | Schedule dependency review, add run identifiers, and reconcile dated setup docs. | S | A dependency check runs without application changes; one run can be traced across stages without secret/user-content exposure. |
| Security and boundary verification | Tighten CSP incrementally and exercise deployed public/private authorization plus vote/restart contracts. | M | Browser journeys pass under the stricter policy; anonymous users cannot read private records or call service-only mutations. |

### Later: 1–3 months

| Title | One-line scope | Effort | Success criterion |
| --- | --- | --- | --- |
| Briefing archive | Add date selection and links to past editions. | S | A reader can open and share a specific edition; pagination and empty dates work. |
| Weekly watchlist recap | Summarize material changes across a reader's watched companies. | M | Every reported change links to dated evidence; absent data is labeled; delivery is idempotent. |
| Correction history | Attach reviewed amendments and outcomes to published stories. | M | Original text remains accessible; readers can identify the correction, author, reason, and timestamp. |
| Recovery console | Add an authenticated UI over the existing operations and reconciliation boundaries. | M | An operator can resolve a documented incident with evidence and an audit record; uncertainty never triggers automatic replay. |
| Scheduler efficiency | Replace repeated history requests with a set-based due-user query if latency measurements justify it. | M | Representative load meets the delivery target while database requests per batch fall and claim-safety tests remain green. |

### Later still: 3+ months

| Title | One-line scope | Effort | Success criterion |
| --- | --- | --- | --- |
| Verifiable claim citations | Persist source passages and link factual summaries to their supporting text. | L | Every factual claim in a reviewed sample resolves to a supporting passage; unsupported claims are flagged before publication. |
| Private research workspace | Add reader-owned saved articles and notes with account and deletion controls. | L | Cross-account access tests fail closed; export and deletion cover all private records; readers can return to saved work. |
| Scale-driven domain extraction | Split large command/storage modules or add a worker queue only when measured needs justify it. | M–L | Existing behavior and safety contracts pass; the targeted latency or maintenance metric measurably improves. |

## 6. Top three recommendations

1. **Review and release the small repair batch.** It removes a known vulnerable dependency and reproducible hangs, malformed-input writes, and reader failures. The application changes are small and have regression evidence.
2. **Fix delivery timing before expanding the feature set.** An 8 AM product whose daily job starts at 12:20 PM fails its core promise even when generation and message transport succeed. Preserve the existing duplicate-prevention policy while improving publication readiness and scheduling.
3. **Invest in a real reviewed editorial benchmark.** More feeds, models, or personalization cannot demonstrate better intelligence. The evaluator already exists; a human-reviewed corpus makes future changes measurable.

I would keep the static website and shared-edition architecture. The evidence favors operational reliability and editorial quality work over a framework migration or broader rewrite.

### Ship-check

```text
Diff:   15 code/config/test files plus this report; focused dependency, deadline, input, and reader repairs
Build:  pass (npm run build, invoked by npm test, Node 22.23.3)
Tests:  pass (npm test, 504 passed / 0 failed across 67 files)
Lint:   pass (npm run lint, both TypeScript projects)
Ran:    stalled-transport, RSS recovery, real offline MIME composition, command-route, and four-width browser regressions
Verdict: ready for code review; hosted rollout and the open operational/database changes remain separate work
```
