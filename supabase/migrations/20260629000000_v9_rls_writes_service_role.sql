-- ─── Tighten write access: scope "service full access" policies to service_role ──
-- These tables had FOR ALL USING(true) WITH CHECK(true) policies created without
-- a TO clause, which defaults to PUBLIC — meaning the anon key (exposed client-side
-- in the dashboard) could INSERT/UPDATE/DELETE on all of them. Public read access
-- is preserved; only write/delete is now restricted to service_role.

DROP POLICY IF EXISTS "Allow service full access" ON digest_runs;
CREATE POLICY "service_role_write" ON digest_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON articles;
CREATE POLICY "service_role_write" ON articles
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON sector_activity;
CREATE POLICY "service_role_write" ON sector_activity
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON stock_mentions;
CREATE POLICY "service_role_write" ON stock_mentions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON pipeline_health;
CREATE POLICY "service_role_write" ON pipeline_health
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON capex_tracking;
CREATE POLICY "service_role_write" ON capex_tracking
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON ai_usage;
CREATE POLICY "service_role_write" ON ai_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON daily_metrics;
CREATE POLICY "service_role_write" ON daily_metrics
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow service full access" ON stock_prices;
CREATE POLICY "service_role_write" ON stock_prices
  FOR ALL TO service_role USING (true) WITH CHECK (true);
