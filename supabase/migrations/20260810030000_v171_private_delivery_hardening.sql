-- v17.1: remove a stale initial-schema policy that targeted PUBLIC and would
-- expose private delivery destinations despite the later service-role policy.

DROP POLICY IF EXISTS "Allow public read access" ON user_preferences;
DROP POLICY IF EXISTS "Allow read access" ON user_preferences;
DROP POLICY IF EXISTS "Allow service full access" ON user_preferences;
DROP POLICY IF EXISTS "service_role_full_access" ON user_preferences;

CREATE POLICY "service_role_full_access" ON user_preferences
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON TABLE user_preferences FROM anon, authenticated;
GRANT ALL ON TABLE user_preferences TO service_role;

-- Existing projects may give new public-schema views broad default grants.
-- The dashboard needs read-only access to this aggregate view and nothing more.
REVOKE ALL ON TABLE ranking_quality_daily FROM anon, authenticated;
GRANT SELECT ON TABLE ranking_quality_daily TO anon, authenticated;
