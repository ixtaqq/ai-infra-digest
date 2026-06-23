-- ============================================================
-- Migration v3.0: Add missing columns and tables
-- Run this in the Supabase SQL Editor
-- ============================================================

-- digest_runs: add ai_fast_model column (used by two-model routing)
ALTER TABLE digest_runs ADD COLUMN IF NOT EXISTS ai_fast_model TEXT;

-- articles: add is_sec_filing flag
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_sec_filing BOOLEAN DEFAULT FALSE;

-- ── Create tables that may be missing from initial schema setup ──────────────

CREATE TABLE IF NOT EXISTS stock_prices (
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

CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_prices_ticker ON stock_prices(ticker);

CREATE TABLE IF NOT EXISTS sec_filings (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  form_type TEXT NOT NULL CHECK (form_type IN ('8-K', '10-K', '10-Q', '10-K/A', '10-Q/A', '8-K/A')),
  filing_date DATE NOT NULL,
  accession_number TEXT,
  primary_document_url TEXT,
  items TEXT[] DEFAULT '{}',
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
  impact_score INT CHECK (impact_score >= 1 AND impact_score <= 10),
  impact_rationale TEXT,
  key_takeaways TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticker, accession_number)
);

CREATE INDEX IF NOT EXISTS idx_sec_filings_date ON sec_filings(filing_date DESC);
CREATE INDEX IF NOT EXISTS idx_sec_filings_ticker ON sec_filings(ticker);
CREATE INDEX IF NOT EXISTS idx_sec_filings_impact ON sec_filings(impact_score DESC);

CREATE TABLE IF NOT EXISTS earnings_transcripts (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  year INT NOT NULL,
  quarter INT NOT NULL CHECK (quarter >= 1 AND quarter <= 4),
  filing_date DATE,
  revenue_guidance NUMERIC(15,2),
  eps_guidance NUMERIC(10,4),
  capex_guidance NUMERIC(15,2),
  ai_revenue_mentioned NUMERIC(15,2),
  ai_revenue_growth_pct NUMERIC(6,2),
  capex_spend NUMERIC(15,2),
  management_tone TEXT CHECK (management_tone IN ('bullish', 'cautious', 'neutral', 'bearish')),
  tone_confidence INT CHECK (tone_confidence >= 1 AND tone_confidence <= 10),
  tone_key_phrase TEXT,
  risks_mentioned TEXT[] DEFAULT '{}',
  key_takeaways TEXT[],
  segments JSONB,
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ticker, year, quarter)
);

CREATE INDEX IF NOT EXISTS idx_earnings_ticker ON earnings_transcripts(ticker);
CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings_transcripts(filing_date DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_ticker_q ON earnings_transcripts(ticker, year DESC, quarter DESC);

CREATE TABLE IF NOT EXISTS user_delivery_log (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  details TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(chat_id, run_date)
);

CREATE INDEX IF NOT EXISTS idx_delivery_chat_date ON user_delivery_log(chat_id, run_date DESC);

-- daily_metrics: add SEC aggregate columns
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_filings_processed INT DEFAULT 0;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_capex_total NUMERIC(15,2);
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS sec_ai_revenue_total NUMERIC(15,2);

-- ── RLS: enable and grant service_role access to new tables ──────────────────

ALTER TABLE stock_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sec_filings ENABLE ROW LEVEL SECURITY;
ALTER TABLE earnings_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_delivery_log ENABLE ROW LEVEL SECURITY;

-- Public read
DO $$ BEGIN
  CREATE POLICY "Allow public read access" ON stock_prices FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow public read access" ON sec_filings FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow public read access" ON earnings_transcripts FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Full service access
DO $$ BEGIN
  CREATE POLICY "Allow service full access" ON stock_prices FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow service full access" ON sec_filings FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow service full access" ON earnings_transcripts FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Allow service full access" ON user_delivery_log FOR ALL USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
