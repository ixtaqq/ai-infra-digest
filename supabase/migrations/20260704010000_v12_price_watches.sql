-- Price Watch (v12): one-shot informational price threshold pings.
-- See docs/price-watch-design.md and docs/price-watch-implementation-plan.md.

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

-- Per-user private data — service role only, no public read (matches
-- user_preferences/user_delivery_log, not the public_read pattern used for
-- ticker_thesis_history/sec_filings).
CREATE POLICY "service_role_full_access" ON price_watches
  FOR ALL TO service_role USING (true) WITH CHECK (true);
