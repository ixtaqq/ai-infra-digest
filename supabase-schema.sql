-- ============================================================
-- AI Infrastructure Dashboard - Supabase Schema
-- Run this in the Supabase SQL Editor to set up your database
-- ============================================================
--
-- ⚠️ CANONICAL SOURCE: supabase/migrations/ (applied via `npm run db:push`).
-- This file is a convenience snapshot for a one-shot bootstrap and can drift
-- from the incremental migrations. Where they disagree, the migrations win —
-- in particular, later migrations (20260625100000, 20260629000000) TIGHTENED
-- RLS: user_preferences / user_delivery_log lost public read and all write
-- policies were scoped `TO service_role`. Tables below the "v6–v13 additions"
-- marker were added by migration and are reproduced here with current RLS.
-- Note: several columns added to pre-existing tables by earlier migrations
-- (is_sec_filing, bear_case, embedding, thumbs_up/down, etc.) predate this
-- note and are NOT reconciled into the base CREATE TABLE statements below —
-- migrations remain the only fully accurate source for column-level schema.
-- ============================================================

-- 1. DIGEST RUNS — Track each execution of the daily digest
CREATE TABLE digest_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  articles_collected INT DEFAULT 0,
  articles_processed INT DEFAULT 0,
  batches_run INT DEFAULT 0,
  ai_provider TEXT DEFAULT 'groq',
  ai_model TEXT DEFAULT 'openai/gpt-oss-120b',
  total_tokens_used INT DEFAULT 0,
  duration_seconds NUMERIC(10,1) DEFAULT 0,
  error_message TEXT,
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  degraded_stages TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_digest_runs_date ON digest_runs(run_date DESC);

-- 2. ARTICLES — Each article analyzed in a digest run
CREATE TABLE articles (
  id BIGSERIAL PRIMARY KEY,
  digest_run_id BIGINT REFERENCES digest_runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT,
  source TEXT,
  impact TEXT CHECK (impact IN ('Bullish', 'Bearish', 'Neutral')),
  impact_score INT CHECK (impact_score >= 1 AND impact_score <= 10),
  category TEXT,
  affected_stocks TEXT[],
  summary TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_articles_run ON articles(digest_run_id);
CREATE INDEX idx_articles_category ON articles(category);
CREATE INDEX idx_articles_impact ON articles(impact_score DESC);

-- 3. SECTOR ACTIVITY — Daily news count per sector
CREATE TABLE sector_activity (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  sector TEXT NOT NULL,
  article_count INT DEFAULT 0,
  avg_impact_score NUMERIC(3,1) DEFAULT 0,
  bullish_count INT DEFAULT 0,
  bearish_count INT DEFAULT 0,
  neutral_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, sector)
);

CREATE INDEX idx_sector_date ON sector_activity(date DESC);

-- 4. STOCK MENTIONS — Track how often each ticker is mentioned
CREATE TABLE stock_mentions (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  ticker TEXT NOT NULL,
  mention_count INT DEFAULT 0,
  avg_sentiment NUMERIC(3,1) DEFAULT 0, -- -1 to 1 scale
  avg_impact_score NUMERIC(3,1) DEFAULT 0,
  price NUMERIC(10,2),
  price_change_percent NUMERIC(6,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, ticker)
);

CREATE INDEX idx_mentions_date ON stock_mentions(date DESC);

