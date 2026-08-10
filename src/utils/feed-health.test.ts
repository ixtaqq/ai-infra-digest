import { describe, expect, it } from "vitest";
import { findConsistentlyFailingFeeds } from "./feed-health";

describe("findConsistentlyFailingFeeds", () => {
  it("counts failures until the first success for each interleaved feed", () => {
    const rows = [
      { feed_name: "A", status: "failed" },
      { feed_name: "B", status: "failed" },
      { feed_name: "A", status: "failed" },
      { feed_name: "B", status: "success" },
      { feed_name: "A", status: "success" },
      { feed_name: "B", status: "failed" },
    ];

    expect([...findConsistentlyFailingFeeds(rows, 2)]).toEqual(["A"]);
  });

  it("does not count failures older than the newest success", () => {
    const rows = [
      { feed_name: "A", status: "failed" },
      { feed_name: "A", status: "success" },
      { feed_name: "A", status: "failed" },
      { feed_name: "A", status: "failed" },
    ];

    expect(findConsistentlyFailingFeeds(rows, 2).size).toBe(0);
  });
});
