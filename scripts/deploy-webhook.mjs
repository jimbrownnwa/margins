// Sets the webhook function's secrets and deploys it to Supabase. Usage: npm run deploy:webhook
import { execFileSync } from "node:child_process";

const ref = process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
for (const name of ["SUPABASE_ACCESS_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_CHAT_ID", "TRIGGER_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} is empty in .env`);
}
if (!ref) throw new Error("SUPABASE_URL must look like https://<ref>.supabase.co");

const run = (args) => execFileSync("npx", ["--yes", "supabase@latest", ...args], { stdio: "inherit", shell: process.platform === "win32" });

// Values are passed through the environment, not the command line, so they don't show up in process listings.
const secretArgs = ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_ALLOWED_CHAT_ID", "TRIGGER_SECRET_KEY"];
import { writeFileSync, rmSync } from "node:fs";
const envFile = ".webhook-secrets.env";
writeFileSync(envFile, secretArgs.map((n) => `${n}=${process.env[n]}`).join("\n") + "\n");
try {
  run(["secrets", "set", "--project-ref", ref, "--env-file", envFile]);
} finally {
  rmSync(envFile, { force: true });
}
run(["functions", "deploy", "telegram-webhook", "--project-ref", ref, "--no-verify-jwt", "--use-api"]);
