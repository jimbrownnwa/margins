// Deploys Margins to Supabase: function secrets, the Edge Function, the once-a-minute cron tick,
// and the Telegram webhook. Run `npm run migrate` first. Usage: npm run deploy
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const FUNCTION_SECRETS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_CHAT_ID",
  "CRON_SECRET",
];

for (const name of ["SUPABASE_URL", "SUPABASE_ACCESS_TOKEN", ...FUNCTION_SECRETS]) {
  if (!process.env[name]) throw new Error(`${name} is empty in .env`);
}
const supabaseUrl = process.env.SUPABASE_URL;
const ref = supabaseUrl.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!ref) throw new Error("SUPABASE_URL must look like https://<ref>.supabase.co");
const functionUrl = `${supabaseUrl}/functions/v1/margins`;

const supabase = (args) =>
  execFileSync("npx", ["--yes", "supabase@2", ...args], { stdio: "inherit", shell: process.platform === "win32" });

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`SQL failed (${res.status}): ${await res.text()}`);
  return res.json();
}
const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

console.log("1/4 Setting function secrets");
// Written to a temp file rather than passed as arguments, so values don't appear in process listings.
const envFile = ".function-secrets.env";
writeFileSync(envFile, FUNCTION_SECRETS.map((n) => `${n}=${process.env[n]}`).join("\n") + "\n");
try {
  supabase(["secrets", "set", "--project-ref", ref, "--env-file", envFile]);
} finally {
  rmSync(envFile, { force: true });
}

console.log("2/4 Deploying the margins function");
supabase(["functions", "deploy", "margins", "--project-ref", ref, "--no-verify-jwt", "--use-api"]);

console.log("3/4 Scheduling the once-a-minute tick");
const vaultSecrets = { margins_tick_url: `${functionUrl}/tick`, margins_cron_secret: process.env.CRON_SECRET };
for (const [name, value] of Object.entries(vaultSecrets)) {
  await sql(`do $$ begin
    if exists (select 1 from vault.secrets where name = ${literal(name)}) then
      perform vault.update_secret((select id from vault.secrets where name = ${literal(name)}), ${literal(value)});
    else
      perform vault.create_secret(${literal(value)}, ${literal(name)});
    end if;
  end $$;`);
}
await sql(`select cron.schedule('margins-tick', '* * * * *', $cron$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'margins_tick_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'margins_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
$cron$);`);

console.log("4/4 Pointing the Telegram bot at the function");
const tg = (method, body) =>
  fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());
const set = await tg("setWebhook", {
  url: `${functionUrl}/telegram`,
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
  allowed_updates: ["message"],
});
if (!set.ok) throw new Error(`setWebhook failed: ${set.description}`);
const info = await tg("getWebhookInfo");
console.log("Webhook:", { url: info.result?.url, pending: info.result?.pending_update_count, last_error: info.result?.last_error_message ?? null });
console.log("Done.");