-- 5. PIPELINE HEALTH — RSS feed status per run
CREATE TABLE pipeline_health (
  id BIGSERIAL PRIMARY KEY,
  digest_run_id BIGINT REFERENCES digest_runs(id) ON DELETE CASCADE,
  feed_name TEXT NOT NULL,
  feed_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  articles_fetched INT DEFAULT 0,
  error_message TEXT,
  response_time_ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pipeline_run ON pipeline_health(digest_run_id);

-- 6. CAPEX TRACKING — AI infrastructure spending announcements
CREATE TABLE capex_tracking (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  company TEXT NOT NULL,
  amount TEXT, -- e.g. "$10B"
  description TEXT,
  category TEXT CHECK (category IN ('Datacenter', 'GPU Cluster', 'R&D', 'Partnership', 'Other')),
  source_url TEXT,
  source_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_capex_date ON capex_tracking(date DESC);

-- 7. AI USAGE — Track API costs and performance
CREATE TABLE ai_usage (
  id BIGSERIAL PRIMARY KEY,
  digest_run_id BIGINT REFERENCES digest_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INT DEFAULT 0,
  completion_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  response_time_ms INT,
  cost_estimated NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ai_usage_run ON ai_usage(digest_run_id);

-- 8. DASHBOARD METRICS — Pre-computed daily snapshot for fast dashboard loading
CREATE TABLE daily_metrics (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE UNIQUE,
  total_articles_processed INT DEFAULT 0,
  total_stocks_tracked INT DEFAULT 0,
  sectors_active INT DEFAULT 0,
  feeds_healthy INT DEFAULT 0,
  feeds_failing INT DEFAULT 0,
  total_tokens_used INT DEFAULT 0,
  estimated_cost NUMERIC(10,6) DEFAULT 0,
  total_capex_announced NUMERIC(15,2) DEFAULT 0,
  top_sector TEXT,
  top_ticker TEXT,
  digest_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_daily_metrics_date ON daily_metrics(date DESC);

-- 9. STOCK PRICES — Daily price snapshots for tracked tickers (from Yahoo Finance)
CREATE TABLE stock_prices (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  ticker TEXT NOT NULL,
  price NUMERIC(10,2),
  change NUMERIC(10,2),
  change_percent NUMERIC(6,2),
  previous_close NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, ticker)
);

CREATE INDEX idx_stock_prices_date ON stock_prices(date DESC);
CREATE INDEX idx_stock_prices_ticker ON stock_prices(ticker);

-- 10. SEC FILINGS — Tracked SEC filing analysis from EDGAR
CREATE TABLE sec_filings (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('8-K', '10-K', '10-Q', '10-K/A', '10-Q/A', '8-K/A')),
  filing_date DATE NOT NULL,
  accession_number TEXT,
  primary_document_url TEXT,
  items TEXT[] DEFAULT '{}',

  -- Extracted financial data
  capex NUMERIC(15,2),
  capex_guidance NUMERIC(15,2),
  capex_source TEXT,
  ai_revenue NUMERIC(15,2),
  ai_revenue_growth_pct NUMERIC(6,2),
  ai_revenue_source TEXT,
  gross_margin NUMERIC(5,2),
  operating_margin NUMERIC(5,2),
  margin_source TEXT,
  inventory NUMERIC(15,2),
  inventory_turnover NUMERIC(10,2),
  inventory_source TEXT,
  revenue_guidance NUMERIC(15,2),
  eps_guidance NUMERIC(10,4),
  guidance_text TEXT,

  -- Impact assessment
  impact_score INT CHECK (impact_score >= 1 AND impact_score <= 10),
  impact_rationale TEXT,
  key_takeaways TEXT[],

  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticker, accession_number)
);

CREATE INDEX idx_sec_filings_date ON sec_filings(filing_date DESC);
CREATE INDEX idx_sec_filings_ticker ON sec_filings(ticker);
CREATE INDEX idx_sec_filings_impact ON sec_filings(impact_score DESC);

-- Add SEC columns to daily_metrics
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_filings_processed INT DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_capex_total NUMERIC(15,2);
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_ai_revenue_total NUMERIC(15,2);

-- 11. USER PREFERENCES — Interactive Telegram bot user settings
CREATE TABLE user_preferences (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  watchlist TEXT[] DEFAULT '{}',
  preferred_time TEXT DEFAULT '08:00',
  timezone TEXT DEFAULT 'Asia/Kuala_Lumpur',
  categories_enabled TEXT[] DEFAULT '{}',
  min_impact_score INT DEFAULT 0 CHECK (min_impact_score >= 0 AND min_impact_score <= 10),
  alerts_enabled BOOLEAN DEFAULT FALSE,
  alerts_min_score INT DEFAULT 8 CHECK (alerts_min_score >= 1 AND alerts_min_score <= 10),
  delivery_email TEXT,
  slack_webhook_url TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_preferences_chat ON user_preferences(chat_id);

-- 12. EARNINGS TRANSCRIPTS — Analyzed earnings call transcript data
CREATE TABLE earnings_transcripts (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  year INT NOT NULL,
  quarter INT NOT NULL CHECK (quarter >= 1 AND quarter <= 4),
  filing_date DATE,

  -- Extracted financial data
  revenue_guidance NUMERIC(15,2),
  eps_guidance NUMERIC(10,4),
  capex_guidance NUMERIC(15,2),
  ai_revenue_mentioned NUMERIC(15,2),
  ai_revenue_growth_pct NUMERIC(6,2),
  capex_spend NUMERIC(15,2),

  -- Management tone
  management_tone TEXT CHECK (management_tone IN ('bullish', 'cautious', 'neutral', 'bearish')),
  tone_confidence INT CHECK (tone_confidence >= 1 AND tone_confidence <= 10),
  tone_key_phrase TEXT,
  risks_mentioned TEXT[] DEFAULT '{}',

  -- Analysis results
  key_takeaways TEXT[],
  segments JSONB,
  summary TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticker, year, quarter)
);

CREATE INDEX idx_earnings_ticker ON earnings_transcripts(ticker);
CREATE INDEX idx_earnings_date ON earnings_transcripts(filing_date DESC);
CREATE INDEX idx_earnings_ticker_q ON earnings_transcripts(ticker, year DESC, quarter DESC);

-- 13. USER DELIVERY LOG — Per-user digest delivery tracking
CREATE TABLE user_delivery_log (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, run_date)
);

