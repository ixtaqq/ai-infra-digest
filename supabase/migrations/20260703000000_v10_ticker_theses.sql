-- ─── v10: Bull/Bear Thesis Snapshots ────────────────────────────────────────
-- Per-ticker AI investment narrative, refreshed weekly from accumulated
-- daily_derived_metrics + stock_prices + sec_filings data.

CREATE TABLE IF NOT EXISTS ticker_theses (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE,
  bull_case TEXT NOT NULL,
  bear_case TEXT NOT NULL,
  confidence INT CHECK (confidence BETWEEN 1 AND 10),
  key_drivers JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticker_theses_updated
  ON ticker_theses(updated_at DESC);

ALTER TABLE ticker_theses ENABLE ROW LEVEL SECURITY;

-- Dashboard reads with the anon key; only the pipeline (service_role) writes.
CREATE POLICY "public_read" ON ticker_theses
  FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_write" ON ticker_theses
  FOR ALL TO service_role USING (true) WITH CHECK (true);
