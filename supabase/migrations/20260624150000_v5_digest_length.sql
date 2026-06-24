-- ============================================================
-- Migration v5: digest_length preference for per-user summary verbosity
-- ============================================================

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS digest_length TEXT DEFAULT 'standard'
    CHECK (digest_length IN ('brief', 'standard', 'detailed'));
