import { z } from "zod";
import { supabase } from "../utils/supabase";
import { logger } from "../utils/logger";

const message = z.object({
  message_id: z.number().int(),
  chat: z.object({ id: z.number().int().safe(), type: z.enum(["private", "group", "supergroup", "channel"]) }).passthrough(),
}).passthrough();
export const updateSchema = z.object({
  update_id: z.number().int().nonnegative().safe(),
  message: message.optional(),
  callback_query: z.object({ id: z.string(), from: z.object({ id: z.number().int().safe() }).passthrough(), message: message.optional() }).passthrough().optional(),
}).passthrough();

export async function acceptUpdate(payload: unknown): Promise<void> {
  const update = updateSchema.parse(payload);
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? null;
  await supabase.requiredRpc("accept_telegram_update", { p_update_id: update.update_id, p_chat_id: chatId, p_payload: update });
}

export async function drainInbox(dispatch: (payload: unknown) => Promise<void>): Promise<void> {
  for (let count = 0; count < 25; count++) {
    const rows = await supabase.requiredRpc<{ update_id: number; payload: unknown }[]>("claim_telegram_update", {});
    if (!rows.length) return;
    const row = rows[0];
    let state = "done";
    try { await dispatch(row.payload); }
    catch { state = "ambiguous"; logger.error(`Telegram update ${row.update_id} requires reconciliation`); }
    await supabase.requiredRpc("finish_telegram_update", { p_update_id: row.update_id, p_status: state });
  }
}
