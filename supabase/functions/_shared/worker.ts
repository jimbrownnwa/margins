import { runTurn } from "./agent/run.ts";
import { db, saveMessage, setActiveBook, unwrap, type FollowUp } from "./lib/db.ts";
import { sendText, sendTyping } from "./lib/telegram.ts";

interface InboxRow {
  update_id: number;
  chat_id: number;
  telegram_message_id: number | null;
  text: string | null;
  has_photo: boolean;
}

/**
 * Processes a chat's pending messages one at a time until none are left.
 * claim_next_message() guarantees only one worker owns a chat at a time; if another worker
 * already does, this returns immediately and that worker picks up the new message.
 */
export async function drainChat(chatId: number): Promise<void> {
  let completed: number | null = null;
  let error: string | null = null;
  for (;;) {
    const rows = unwrap(
      await db().rpc("claim_next_message", { p_chat_id: chatId, p_completed_update_id: completed, p_error: error }),
      "claim message",
    ) as InboxRow[];
    const row = rows[0];
    if (!row) return;
    completed = row.update_id;
    error = null;
    try {
      await handleMessage(row);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      console.error("Turn failed", { update_id: row.update_id, error });
      await sendText(chatId, "Something went wrong on my side and I couldn't reply. Could you send that again?").catch(() => {});
    }
  }
}

async function handleMessage(row: InboxRow): Promise<void> {
  const chatId = row.chat_id;
  if (!row.text?.trim()) {
    await sendText(
      chatId,
      row.has_photo
        ? "I can't read photos of pages yet. Could you type out the passage, or the part that caught your attention?"
        : "I can only read text messages for now.",
    );
    return;
  }

  await sendTyping(chatId);
  const turn = await runTurn(chatId, row.text);

  // Save the exchange only after a successful turn, filed under the book the turn ended on
  // (the agent may have switched books).
  await saveMessage({ chat_id: chatId, book_id: turn.bookId, role: "user", content: row.text, telegram_message_id: row.telegram_message_id });
  const sentIds = await sendText(chatId, turn.reply);
  await saveMessage({ chat_id: chatId, book_id: turn.bookId, role: "assistant", content: turn.reply, telegram_message_id: sentIds[0] ?? null });
}

/** Runs once a minute: recovers stuck messages, resumes queued ones, and sends due follow-ups. */
export async function tick(): Promise<void> {
  const stale = unwrap(await db().rpc("fail_stale_messages"), "fail stale messages") as InboxRow[];
  for (const row of stale) {
    console.error("Message timed out", { update_id: row.update_id });
    await sendText(row.chat_id, "Sorry, I lost my thread on your last message. Could you send it again?").catch(() => {});
  }

  // Resume any chat with queued messages whose worker didn't finish (e.g. it hit the time limit).
  const pending = unwrap(
    await db().from("inbox").select("chat_id").eq("status", "pending").lt("received_at", new Date(Date.now() - 60_000).toISOString()),
    "find pending",
  ) as { chat_id: number }[];
  for (const chatId of new Set(pending.map((p) => p.chat_id))) await drainChat(chatId);

  const due = unwrap(await db().rpc("claim_due_follow_ups"), "claim follow-ups") as FollowUp[];
  for (const followUp of due) {
    try {
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
    } catch (e) {
      console.error("Follow-up delivery failed; will retry next tick", { id: followUp.id, error: String(e) });
      await db().from("follow_ups").update({ status: "scheduled" }).eq("id", followUp.id).eq("status", "sending");
    }
  }
}
