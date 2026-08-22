import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (context: { chatId: number; text: string }) => Promise<string | { text: string }>;

const h = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  createEmailVerification: vi.fn(),
  verifyDeliveryEmail: vi.fn(),
  upsertUserPreferences: vi.fn(),
  sendEmailVerification: vi.fn(),
}));

vi.mock("../config", () => ({
  config: {
    app: { smtpUser: "bot@example.com", smtpPass: "app-password", timezone: "UTC" },
  },
}));
vi.mock("../sender/telegram", () => ({
  registerCommand: (name: string, handler: Handler) => h.handlers.set(name, handler),
}));
vi.mock("../sender/email", () => ({ sendEmailVerification: h.sendEmailVerification }));
vi.mock("../utils/supabase", () => ({
  supabase: {
    isConfigured: () => true,
    createEmailVerification: h.createEmailVerification,
    verifyDeliveryEmail: h.verifyDeliveryEmail,
    upsertUserPreferences: h.upsertUserPreferences,
  },
}));
vi.mock("../utils/stocks", () => ({ fetchStockPrices: vi.fn() }));

import { emailVerificationHash, registerPreferenceCommands } from "./preferences";

beforeEach(() => {
  h.handlers.clear();
  h.createEmailVerification.mockReset().mockResolvedValue(true);
  h.verifyDeliveryEmail.mockReset().mockResolvedValue(true);
  h.upsertUserPreferences.mockReset().mockResolvedValue(true);
  h.sendEmailVerification.mockReset().mockResolvedValue(true);
  registerPreferenceCommands();
});

describe("email destination verification", () => {
  it("sends a code without enabling an unverified destination", async () => {
    const result = await h.handlers.get("delivery")!({
      chatId: 42,
      text: "/delivery email analyst@example.com",
    });

    expect(h.upsertUserPreferences).not.toHaveBeenCalled();
    expect(h.createEmailVerification).toHaveBeenCalledWith(
      42,
      "analyst@example.com",
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.any(String)
    );
    expect(h.sendEmailVerification).toHaveBeenCalledWith(
      "analyst@example.com",
      expect.stringMatching(/^\d{6}$/)
    );
    expect(result).toContain("verification code");
  });

  it("activates the destination only after a valid code", async () => {
    const result = await h.handlers.get("delivery")!({
      chatId: 42,
      text: "/delivery email verify 123456",
    });

    expect(h.verifyDeliveryEmail).toHaveBeenCalledWith(
      42,
      emailVerificationHash(42, "123456")
    );
    expect(result).toContain("verified");
  });
});
