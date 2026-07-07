-- Articles Intelligence Fields (v14): persist the ranking/grounding data that
-- generateDigest() already computes in-memory each run, so it survives past
-- the run and becomes independently queryable (historical confidence trends,
-- backfill passes) instead of being recomputed-and-discarded every time.
-- See TODOS.md [TODO-1].

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS corroboration_count INT,
  ADD COLUMN IF NOT EXISTS grounding_text TEXT,
  ADD COLUMN IF NOT EXISTS effective_score DOUBLE PRECISION;
