import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flushMetrics: vi.fn(async () => undefined),
  runPipeline: vi.fn(async () => true),
  startInteractiveBot: vi.fn(),
}));

vi.mock("./utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./utils/metrics", () => ({ flushMetrics: h.flushMetrics }));
vi.mock("./pipeline/run", () => ({ runPipeline: h.runPipeline }));
vi.mock("./sender/telegram", () => ({ startInteractiveBot: h.startInteractiveBot }));
vi.mock("./commands/register", () => ({ registerDigestCommands: vi.fn() }));

import { main } from "./index";

describe("index shutdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [true, 0],
    [false, 1],
  ])("flushes metrics before exiting with code %s", async (success, exitCode) => {
    const events: string[] = [];
    h.runPipeline.mockImplementationOnce(async () => {
      events.push("pipeline");
      return success;
    });
    h.flushMetrics.mockImplementationOnce(async () => {
      events.push("flush");
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      await main();

      expect(events).toEqual(["pipeline", "flush"]);
      expect(h.flushMetrics).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(exitCode);
    } finally {
      exit.mockRestore();
    }
  });
});
