import { expect, it } from "vitest";
import { awaitUpdateWork, markUpdateIncomplete, trackUpdateWork } from "./update-context";

it("waits for async handlers and work they add", async () => {
  let completed = false;
  await awaitUpdateWork(() => {
    trackUpdateWork(Promise.resolve().then(() => {
      trackUpdateWork(new Promise<void>(resolve => setTimeout(() => { completed = true; resolve(); }, 5)));
    }));
  });
  expect(completed).toBe(true);
});

it("quarantines incomplete replies without replaying a handler", async () => {
  await expect(awaitUpdateWork(() => {
    trackUpdateWork(Promise.resolve().then(markUpdateIncomplete));
  })).rejects.toThrow("do not replay");
});

it("propagates handler failure to the inbox", async () => {
  await expect(awaitUpdateWork(() => {
    trackUpdateWork(Promise.reject(new Error("interrupted")));
  })).rejects.toThrow("interrupted");
});
