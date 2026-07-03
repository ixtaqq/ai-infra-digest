import { z } from "zod";

/**
 * A financial figure the AI was asked to return as `<number>` or `null`. Models
 * occasionally return numeric strings ("150") instead — coerce those, but fall
 * back to null (never NaN/a string) for anything else so `.toFixed()` calls at
 * render time never crash on a malformed field. Shared by processor/sec.ts and
 * processor/earnings.ts, which extract the same kind of AI-reported figures.
 */
export const nullableFinancialNumber = z.preprocess((val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val === "string") {
    const n = Number(val.replace(/[$,%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}, z.number().nullable());
