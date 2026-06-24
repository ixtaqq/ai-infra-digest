-- ============================================================
-- Migration v6: daily_derived_metrics — materialized time-series intelligence
-- Polymorphic table: entity_type IN ('ticker', 'sector')
-- Idempotent via UNIQUE(date, entity_type, entity)
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_derived_metrics (
  id           BIGSERIAL PRIMARY KEY,
  date         DATE        NOT NULL,
  entity_type  TEXT        NOT NULL CHECK (entity_type IN ('ticker', 'sector')),
  entity       TEXT        NOT NULL,

  mention_count     INT           DEFAULT 0,
  avg_sentiment     NUMERIC(5,2),       -- ticker: -1..1 scale; sector: null
  avg_impact_score  NUMERIC(5,2),       -- 1..10 scale
  bullish_count     INT           DEFAULT 0,
  bearish_count     INT           DEFAULT 0,
  price_close       NUMERIC(10,2),      -- ticker only
  price_change_pct  NUMERIC(6,2),       -- ticker only

  calculated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(date, entity_type, entity)
);

-- Fast time-series queries per entity (primary access pattern)
CREATE INDEX IF NOT EXISTS idx_ddm_entity_date
  ON daily_derived_metrics(entity_type, entity, date DESC);

-- Fast "all entities for a date" queries (used by What Changed)
CREATE INDEX IF NOT EXISTS idx_ddm_date
  ON daily_derived_metrics(date DESC);

-- RLS: service role writes, anon reads (matches all other tables)
ALTER TABLE daily_derived_metrics ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "anon_read_daily_derived_metrics"
    ON daily_derived_metrics FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_write_daily_derived_metrics"
    ON daily_derived_metrics FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