CREATE INDEX idx_delivery_chat_date ON user_delivery_log(chat_id, run_date DESC);

-- Enable Row Level Security (optional - for authenticated access)
ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE capex_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

-- Allow public read access (for dashboard) - adjust as needed
CREATE POLICY "Allow public read access" ON digest_runs FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON articles FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON sector_activity FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON stock_mentions FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON pipeline_health FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON capex_tracking FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON ai_usage FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON daily_metrics FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON stock_prices FOR SELECT USING (true);
-- user_preferences is intentionally private; it may contain delivery email
-- addresses and Slack webhook URLs. Service-role access is declared below.

-- Allow service_role full access (for pipeline writes)
-- NOTE: scoped TO service_role explicitly (see migration 20260629000000) — omitting
-- the TO clause defaults to PUBLIC and lets the client-exposed anon key write/delete.
CREATE POLICY "service_role_write" ON digest_runs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON articles FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON sector_activity FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON stock_mentions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON pipeline_health FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON capex_tracking FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON ai_usage FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON daily_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_write" ON stock_prices FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_full_access" ON user_preferences FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE user_preferences FROM anon, authenticated;
GRANT ALL ON TABLE user_preferences TO service_role;

-- ============================================================
-- v6–v13 additions (reproduced from supabase/migrations/ — canonical there)
-- ============================================================

-- v6. DAILY DERIVED METRICS — materialized per-ticker/per-sector time series
CREATE TABLE IF NOT EXISTS daily_derived_metrics (
  id           BIGSERIAL PRIMARY KEY,
  date         DATE        NOT NULL,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('ticker', 'sector')),
  entity       TEXT        NOT NULL,
  mention_count     INT           DEFAULT 0,
  avg_sentiment     NUMERIC(5,2),
  avg_impact_score  NUMERIC(5,2),
  bullish_count     INT           DEFAULT 0,
  bearish_count     INT           DEFAULT 0,
  price_close       NUMERIC(10,2),
  price_change_pct  NUMERIC(6,2),
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date, entity_type, entity)
);
CREATE INDEX IF NOT EXISTS idx_ddm_entity_date ON daily_derived_metrics(entity_type, entity, date DESC);
CREATE INDEX IF NOT EXISTS idx_ddm_date ON daily_derived_metrics(date DESC);
ALTER TABLE daily_derived_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON daily_derived_metrics FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write" ON daily_derived_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

