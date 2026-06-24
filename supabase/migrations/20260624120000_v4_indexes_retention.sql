-- ============================================================
-- Migration v4: Performance indexes + data retention policy
-- ============================================================

-- ── Additional indexes for common dashboard & API query patterns ─────────────

-- articles: sorted by recency (dashboard default sort)
CREATE INDEX IF NOT EXISTS idx_articles_created_at
  ON articles(created_at DESC);

-- articles: filter by source (used in dashboard article table)
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles(source);

-- articles: partial index for SEC filing articles (small, fast filter)
CREATE INDEX IF NOT EXISTS idx_articles_sec_filing
  ON articles(created_at DESC)
  WHERE is_sec_filing = true;

-- articles: composite for high-impact recent (dashboard "top articles" query)
CREATE INDEX IF NOT EXISTS idx_articles_impact_created
  ON articles(impact_score DESC, created_at DESC);

-- articles: full-text search (title + summary + source + category)
CREATE INDEX IF NOT EXISTS idx_articles_fts
  ON articles USING gin(
    to_tsvector('english',
      coalesce(title, '') || ' ' ||
      coalesce(summary, '') || ' ' ||
      coalesce(source, '') || ' ' ||
      coalesce(category, '')
    )
  );

-- digest_runs: filter by status (find failed/running runs quickly)
CREATE INDEX IF NOT EXISTS idx_digest_runs_status
  ON digest_runs(status, run_date DESC);

-- pipeline_health: status per feed (feed health dashboard)
CREATE INDEX IF NOT EXISTS idx_pipeline_health_feed_status
  ON pipeline_health(feed_name, status, created_at DESC);

-- sector_activity: per-sector trend queries
CREATE INDEX IF NOT EXISTS idx_sector_activity_sector
  ON sector_activity(sector, date DESC);

-- stock_mentions: per-ticker history (stock detail view)
CREATE INDEX IF NOT EXISTS idx_stock_mentions_ticker
  ON stock_mentions(ticker, date DESC);

-- stock_prices: composite ticker+date (most common lookup pattern)
CREATE INDEX IF NOT EXISTS idx_stock_prices_ticker_date
  ON stock_prices(ticker, date DESC);

-- user_delivery_log: cleanup queries by date
CREATE INDEX IF NOT EXISTS idx_delivery_log_run_date
  ON user_delivery_log(run_date DESC);

-- user_preferences: active users query (scheduler hot path)
CREATE INDEX IF NOT EXISTS idx_user_prefs_active
  ON user_preferences(is_active, preferred_time)
  WHERE is_active = true;

-- ── Data retention policy ────────────────────────────────────────────────────
-- Keeps storage bounded on the free Supabase tier (500 MB limit).
-- Run manually or schedule via pg_cron (Dashboard → Database → Extensions → pg_cron).

CREATE OR REPLACE FUNCTION cleanup_old_data() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  deleted_articles      INT;
  deleted_pipeline      INT;
  deleted_ai_usage      INT;
  deleted_delivery_log  INT;
  deleted_capex         INT;
BEGIN
  -- Articles: keep 90 days (high volume — ~25/day = ~2,250 rows/90d)
  DELETE FROM articles
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_articles = ROW_COUNT;

  -- Pipeline health: keep 30 days (operational logs, high volume)
  DELETE FROM pipeline_health
  WHERE created_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted_pipeline = ROW_COUNT;

  -- AI usage: keep 90 days
  DELETE FROM ai_usage
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_ai_usage = ROW_COUNT;

  -- Delivery log: keep 90 days (idempotency window is 1 day, 90d is generous)
  DELETE FROM user_delivery_log
  WHERE created_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_delivery_log = ROW_COUNT;

  -- Capex tracking: keep 365 days
  DELETE FROM capex_tracking
  WHERE created_at < NOW() - INTERVAL '365 days';
  GET DIAGNOSTICS deleted_capex = ROW_COUNT;

  -- Tables kept indefinitely (small or analytically valuable):
  -- digest_runs, sector_activity, stock_mentions, stock_prices,
  -- daily_metrics, sec_filings, earnings_transcripts, user_preferences

  RAISE NOTICE 'Retention cleanup: articles=%, pipeline_health=%, ai_usage=%, delivery_log=%, capex=%',
    deleted_articles, deleted_pipeline, deleted_ai_usage, deleted_delivery_log, deleted_capex;
END;
$$;

-- ── Optional: schedule via pg_cron (run once at 3 AM UTC daily) ──────────────
-- Requires pg_cron extension. Enable it in Supabase Dashboard →
-- Database → Extensions → pg_cron, then uncomment the lines below:
--
-- SELECT cron.schedule(
--   'daily-data-retention',
--   '0 3 * * *',
--   $$ SELECT cleanup_old_data(); $$
-- );
