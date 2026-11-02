import { describe, expect, it, vi } from "vitest";

vi.mock("../config", () => ({ config: { app: {} } }));
vi.mock("../sender/slack", () => ({ sendSlackDigest: vi.fn() }));
vi.mock("../utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../utils/supabase", () => ({ supabase: { isConfigured: () => false } }));

import { assessEditionQuality, type EditionObservations } from "./quality";

const healthy: EditionObservations = {
  priceChanges: [1.2, -3.4, 0, 0.5, 2.1],
  articleCount: 28,
  secExtractCounts: [1, 0, 0],
  heldDeliveries: 0,
  lastDeliveryLatenessSeconds: 120,
};
const ids = (changes: Partial<EditionObservations>) =>
  assessEditionQuality({ ...healthy, ...changes }).map((issue) => issue.id);

describe("assessEditionQuality", () => {
  it("passes a healthy edition", () => {
    expect(ids({})).toEqual([]);
  });

  it("flags quotes that all show no movement", () => {
    expect(ids({ priceChanges: Array(19).fill(0) })).toEqual(["prices_flat"]);
  });

  it("does not judge movement from too few quotes", () => {
    expect(ids({ priceChanges: [0, 0] })).toEqual([]);
  });

  it("flags an unusually thin edition", () => {
    expect(ids({ articleCount: 9 })).toEqual(["thin_edition"]);
  });

  it("flags SEC analysis only after a full window without extracts", () => {
    expect(ids({ secExtractCounts: Array(14).fill(0) })).toEqual(["sec_no_extracts"]);
    expect(ids({ secExtractCounts: Array(13).fill(0) })).toEqual([]);
    expect(ids({ secExtractCounts: [...Array(13).fill(0), 1] })).toEqual([]);
  });

  it("flags deliveries waiting on reconciliation", () => {
    expect(ids({ heldDeliveries: 2 })).toEqual(["deliveries_held"]);
  });

  it("flags a late delivery but not an unknown one", () => {
    expect(ids({ lastDeliveryLatenessSeconds: 3600 })).toEqual(["delivery_late"]);
    expect(ids({ lastDeliveryLatenessSeconds: null })).toEqual([]);
  });
});
