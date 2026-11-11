import { requireEnv } from "./env.ts";

const MAX_LENGTH = 4000; // Telegram's hard limit is 4096 characters per message.

async function call(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${requireEnv("TELEGRAM_BOT_TOKEN")}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

/** Sends plain text, splitting on paragraph boundaries when it is too long. Returns the sent message ids. */
export async function sendText(chatId: number, text: string): Promise<number[]> {
  const ids: number[] = [];
  for (const chunk of split(text)) {
    const result = await call("sendMessage", { chat_id: chatId, text: chunk });
    ids.push(result.message_id);
  }
  return ids;
}

export async function sendTyping(chatId: number): Promise<void> {
  try {
    await call("sendChatAction", { chat_id: chatId, action: "typing" });
  } catch {
    // Cosmetic only.
  }
}

function split(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_LENGTH) {
    let cut = rest.lastIndexOf("\n\n", MAX_LENGTH);
    if (cut < MAX_LENGTH / 2) cut = rest.lastIndexOf(" ", MAX_LENGTH);
    if (cut <= 0) cut = MAX_LENGTH;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
