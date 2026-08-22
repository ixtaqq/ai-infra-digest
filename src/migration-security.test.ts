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