-- v7. ARTICLE VALIDATIONS — per-user 👍/👎 vote log (thumbs_up/down live on articles)
CREATE TABLE IF NOT EXISTS article_validations (
  id         BIGSERIAL PRIMARY KEY,
  article_id BIGINT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chat_id    BIGINT NOT NULL,
  rating     TEXT   NOT NULL CHECK (rating IN ('up', 'down')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(article_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_av_article ON article_validations(article_id);
ALTER TABLE article_validations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_write" ON article_validations FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE article_validations FROM anon, authenticated;
GRANT ALL ON TABLE article_validations TO service_role;

-- v10. TICKER THESES — latest-only bull/bear snapshot per ticker
CREATE TABLE IF NOT EXISTS ticker_theses (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  bull_case TEXT NOT NULL,
  bear_case TEXT NOT NULL,
  confidence INT CHECK (confidence BETWEEN 1 AND 10),
  key_drivers JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticker_theses_updated ON ticker_theses(updated_at DESC);
ALTER TABLE ticker_theses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON ticker_theses FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_write" ON ticker_theses FOR ALL TO service_role USING (true) WITH CHECK (true);

-- v11. TICKER THESIS HISTORY — every weekly snapshot kept (timeline source)
CREATE TABLE IF NOT EXISTS ticker_thesis_history (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  bull_case TEXT NOT NULL,
  bear_case TEXT NOT NULL,
  confidence INT CHECK (confidence BETWEEN 1 AND 10),
  key_drivers JSONB DEFAULT '[]'::jsonb,
  week_of DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticker, week_of)
);
CREATE INDEX IF NOT EXISTS idx_ticker_thesis_history_ticker_week ON ticker_thesis_history(ticker, week_of DESC);
ALTER TABLE ticker_thesis_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON ticker_thesis_history FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_write" ON ticker_thesis_history FOR ALL TO service_role USING (true) WITH CHECK (true);

-- v12. PRICE WATCHES — one-shot per-user price thresholds (private, service-role only)
CREATE TABLE IF NOT EXISTS price_watches (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  ticker TEXT NOT NULL,
  threshold DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, ticker)
);
CREATE INDEX IF NOT EXISTS idx_price_watches_chat_ticker ON price_watches(chat_id, ticker);
ALTER TABLE price_watches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON price_watches FOR ALL TO service_role USING (true) WITH CHECK (true);

-- v13. COMMAND USAGE — append-only bot-command invocation log (private, service-role only)
CREATE TABLE IF NOT EXISTS command_usage (
  id BIGSERIAL PRIMARY KEY,
  command TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_command_usage_command_created ON command_usage(command, created_at DESC);
ALTER TABLE command_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON command_usage FOR ALL TO service_role USING (true) WITH CHECK (true);

-- v14. ARTICLES INTELLIGENCE FIELDS — persist ranking/grounding data computed
-- in-memory each pipeline run (was ephemeral; see TODOS.md TODO-1)
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS corroboration_count INT,
  ADD COLUMN IF NOT EXISTS grounding_text TEXT,
  ADD COLUMN IF NOT EXISTS effective_score DOUBLE PRECISION;

-- v16. RANKING EXPLANATIONS + VALIDATION QUALITY
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS ranking_explanation JSONB;

CREATE OR REPLACE VIEW ranking_quality_daily
WITH (security_invoker = true) AS
SELECT
  created_at::date AS date,
  COUNT(*) FILTER (WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0) AS voted_articles,
  COALESCE(SUM(thumbs_up), 0) AS thumbs_up,
  COALESCE(SUM(thumbs_down), 0) AS thumbs_down,
  CASE
    WHEN COALESCE(SUM(thumbs_up), 0) + COALESCE(SUM(thumbs_down), 0) = 0 THEN NULL
    ELSE ROUND(COALESCE(SUM(thumbs_up), 0)::numeric / (COALESCE(SUM(thumbs_up), 0) + COALESCE(SUM(thumbs_down), 0)), 4)
  END AS approval_rate,
  ROUND(AVG(effective_score) FILTER (WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0)::numeric, 3) AS avg_voted_effective_score
FROM articles
GROUP BY created_at::date
HAVING COUNT(*) FILTER (WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0) > 0;

REVOKE ALL ON TABLE ranking_quality_daily FROM anon, authenticated;
GRANT SELECT ON TABLE ranking_quality_daily TO anon, authenticated;

-- v17.2. FINAL PRIVATE/PUBLIC ACCESS CLEANUP
DROP POLICY IF EXISTS "Allow service full access" ON user_delivery_log;
DROP POLICY IF EXISTS "Allow public read access" ON earnings_transcripts;
DROP POLICY IF EXISTS "Allow service full access" ON earnings_transcripts;
DROP POLICY IF EXISTS "Allow service full access" ON sec_filings;
REVOKE ALL ON TABLE user_delivery_log FROM anon, authenticated;
REVOKE ALL ON TABLE earnings_transcripts FROM anon, authenticated;
ALTER FUNCTION public.cleanup_old_data() SET search_path = public, pg_temp;

-- v17.3. PUBLIC DELIVERY AGGREGATES (no chat IDs or destination details)
CREATE TABLE IF NOT EXISTS delivery_metrics_daily (
  run_date DATE PRIMARY KEY,
  total_deliveries INT NOT NULL DEFAULT 0 CHECK (total_deliveries >= 0),
  successful_deliveries INT NOT NULL DEFAULT 0 CHECK (successful_deliveries >= 0),
  failed_deliveries INT NOT NULL DEFAULT 0 CHECK (failed_deliveries >= 0),
  unique_users INT NOT NULL DEFAULT 0 CHECK (unique_users >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE delivery_metrics_daily ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read" ON delivery_metrics_daily
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write" ON delivery_metrics_daily
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE delivery_metrics_daily FROM anon, authenticated;
GRANT SELECT ON TABLE delivery_metrics_daily TO anon, authenticated;
GRANT ALL ON TABLE delivery_metrics_daily TO service_role;
