import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { benchmarkSchema, sourceTextHash } from "./benchmark";
import { compileReviewedCases, reviewSetSchema } from "./review-set";

const sourceText = "Synthetic source text for an offline test. This fixture is not editorial evidence.";
const rows = Array.from({ length: 50 }, (_, index) => ({
  id: String(index), sourceUrl: `https://example.com/fixture/${index}`, sourceText,
  sourceTextSha256: sourceTextHash(sourceText), sourceName: "Unit test fixture",
  sourceFeedUrl: "https://example.com/feed", capturedAt: "2026-01-01T00:00:00Z",
  publishedAt: null, inputKind: "rss-excerpt" as const, review: null,
}));
const review = { reviewKind: "human" as const, reviewedBy: "Synthetic unit-test reviewer",
  reviewedAt: "2026-01-02T00:00:00Z", relevant: false, tickers: [], impact: 1, supportedClaims: [] };

it("keeps the real source-backed review set structurally valid", () => {
  const path = resolve(__dirname, "../../benchmarks/editorial-review-2026-10-06.json");
  const corpus = reviewSetSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  expect(corpus).toHaveLength(50);
  expect(new Set(corpus.map(row => row.sourceName)).size).toBe(5);
});

it("rejects unreviewed exports and changed source text", () => {
  expect(() => compileReviewedCases(rows)).toThrow("50/50 cases pending");
  expect(() => compileReviewedCases(rows.map((row, index) => ({ ...row, review: index ? review : null })))).toThrow("1/50 cases pending");
  expect(reviewSetSchema.safeParse(rows.map(row => ({ ...row, sourceText: sourceText + " Changed." }))).success).toBe(false);
});

it("requires human review and unique sources, and exports only completed labels", () => {
  const reviewed = rows.map(row => ({ ...row, review }));
  expect(compileReviewedCases(reviewed)).toHaveLength(50);
  expect(reviewSetSchema.safeParse(reviewed.map(row => ({ ...row, review: { ...review, reviewKind: "ai" } }))).success).toBe(false);
  expect(reviewSetSchema.safeParse([...rows.slice(0, 49), rows[0]]).success).toBe(false);
  expect(benchmarkSchema.safeParse(rows).success).toBe(false);
});

it("runs the offline review/export/evaluation commands and rejects mismatched predictions", () => {
  const root = resolve(__dirname, "../..");
  const dir = mkdtempSync(resolve(tmpdir(), "goldirham-benchmark-test-"));
  const candidate = resolve(dir, "candidate.json");
  const reference = resolve(dir, "reference.json");
  const predictions = resolve(dir, "predictions.json");
  const pending = resolve(dir, "pending.json");
  writeFileSync(candidate, JSON.stringify(rows.map(row => ({ ...row, review }))));
  writeFileSync(pending, JSON.stringify(rows));
  const run = (script: string, ...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx", resolve(root, "scripts", script), ...args], { cwd: root, encoding: "utf8", timeout: 15000 });

  const status = run("review-benchmark.ts", "status", pending);
  expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ reviewed: 0, pending: 50, readyForEvaluation: false });
  const refused = run("review-benchmark.ts", "export", pending, reference);
  expect(refused.status).toBe(1);
  expect(refused.stderr).toContain("50/50 cases pending");
  expect(run("review-benchmark.ts", "export", candidate, reference).status).toBe(0);
  const before = readFileSync(reference, "utf8");
  expect(run("review-benchmark.ts", "export", candidate, reference).status).toBe(1);
  expect(readFileSync(reference, "utf8")).toBe(before);

  const outputs = rows.map(row => ({ id: row.id, sourceTextSha256: row.sourceTextSha256,
    relevant: false, tickers: [], impact: 1, unsupportedClaims: 0,
    claimsReviewedBy: "Synthetic unit-test reviewer", claimsReviewedAt: review.reviewedAt, reviewKind: "human" }));
  writeFileSync(predictions, JSON.stringify(outputs));
  const passed = run("evaluate-benchmark.ts", reference, predictions);
  expect(passed.status, passed.stderr).toBe(0);
  expect(JSON.parse(passed.stdout)).toMatchObject({ count: 50, missing: 0, relevanceAccuracy: 1 });

  const mismatched = resolve(dir, "mismatched.json");
  writeFileSync(mismatched, JSON.stringify(outputs.map(row => ({ ...row, sourceTextSha256: "0".repeat(64) }))));
  const failed = run("evaluate-benchmark.ts", reference, mismatched);
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("Prediction input does not match");

  const selfReviewed = resolve(dir, "self-reviewed.json");
  writeFileSync(selfReviewed, JSON.stringify(outputs.map(row => ({ ...row, reviewKind: "ai" }))));
  expect(run("evaluate-benchmark.ts", reference, selfReviewed).status).toBe(1);
}, 20000);
