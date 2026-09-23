import { z } from "zod";

export const benchmarkCase = z.object({
  id: z.string().min(1), sourceUrl: z.string().url(), sourceText: z.string().min(40),
  reviewedBy: z.string().min(1), reviewedAt: z.string().datetime(),
  relevant: z.boolean(), tickers: z.array(z.string()), impact: z.number().min(1).max(10),
  supportedClaims: z.array(z.string().min(1)),
});
export const benchmarkSchema = z.array(benchmarkCase).min(50).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.id)).size !== rows.length) ctx.addIssue({ code: "custom", message: "Benchmark IDs must be unique" });
});

export function compareBenchmark(expected: z.infer<typeof benchmarkSchema>, actual: { id: string; relevant: boolean; tickers: string[]; impact: number; unsupportedClaims: number }[]) {
  const byId = new Map(actual.map(row => [row.id, row]));
  const expectedIds = new Set(expected.map(row => row.id));
  if (byId.size !== actual.length || actual.some(row => !expectedIds.has(row.id))) {
    throw new Error("Predictions must have unique IDs from the reviewed benchmark");
  }
  let relevanceCorrect = 0, tickerCorrect = 0, impactError = 0, unsupportedClaims = 0, missing = 0;
  for (const row of expected) {
    const prediction = byId.get(row.id);
    if (!prediction) { missing++; continue; }
    if (prediction.relevant === row.relevant) relevanceCorrect++;
    if (JSON.stringify([...prediction.tickers].sort()) === JSON.stringify([...row.tickers].sort())) tickerCorrect++;
    impactError += Math.abs(prediction.impact - row.impact);
    unsupportedClaims += prediction.unsupportedClaims;
  }
  return { count: expected.length, missing, relevanceAccuracy: relevanceCorrect / expected.length,
    tickerAccuracy: tickerCorrect / expected.length, meanImpactError: impactError / Math.max(1, expected.length - missing), unsupportedClaims };
}
