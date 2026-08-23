import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260819112411_canonical_digest_publications.sql"
  ),
  "utf8"
);
const feedbackMigration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260823074758_private_digest_feedback.sql"
  ),
  "utf8"
);

describe("canonical publication migration security contract", () => {
  it("keeps publications immutable and service-role-only", () => {
    expect(migration).toMatch(/publication_date DATE NOT NULL UNIQUE/);
    expect(migration).toMatch(/ALTER TABLE public\.digest_publications ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE public\.digest_publications TO service_role/
    );
    expect(migration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE)[^;]*digest_publications[^;]*service_role/i
    );
  });

  it("exposes explicit dashboard columns without raw run errors", () => {
    const digestRunGrant = migration.match(
      /GRANT SELECT \(([\s\S]*?)\) ON public\.digest_runs TO anon, authenticated;/
    )?.[1];
    expect(digestRunGrant).toBeTruthy();
    expect(digestRunGrant).not.toContain("error_message");
    expect(migration).toMatch(/REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated/);
  });

  it("restricts privacy RPCs and rejects null verification hashes", () => {
    expect(migration).toMatch(/p_code_hash IS NULL/);
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.delete_user_data\(BIGINT\)[\s\S]*?FROM PUBLIC, anon, authenticated/
    );
    expect(migration).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.verify_delivery_email\(BIGINT, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/
    );
  });
});

describe("private feedback migration security contract", () => {
  it("archives legacy feedback before removing the public raw-comment column", () => {
    expect(feedbackMigration).toMatch(/INSERT INTO public\.digest_feedback[\s\S]*FROM public\.daily_metrics/);
    expect(feedbackMigration).toMatch(/ALTER TABLE public\.daily_metrics DROP COLUMN IF EXISTS feedback_ratings/);
    expect(feedbackMigration).toMatch(/legacy_payload TEXT/);
    expect(feedbackMigration).toMatch(/source IN \('telegram', 'legacy_daily_metrics'\)/);
    expect(feedbackMigration).toMatch(/WHERE value <> '' AND length\(value\) <= 2000/);
    expect(feedbackMigration).toMatch(/Preserve valid ratings even when the legacy comments field is bad/);
    expect(feedbackMigration).toMatch(/Oversized\/malformed comments are omitted/);
    expect((feedbackMigration.match(/EXCEPTION WHEN others THEN/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps individual feedback service-role-only and exposes only aggregates", () => {
    expect(feedbackMigration).toMatch(/ALTER TABLE public\.digest_feedback ENABLE ROW LEVEL SECURITY/);
    expect(feedbackMigration).toMatch(/CREATE POLICY "service_role_access" ON public\.digest_feedback/);
    expect(feedbackMigration).toMatch(/REVOKE ALL ON TABLE public\.digest_feedback FROM PUBLIC, anon, authenticated/);
    expect(feedbackMigration).toMatch(/GRANT ALL ON TABLE public\.digest_feedback TO service_role/);
    expect(feedbackMigration).toMatch(/REVOKE ALL ON SEQUENCE public\.digest_feedback_id_seq FROM PUBLIC, anon, authenticated/);
    expect(feedbackMigration).toMatch(/CREATE TABLE public\.digest_feedback_daily/);
    expect(feedbackMigration).toMatch(/FOR SELECT TO anon, authenticated USING \(total_votes >= 5\)/);
    expect(feedbackMigration).toMatch(/GRANT SELECT ON TABLE public\.digest_feedback_daily TO anon, authenticated/);
    expect(feedbackMigration).not.toMatch(/GRANT[^;]*public\.digest_feedback(?:\s|\)|;)[^;]*TO anon|GRANT[^;]*public\.digest_feedback(?:\s|\)|;)[^;]*TO authenticated/i);
  });

  it("uses a service-only atomic feedback RPC and covers deletion and retention", () => {
    expect(feedbackMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.submit_digest_feedback\(/);
    expect(feedbackMigration).toMatch(/INSERT INTO public\.digest_feedback_daily[\s\S]*ON CONFLICT \(feedback_date\) DO UPDATE/);
    expect(feedbackMigration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.submit_digest_feedback\(BIGINT, DATE, SMALLINT, TEXT\)[\s\S]*FROM PUBLIC, anon, authenticated/);
    expect(feedbackMigration).toMatch(/DELETE FROM public\.digest_feedback WHERE chat_id = p_chat_id/);
    expect(feedbackMigration).toMatch(/DELETE FROM public\.digest_feedback[\s\S]*INTERVAL '180 days'/);
    expect(feedbackMigration).toMatch(/DELETE FROM public\.digest_feedback_daily[\s\S]*INTERVAL '180 days'/);
  });
});
