-- v16: persist auditable ranking components and expose validation quality by day.

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS ranking_explanation JSONB;

COMMENT ON COLUMN articles.ranking_explanation IS
  'Versioned breakdown of base score, trust/credibility/corroboration/novelty multipliers, caps, and ranking reasons.';

CREATE OR REPLACE VIEW ranking_quality_daily
WITH (security_invoker = true) AS
SELECT
  created_at::date AS date,
  COUNT(*) FILTER (WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0) AS voted_articles,
  COALESCE(SUM(thumbs_up), 0) AS thumbs_up,
  COALESCE(SUM(thumbs_down), 0) AS thumbs_down,
  CASE
    WHEN COALESCE(SUM(thumbs_up), 0) + COALESCE(SUM(thumbs_down), 0) = 0 THEN NULL
    ELSE ROUND(
      COALESCE(SUM(thumbs_up), 0)::numeric /
      (COALESCE(SUM(thumbs_up), 0) + COALESCE(SUM(thumbs_down), 0)),
      4
    )
  END AS approval_rate,
  ROUND(
    AVG(effective_score) FILTER (
      WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0
    )::numeric,
    3
  ) AS avg_voted_effective_score
FROM articles
GROUP BY created_at::date
HAVING COUNT(*) FILTER (
  WHERE COALESCE(thumbs_up, 0) + COALESCE(thumbs_down, 0) > 0
) > 0;

GRANT SELECT ON ranking_quality_daily TO anon, authenticated;
