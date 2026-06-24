-- ============================================================
-- Migration v7: article_validations — per-user article feedback
-- Adds thumbs_up/thumbs_down aggregate counts to articles.
-- Records individual votes for dedup + analytics.
-- ============================================================

-- Aggregate counters on the articles row (fast dashboard read)
ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS thumbs_up   INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thumbs_down INT DEFAULT 0;

-- Per-user vote log (UNIQUE prevents double-voting)
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

DO $$ BEGIN
  CREATE POLICY "anon_read_article_validations"
    ON article_validations FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "service_write_article_validations"
    ON article_validations FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
