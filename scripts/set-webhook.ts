export {};
// Points the Telegram bot at the Supabase telegram-webhook function.
// Usage: npm run set-webhook
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const supabaseUrl = process.env.SUPABASE_URL;
if (!token || !secret || !supabaseUrl) throw new Error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and SUPABASE_URL must be set in .env");

const url = `${supabaseUrl}/functions/v1/telegram-webhook`;
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true }),
});
console.log(await res.json());

const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`).then((r) => r.json() as Promise<any>);
console.log({ url: info.result?.url, pending: info.result?.pending_update_count, last_error: info.result?.last_error_message });
