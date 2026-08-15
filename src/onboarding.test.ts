import { beforeEach, describe, it, expect, vi } from "vitest";

// onboarding.ts imports supabase (which imports config → loads env) + logger.
vi.mock("./utils/supabase", () => ({
  supabase: {
    upsertUserPreferences: vi.fn(async () => true),
    recordProductEvent: vi.fn(async () => true),
  },
}));
vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { supabase } from "./utils/supabase";
import { handleOnboardingCallback, previousStep, STEP_ORDER, startOnboarding } from "./onboarding";

beforeEach(() => {
  vi.clearAllMocks();
});

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

describe("onboarding consent", () => {
  it("keeps an abandoned onboarding user inactive", async () => {
    const bot = {
      sendMessage: vi.fn(async () => ({ message_id: 1 })),
    } as unknown as Parameters<typeof startOnboarding>[0];
    const msg = {
      chat: { id: 42 },
      from: { first_name: "Ada", username: "ada" },
    } as unknown as Parameters<typeof startOnboarding>[1];

    await startOnboarding(bot, msg);

    expect(supabase.upsertUserPreferences).toHaveBeenCalledTimes(1);
    expect(supabase.upsertUserPreferences).toHaveBeenCalledWith({
      chat_id: 42,
      username: "ada",
      first_name: "Ada",
    });
    expect(supabase.upsertUserPreferences).not.toHaveBeenCalledWith(
      expect.objectContaining({ is_active: true })
    );
    expect(supabase.recordProductEvent).toHaveBeenCalledWith("onboarding_started", 42);
  });

  it("expires an abandoned session at the TTL boundary", async () => {
    vi.useFakeTimers();
    try {
      const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof startOnboarding>[0];
      const msg = {
        chat: { id: 43 },
        from: { first_name: "Grace", username: "grace" },
      } as unknown as Parameters<typeof startOnboarding>[1];

      await startOnboarding(bot, msg);
      vi.advanceTimersByTime(30 * 60 * 1000);

      const handled = await handleOnboardingCallback(bot, {
        id: "callback-1",
        data: "ob_time_08:00",
        message: { chat: { id: 43 }, message_id: 1 },
      } as unknown as Parameters<typeof handleOnboardingCallback>[1]);

      expect(handled).toBe(true);
      expect(bot.answerCallbackQuery).toHaveBeenCalledWith(
        "callback-1",
        { text: "Session expired — send /start to begin again." }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates only at completion and records the resume consent marker", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T09:30:00.000Z"));
    try {
      const bot = {
        sendMessage: vi.fn(async () => ({ message_id: 1 })),
        answerCallbackQuery: vi.fn(async () => undefined),
        editMessageText: vi.fn(async () => undefined),
      } as unknown as Parameters<typeof startOnboarding>[0];
      const msg = {
        chat: { id: 44 },
        from: { first_name: "Lin", username: "lin" },
      } as unknown as Parameters<typeof startOnboarding>[1];

      await startOnboarding(bot, msg);
      for (const [index, data] of [
        "ob_time_08:00",
        "ob_watchlist_skip",
        "ob_score_5",
        "ob_len_standard",
      ].entries()) {
        await handleOnboardingCallback(bot, {
          id: `callback-${index}`,
          data,
          message: { chat: { id: 44 }, message_id: index + 1 },
          from: { first_name: "Lin", username: "lin" },
        } as unknown as Parameters<typeof handleOnboardingCallback>[1]);
      }

      expect(supabase.upsertUserPreferences).toHaveBeenLastCalledWith({
        chat_id: 44,
        preferred_time: "08:00",
        timezone: "Asia/Kuala_Lumpur",
        watchlist: [],
        min_impact_score: 5,
        digest_length: "standard",
        is_active: true,
        onboarding_completed_at: "2026-08-15T09:30:00.000Z",
      });
      expect(supabase.recordProductEvent).toHaveBeenLastCalledWith(
        "onboarding_completed",
        44,
        {
          preferred_time: "08:00",
          watchlist_size: 0,
          digest_length: "standard",
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
