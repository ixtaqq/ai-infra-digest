-- ============================================================
-- AI Infrastructure Dashboard - Supabase Schema
-- Run this in the Supabase SQL Editor to set up your database
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
  ai_model TEXT DEFAULT 'llama-3.3-70b-versatile',
  total_tokens_used INT DEFAULT 0,
  duration_seconds NUMERIC(10,1) DEFAULT 0,
  error_message TEXT,
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

-- Enable Row Level Security (optional - for authenticated access)
ALTER TABLE digest_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sector_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE capex_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_metrics ENABLE ROW LEVEL SECURITY;

-- Allow public read access (for dashboard) - adjust as needed
CREATE POLICY "Allow public read access" ON digest_runs FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON articles FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON sector_activity FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON stock_mentions FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON pipeline_health FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON capex_tracking FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON ai_usage FOR SELECT USING (true);
CREATE POLICY "Allow public read access" ON daily_metrics FOR SELECT USING (true);

-- Allow service_role full access (for pipeline writes)
CREATE POLICY "Allow service full access" ON digest_runs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON articles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON sector_activity FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON stock_mentions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON pipeline_health FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON capex_tracking FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON ai_usage FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service full access" ON daily_metrics FOR ALL USING (true) WITH CHECK (true);
