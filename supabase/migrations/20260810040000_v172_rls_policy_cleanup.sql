-- v17.2: remove stale broad policies left by the initial/v3 schema and replace
-- auth.role()-based policies with explicit role-scoped policies.

-- Private per-user delivery history.
DROP POLICY IF EXISTS "Allow service full access" ON user_delivery_log;
DROP POLICY IF EXISTS "service_role_access" ON user_delivery_log;
CREATE POLICY "service_role_access" ON user_delivery_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE user_delivery_log FROM anon, authenticated;
GRANT ALL ON TABLE user_delivery_log TO service_role;

-- Private transcript data used only by the backend.
DROP POLICY IF EXISTS "Allow public read access" ON earnings_transcripts;
DROP POLICY IF EXISTS "Allow service full access" ON earnings_transcripts;
DROP POLICY IF EXISTS "service_role_access" ON earnings_transcripts;
CREATE POLICY "service_role_access" ON earnings_transcripts
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE earnings_transcripts FROM anon, authenticated;
GRANT ALL ON TABLE earnings_transcripts TO service_role;

-- SEC extracts remain dashboard-readable, but writes are backend-only.
DROP POLICY IF EXISTS "Allow public read access" ON sec_filings;
DROP POLICY IF EXISTS "Allow service full access" ON sec_filings;
DROP POLICY IF EXISTS "public_read" ON sec_filings;
DROP POLICY IF EXISTS "service_role_write" ON sec_filings;
CREATE POLICY "public_read" ON sec_filings
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write" ON sec_filings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE sec_filings FROM anon, authenticated;
GRANT SELECT ON TABLE sec_filings TO anon, authenticated;
GRANT ALL ON TABLE sec_filings TO service_role;

-- Derived metrics are public analytics; writes remain backend-only.
DROP POLICY IF EXISTS "anon_read_daily_derived_metrics" ON daily_derived_metrics;
DROP POLICY IF EXISTS "service_write_daily_derived_metrics" ON daily_derived_metrics;
DROP POLICY IF EXISTS "public_read" ON daily_derived_metrics;
DROP POLICY IF EXISTS "service_role_write" ON daily_derived_metrics;
CREATE POLICY "public_read" ON daily_derived_metrics
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_role_write" ON daily_derived_metrics
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE daily_derived_metrics FROM anon, authenticated;
GRANT SELECT ON TABLE daily_derived_metrics TO anon, authenticated;
GRANT ALL ON TABLE daily_derived_metrics TO service_role;

-- Individual validation rows contain Telegram chat IDs and are private. Public
-- dashboards read only the aggregate thumbs_up/thumbs_down columns on articles.
DROP POLICY IF EXISTS "anon_read_article_validations" ON article_validations;
DROP POLICY IF EXISTS "service_write_article_validations" ON article_validations;
DROP POLICY IF EXISTS "public_read" ON article_validations;
DROP POLICY IF EXISTS "service_role_write" ON article_validations;
CREATE POLICY "service_role_write" ON article_validations
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE article_validations FROM anon, authenticated;
GRANT ALL ON TABLE article_validations TO service_role;

ALTER FUNCTION public.cleanup_old_data()
  SET search_path = public, pg_temp;
