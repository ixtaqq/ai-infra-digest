-- ─── v11: Thesis Evolution History ──────────────────────────────────────────
-- Insert-or-overwrite-per-week history for the weekly bull/bear thesis
-- (ticker_theses stays latest-only, UNIQUE(ticker), untouched by this migration).
-- Answers "is my thesis on this ticker strengthening or weakening over time" —
-- see docs/thesis-evolution-design.md / docs/thesis-evolution-implementation-plan.md.

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

CREATE INDEX IF NOT EXISTS idx_ticker_thesis_history_ticker_week
  ON ticker_thesis_history(ticker, week_of DESC);

ALTER TABLE ticker_thesis_history ENABLE ROW LEVEL SECURITY;

-- Dashboard reads with the anon key; only the pipeline (service_role) writes —
-- same policy shape as ticker_theses.
CREATE POLICY "public_read" ON ticker_thesis_history
  FOR SELECT TO anon USING (true);
CREATE POLICY "service_role_write" ON ticker_thesis_history
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- No retention policy — this table's entire purpose is to be the history
-- data-retention.yml prunes away everywhere else. Kept forever by design.
