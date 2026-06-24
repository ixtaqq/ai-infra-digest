-- ─── Tighten user_preferences: remove public read, service role only ──────
DROP POLICY IF EXISTS "Allow public read access" ON user_preferences;
DROP POLICY IF EXISTS "Allow read access" ON user_preferences;

-- Only service role (backend) can read/write user_preferences
-- Dashboard must read via service key, not anon key
CREATE POLICY "service_role_full_access" ON user_preferences
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── Add explicit service-role-only policies for tables missing RLS ────────

-- user_delivery_log: backend-only, no public access needed
DROP POLICY IF EXISTS "service_role_access" ON user_delivery_log;
CREATE POLICY "service_role_access" ON user_delivery_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- earnings_transcripts: backend-only
DROP POLICY IF EXISTS "service_role_access" ON earnings_transcripts;
CREATE POLICY "service_role_access" ON earnings_transcripts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- sec_filings: allow public read (dashboard uses it), service role for writes
DROP POLICY IF EXISTS "service_role_access" ON sec_filings;
CREATE POLICY "service_role_write" ON sec_filings
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "public_read" ON sec_filings
  FOR SELECT TO anon USING (true);
