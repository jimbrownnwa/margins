// Receives Telegram webhook updates and hands each message to the Trigger.dev
// "handle-telegram-message" task. Deployed with verify_jwt off: it authenticates
// Telegram by the secret token header instead.

const TASK_ID = "handle-telegram-message";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");

  const expectedSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!expectedSecret || req.headers.get("x-telegram-bot-api-secret-token") !== expectedSecret) {
    return new Response("forbidden", { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const msg = update?.message;
  const chatId = msg?.chat?.id;
  // Only new messages from the reader's own chat. Edits, other chats and other update types are ignored.
  if (!msg || String(chatId) !== Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID")) {
    return new Response("ok");
  }

  const res = await fetch(`https://api.trigger.dev/api/v1/tasks/${TASK_ID}/trigger`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("TRIGGER_SECRET_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      payload: {
        updateId: update.update_id,
        chatId,
        messageId: msg.message_id,
        text: msg.text ?? msg.caption ?? null,
        hasPhoto: Array.isArray(msg.photo) && msg.photo.length > 0,
      },
      options: {
        concurrencyKey: String(chatId),
        // Telegram retries webhooks that fail; this stops a retry from creating a second run.
        idempotencyKey: `telegram-update-${update.update_id}`,
      },
    }),
  });

  if (!res.ok) {
    console.error("Trigger.dev trigger failed", res.status, await res.text());
    // A non-2xx makes Telegram retry later.
    return new Response("upstream error", { status: 502 });
  }
  return new Response("ok");
});
