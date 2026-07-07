-- Command Usage (v13): durable per-invocation log of interactive bot commands.
-- Append-only — one row per command invocation. Powers "does feature X actually
-- get used?" diagnostics (e.g. the open Price Watch adoption question) with data
-- that survives across ephemeral CI/runner filesystems, unlike the NDJSON logs.
-- See docs/price-watch-design.md "The Assignment".

CREATE TABLE IF NOT EXISTS command_usage (
  id BIGSERIAL PRIMARY KEY,
  command TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_command_usage_command_created ON command_usage(command, created_at DESC);

ALTER TABLE command_usage ENABLE ROW LEVEL SECURITY;

-- Service-role only — usage data is private, no dashboard/anon read (matches
-- user_preferences/user_delivery_log/price_watches, not the public-read tables).
CREATE POLICY "service_role_full_access" ON command_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);
