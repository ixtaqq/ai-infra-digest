import { describe, it, expect, vi } from "vitest";
import { withRetry, tryStage } from "./retry";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// baseDelayMs:1 keeps the full-jitter backoff to sub-millisecond so tests are fast.
const fast = { baseDelayMs: 1 } as const;

describe("withRetry", () => {
  it("returns the value on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, fast)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a failing call and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");
    await expect(withRetry(fn, fast)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("401 unauthorized"));
    await expect(
      withRetry(fn, { ...fast, shouldRetry: () => false })
    ).rejects.toThrow("401 unauthorized");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("still down"));
    await expect(withRetry(fn, { ...fast, maxAttempts: 3 })).rejects.toThrow(
      "still down"
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes the attempt number to shouldRetry", async () => {
    const seen: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, {
        ...fast,
        maxAttempts: 3,
        shouldRetry: (_e, attempt) => {
          seen.push(attempt);
          return true;
        },
      })
    ).rejects.toThrow("x");
    // shouldRetry is consulted on attempts 1 and 2 (not on the final attempt 3)
    expect(seen).toEqual([1, 2]);
  });
});

describe("tryStage", () => {
  it("wraps a success as { ok: true, value }", async () => {
    const res = await tryStage(async () => 42, "compute");
    expect(res).toEqual({ ok: true, value: 42 });
  });

  it("wraps a throw as { ok: false, error } and never rejects", async () => {
    const res = await tryStage(async () => {
      throw new Error("stage boom");
    }, "risky");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("stage boom");
  });
});
