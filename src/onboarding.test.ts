import { describe, it, expect, vi } from "vitest";

// onboarding.ts imports supabase (which imports config → loads env) + logger.
vi.mock("./utils/supabase", () => ({ supabase: { upsertUserPreferences: vi.fn() } }));
vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { previousStep, STEP_ORDER } from "./onboarding";

describe("previousStep", () => {
  it("returns null for the first step (no Back)", () => {
    expect(previousStep("delivery_time")).toBeNull();
  });

  it("walks back one step from each interior step", () => {
    expect(previousStep("watchlist")).toBe("delivery_time");
    expect(previousStep("min_score")).toBe("watchlist");
    expect(previousStep("digest_length")).toBe("min_score");
  });

  it("maps the terminal step back to the last interactive step", () => {
    expect(previousStep("done")).toBe("digest_length");
  });

  it("keeps STEP_ORDER in the expected linear sequence", () => {
    expect(STEP_ORDER).toEqual([
      "delivery_time",
      "watchlist",
      "min_score",
      "digest_length",
      "done",
    ]);
  });

  it("has a coherent chain — every step except the first resolves to its predecessor", () => {
    for (let i = 1; i < STEP_ORDER.length; i++) {
      expect(previousStep(STEP_ORDER[i])).toBe(STEP_ORDER[i - 1]);
    }
  });
});
