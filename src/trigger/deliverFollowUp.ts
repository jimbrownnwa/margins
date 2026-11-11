import { logger, task } from "@trigger.dev/sdk";
import { db, saveMessage, setActiveBook, unwrap, type FollowUp } from "../lib/db";
import { sendText } from "../lib/telegram";

/** Triggered with a delay by the schedule_follow_up tool. */
export const deliverFollowUp = task({
  id: "deliver-follow-up",
  retry: { maxAttempts: 3 },
  run: async (payload: { followUpId: string }) => {
    const followUp = unwrap(
      await db().from("follow_ups").select("*").eq("id", payload.followUpId).maybeSingle(),
      "load follow-up",
    ) as FollowUp | null;

    if (!followUp || followUp.status !== "scheduled") {
      logger.info("Follow-up no longer scheduled; skipping", { followUpId: payload.followUpId, status: followUp?.status });
      return;
    }

    // If sending fails, the run retries with the follow-up still scheduled.
    const sentIds = await sendText(followUp.chat_id, followUp.message);
    unwrap(await db().from("follow_ups").update({ status: "sent" }).eq("id", followUp.id), "mark sent");
    // Put the follow-up in that book's history and make it active, so the reader's reply lands in context.
    await saveMessage({
      chat_id: followUp.chat_id,
      book_id: followUp.book_id,
      role: "assistant",
      content: followUp.message,
      telegram_message_id: sentIds[0] ?? null,
    });
    await setActiveBook(followUp.chat_id, followUp.book_id);
  },
});
