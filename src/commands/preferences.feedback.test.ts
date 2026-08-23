import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (context: { chatId: number; text: string }) => Promise<string | { text: string }>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  submitDigestFeedback: vi.fn(),
}));

vi.mock("../config", () => ({
  config: { app: { timezone: "UTC", smtpUser: "", smtpPass: "" } },
}));
vi.mock("../sender/telegram", () => ({
  registerCommand: (name: string, handler: Handler) => h.handlers.set(name, handler),
}));
vi.mock("../sender/email", () => ({ sendEmailVerification: vi.fn() }));
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: () => true,
    submitDigestFeedback: h.submitDigestFeedback,
  },
}));
vi.mock("../utils/stocks", () => ({ fetchStockPrices: vi.fn() }));

import { registerPreferenceCommands } from "./preferences";

beforeEach(() => {
  h.handlers.clear();
  h.submitDigestFeedback.mockReset().mockResolvedValue(true);
  registerPreferenceCommands();
});

describe("private digest feedback", () => {
  it("uses the transactional feedback boundary and never reads legacy metrics", async () => {
    const result = await h.handlers.get("feedback")!({
      chatId: 42,
      text: "/feedback 5 Great coverage",
    });

    expect(h.submitDigestFeedback).toHaveBeenCalledWith(
      42,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      5,
      "Great coverage"
    );
    expect(result).toContain("recorded privately");
  });

  it("rejects oversized comments before calling Supabase", async () => {
    const result = await h.handlers.get("feedback")!({
      chatId: 42,
      text: `/feedback 4 ${"x".repeat(2001)}`,
    });

    expect(h.submitDigestFeedback).not.toHaveBeenCalled();
    expect(result).toContain("2,000 characters");
  });
});
