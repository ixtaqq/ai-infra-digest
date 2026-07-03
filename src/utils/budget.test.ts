import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  queryRows: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { app: { budgetMonthlyUsd: 5.0 } },
}));

vi.mock("./supabase", () => ({
  supabase: { queryRows: h.queryRows, isConfigured: () => true },
}));

import { getRolling30DaySpend, isMonthlyBudgetExceeded } from "./budget";

beforeEach(() => {
  h.queryRows.mockReset();
});

describe("getRolling30DaySpend", () => {
  it("sums estimated_cost across returned rows", async () => {
    h.queryRows.mockResolvedValue([
      { estimated_cost: 0.5 },
      { estimated_cost: 1.25 },
      { estimated_cost: 0 },
    ]);
    expect(await getRolling30DaySpend()).toBeCloseTo(1.75);
  });

  it("treats null/missing costs as zero", async () => {
    h.queryRows.mockResolvedValue([{ estimated_cost: null }, { estimated_cost: 2 }]);
    expect(await getRolling30DaySpend()).toBe(2);
  });

  it("returns 0 when the query yields no rows (fail-open)", async () => {
    h.queryRows.mockResolvedValue([]);
    expect(await getRolling30DaySpend()).toBe(0);
  });
});

describe("isMonthlyBudgetExceeded", () => {
  it("is false while spend is under the cap", async () => {
    h.queryRows.mockResolvedValue([{ estimated_cost: 4.99 }]);
    expect(await isMonthlyBudgetExceeded()).toBe(false);
  });

  it("is true once spend reaches the cap", async () => {
    h.queryRows.mockResolvedValue([{ estimated_cost: 5.0 }]);
    expect(await isMonthlyBudgetExceeded()).toBe(true);
  });

  it("fails open (false) when Supabase is unreachable and queryRows returns []", async () => {
    h.queryRows.mockResolvedValue([]);
    expect(await isMonthlyBudgetExceeded()).toBe(false);
  });
});
