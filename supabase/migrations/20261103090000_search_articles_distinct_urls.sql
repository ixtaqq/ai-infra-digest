-- articles keeps one row per run, so a story analyzed on several days matched
-- search once per day. Results now show each URL once, using its newest row.
CREATE OR REPLACE FUNCTION public.search_articles(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH search_query AS (
    SELECT websearch_to_tsquery('english', LEFT(COALESCE(p_query, ''), 80)) AS value
  ),
  matched AS (
    SELECT DISTINCT ON (COALESCE(NULLIF(a.url, ''), a.id::TEXT))
      a.id,
      a.title,
      a.url,
      a.source,
      a.impact,
      a.impact_score,
      a.effective_score,
      a.ranking_explanation,
      a.is_sec_filing,
      a.category,
      a.affected_stocks,
      a.summary,
      a.reason,
      a.bear_case,
      a.thumbs_up,
      a.thumbs_down,
      a.created_at,
      ts_rank(
        to_tsvector(
          'english',
          COALESCE(a.title, '') || ' ' ||
          COALESCE(a.summary, '') || ' ' ||
          COALESCE(a.source, '') || ' ' ||
          COALESCE(a.category, '')
        ),
        q.value
      ) AS search_rank
    FROM public.articles AS a
    CROSS JOIN search_query AS q
    WHERE numnode(q.value) > 0
      AND to_tsvector(
        'english',
        COALESCE(a.title, '') || ' ' ||
        COALESCE(a.summary, '') || ' ' ||
        COALESCE(a.source, '') || ' ' ||
        COALESCE(a.category, '')
      ) @@ q.value
    ORDER BY COALESCE(NULLIF(a.url, ''), a.id::TEXT), a.created_at DESC, a.id DESC
  ),
  page AS (
    SELECT
      id,
      title,
      url,
      source,
      impact,
      impact_score,
      effective_score,
      ranking_explanation,
      is_sec_filing,
      category,
      affected_stocks,
      summary,
      reason,
      bear_case,
      thumbs_up,
      thumbs_down,
      created_at
    FROM matched
    ORDER BY search_rank DESC, impact_score DESC NULLS LAST, created_at DESC, id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'articles', COALESCE((SELECT jsonb_agg(to_jsonb(page)) FROM page), '[]'::jsonb),
    'total', (SELECT COUNT(*) FROM matched)
  );
$$;
