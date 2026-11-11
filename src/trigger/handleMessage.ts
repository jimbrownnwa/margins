import { logger, task } from "@trigger.dev/sdk";
import { runTurn } from "../agent/run";
import { saveMessage } from "../lib/db";
import { sendText, sendTyping } from "../lib/telegram";

/** Sent by the Supabase telegram-webhook function. */
export interface IncomingMessage {
  updateId: number;
  chatId: number;
  messageId: number;
  text: string | null;
  hasPhoto: boolean;
}

export const handleTelegramMessage = task({
  id: "handle-telegram-message",
  // One message at a time per chat, so replies stay in order. The webhook passes chatId as the concurrencyKey.
  concurrency: { perKey: 1 },
  // A retry after the reply was sent would message the reader twice, so don't retry the whole run.
  // The Anthropic SDK already retries transient API errors internally.
  retry: { maxAttempts: 1 },
  maxDuration: 300,
  run: async (payload: IncomingMessage) => {
    const { chatId } = payload;
    const allowed = process.env.TELEGRAM_ALLOWED_CHAT_ID;
    if (allowed && String(chatId) !== allowed) {
      logger.warn("Ignoring message from unexpected chat", { chatId });
      return;
    }

    if (!payload.text?.trim()) {
      await sendText(
        chatId,
        payload.hasPhoto
          ? "I can't read photos of pages yet. Could you type out the passage, or the part that caught your attention?"
          : "I can only read text messages for now.",
      );
      return;
    }

    await sendTyping(chatId);

    let turn: Awaited<ReturnType<typeof runTurn>>;
    try {
      turn = await runTurn(chatId, payload.text);
    } catch (error) {
      logger.error("Turn failed", { error: error instanceof Error ? error.message : String(error) });
      await sendText(chatId, "Something went wrong on my side and I couldn't reply. Could you send that again?");
      throw error;
    }

    // Save the exchange only after a successful turn, filed under the book the turn ended on
    // (the agent may have switched books).
    await saveMessage({
      chat_id: chatId,
      book_id: turn.bookId,
      role: "user",
      content: payload.text,
      telegram_message_id: payload.messageId,
    });
    const sentIds = await sendText(chatId, turn.reply);
    await saveMessage({
      chat_id: chatId,
      book_id: turn.bookId,
      role: "assistant",
      content: turn.reply,
      telegram_message_id: sentIds[0] ?? null,
    });
  },
});
