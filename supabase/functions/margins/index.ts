// Margins Edge Function. Deployed with verify_jwt off; each route authenticates itself.
//   POST /margins/telegram  Telegram webhook (checked by the secret token header)
//   POST /margins/tick      called every minute by pg_cron (checked by x-cron-secret)
// Both answer immediately and do the work in the background with EdgeRuntime.waitUntil.

import { db } from "../_shared/lib/db.ts";
import { drainChat, tick } from "../_shared/worker.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function background(work: Promise<unknown>, label: string) {
  EdgeRuntime.waitUntil(work.catch((e) => console.error(`${label} failed`, e instanceof Error ? e.stack : String(e))));
}

async function handleTelegram(req: Request): Promise<Response> {
  const secret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
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
  if (!msg || String(chatId) !== Deno.env.get("TELEGRAM_ALLOWED_CHAT_ID")) return new Response("ok");

  // The update id is the primary key, so a Telegram retry of the same update is ignored.
  const { error } = await db().from("inbox").upsert(
    {
      update_id: update.update_id,
      chat_id: chatId,
      telegram_message_id: msg.message_id,
      text: msg.text ?? msg.caption ?? null,
      has_photo: Array.isArray(msg.photo) && msg.photo.length > 0,
    },
    { onConflict: "update_id", ignoreDuplicates: true },
  );
  if (error) {
    console.error("Could not queue message", error.message);
    return new Response("error", { status: 500 }); // Telegram will retry.
  }

  background(drainChat(chatId), "drainChat");
  return new Response("ok");
}

function handleTick(req: Request): Response {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("x-cron-secret") !== secret) return new Response("forbidden", { status: 401 });
  background(tick(), "tick");
  return new Response("ok");
}

Deno.serve((req: Request) => {
  if (req.method !== "POST") return new Response("ok");
  const path = new URL(req.url).pathname;
  if (path.endsWith("/telegram")) return handleTelegram(req);
  if (path.endsWith("/tick")) return handleTick(req);
  return new Response("not found", { status: 404 });
});
