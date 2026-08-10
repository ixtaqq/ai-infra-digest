ALTER TABLE digest_runs
  ADD COLUMN IF NOT EXISTS capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS degraded_stages TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN digest_runs.capabilities IS
  'Configured and runtime state for optional pipeline capabilities; contains no credentials.';
COMMENT ON COLUMN digest_runs.degraded_stages IS
  'Capabilities that were configured but failed or produced unusable output during this run.';
