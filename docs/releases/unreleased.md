# Changes since v1.2.0

These changes are on `main` and deployed, but the package version is still `1.2.0`.

## Highlights

- The digest has a new "Why it moved" section. It pairs up to 3 moves of at least 3% with coverage from the same edition. A move with no coverage is left out, and the section says this is coverage and not a proven cause.
- Yahoo Finance, VentureBeat AI, and AI News have new URLs, because the old ones returned 404, 429, and 202 with no feed.
- Tickers the AI invents are now corrected, such as `AWS` to `AMZN` and `MARV` to `MRVL`. Companies with no US listing are dropped.
- Search shows each URL once, and dedup remembers a URL for 30 days, because feeds relist old stories.
- Slack output can no longer rebuild a live `<!channel>` mention from nested markup, and its markup conversion no longer scans repeatedly on unclosed tags.
- Dependencies were updated: `dotenv` 18, `vitest` 5, and the Supabase CLI. Dependabot now ignores major versions of `@types/node` and `node-telegram-bot-api`.
- The project now has a `LICENSE` file.

## Data repair

On November 3, 2026, 1,251 of the 1,307 stock price rows stored before the quote fix were recomputed from Yahoo closes and checked against Nasdaq, which agreed on all of them. The other 56 rows stay at 0%: 21 were really flat, 19 had no second source, 12 had no Yahoo data, and 4 had no matching close. Older copies of these values in `daily_derived_metrics` and `stock_mentions` were left alone, and new rows are correct.

## Deployment and verification

Migration `20261103090000_search_articles_distinct_urls` is applied in production. CI and CodeQL pass on `f24be08`, and CodeQL has no open alerts. Render was resumed after the merge, and the website was not affected.

## Remaining limits

The digest due at 22:17 UTC on November 3, 2026 is the first production run of these changes. The prompt's ticker wording has had no real AI run, and "Why it moved" has not been seen in a real send. The 30-day URL memory depends on the Actions cache persisting between runs.
