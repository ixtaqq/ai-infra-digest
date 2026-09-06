import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  requiredRows: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { app: { budgetMonthlyUsd: 5.0 } },
}));

vi.mock("./supabase", () => ({
  supabase: { requiredRows: h.requiredRows, isConfigured: () => true },
}));

import { getRolling30DaySpend, isMonthlyBudgetExceeded } from "./budget";

beforeEach(() => {
  h.requiredRows.mockReset();
});

describe("getRolling30DaySpend", () => {
  it("sums reported_cost across returned rows", async () => {
    h.requiredRows.mockResolvedValue([
      { reported_cost: 0.5 },
      { reported_cost: 1.25 },
      { reported_cost: 0 },
    ]);
    expect(await getRolling30DaySpend()).toBeCloseTo(1.75);
  });

  it("reports unknown costs explicitly", async () => {
    h.requiredRows.mockResolvedValue([{ reported_cost: null }, { reported_cost: 2 }]);
    expect(await getRolling30DaySpend()).toBeNull();
  });

  it("reports unknown when no attempt ledger is available", async () => {
    h.requiredRows.mockResolvedValue([]);
    expect(await getRolling30DaySpend()).toBeNull();
  });
});

describe("isMonthlyBudgetExceeded", () => {
  it("is false while spend is under the cap", async () => {
    h.requiredRows.mockResolvedValue([{ reported_cost: 4.99 }]);
    expect(await isMonthlyBudgetExceeded()).toBe(false);
  });

  it("is true once spend reaches the cap", async () => {
    h.requiredRows.mockResolvedValue([{ reported_cost: 5.0 }]);
    expect(await isMonthlyBudgetExceeded()).toBe(true);
  });

  it("does not represent advisory budget checks as a strict spending cap", async () => {
    h.requiredRows.mockResolvedValue([]);
    expect(await isMonthlyBudgetExceeded()).toBe(false);
  });
});
