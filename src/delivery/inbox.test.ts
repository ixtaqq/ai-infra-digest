import { beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("../utils/supabase", () => ({ supabase: { requiredRpc: rpc } }));
import { acceptUpdate, drainInbox } from "./inbox";
import { awaitUpdateWork, trackUpdateWork } from "../utils/update-context";
beforeEach(() => { rpc.mockReset(); });
it("refuses malformed messages before persistence", async () => {
  await expect(acceptUpdate({ update_id: 1, message: {} })).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
});
it("does not acknowledge a failed inbox write", async () => {
  rpc.mockRejectedValue(new Error("database offline"));
  await expect(acceptUpdate({ update_id: 1 })).rejects.toThrow("database offline");
});
it("awaits asynchronous handlers before completion", async () => {
  let complete = false;
  await awaitUpdateWork(() => { trackUpdateWork(Promise.resolve().then(() => { complete = true; })); });
  expect(complete).toBe(true);
});
it("quarantines failed processing instead of retrying an uncertain command", async () => {
  rpc.mockResolvedValueOnce([{ update_id: 7, payload: { update_id: 7 } }]).mockResolvedValueOnce(true).mockResolvedValueOnce([]);
  const dispatch = vi.fn().mockRejectedValue(new Error("lost response"));
  await drainInbox(dispatch);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith("finish_telegram_update", { p_update_id: 7, p_status: "ambiguous" });
});
