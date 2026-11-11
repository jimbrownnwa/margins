// Copies the runtime secrets from .env into the Trigger.dev prod environment.
// Usage: npm run push-env
import { configure, envvars } from "@trigger.dev/sdk";

const RUNTIME_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_ID",
];

const projectRef = process.env.TRIGGER_PROJECT_REF;
const accessToken = process.env.TRIGGER_ACCESS_TOKEN;
if (!projectRef || !accessToken) throw new Error("TRIGGER_PROJECT_REF and TRIGGER_ACCESS_TOKEN must be set in .env");

const variables: Record<string, string> = {};
for (const name of RUNTIME_VARS) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty in .env`);
  variables[name] = value;
}

configure({ accessToken });
await envvars.upload(projectRef, "prod", { variables, override: true });
console.log(`Uploaded ${RUNTIME_VARS.length} variables to Trigger.dev prod: ${RUNTIME_VARS.join(", ")}`);
