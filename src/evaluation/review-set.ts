import { z } from "zod";
import { benchmarkCase, benchmarkSchema, sourceTextHash } from "./benchmark";

const review = benchmarkCase.omit({ id: true, sourceUrl: true, sourceText: true });
export const reviewCandidate = z.object({
  id: z.string().min(1), sourceUrl: z.string().url(), sourceText: z.string().min(40),
  sourceTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceName: z.string().min(1), sourceFeedUrl: z.string().url(),
  capturedAt: z.string().datetime(), publishedAt: z.string().datetime().nullable(),
  inputKind: z.literal("rss-excerpt"), review: review.nullable(),
}).superRefine((row, ctx) => {
  if (row.sourceTextSha256 !== sourceTextHash(row.sourceText)) {
    ctx.addIssue({ code: "custom", message: `Source text hash mismatch for ${row.id}` });
  }
});

export const reviewSetSchema = z.array(reviewCandidate).min(50).superRefine((rows, ctx) => {
  if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.sourceUrl)).size !== rows.length) {
    ctx.addIssue({ code: "custom", message: "Review set IDs and source URLs must be unique" });
  }
});

export function compileReviewedCases(input: unknown): z.infer<typeof benchmarkSchema> {
  const rows = reviewSetSchema.parse(input);
  const pending = rows.filter(row => row.review === null).length;
  if (pending) throw new Error(`Human review incomplete: ${pending}/${rows.length} cases pending`);
  return benchmarkSchema.parse(rows.map(row => ({ ...row, ...row.review })));
}
