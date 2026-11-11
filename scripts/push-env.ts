// Copies the runtime secrets from .env into the Trigger.dev prod environment.
// Authenticates with the prod secret key, or a personal access token if that's what you have.
// Usage: npm run push-env
export {};

const RUNTIME_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_ID",
];

const projectRef = process.env.TRIGGER_PROJECT_REF;
const token = process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN;
if (!projectRef || !token) throw new Error("TRIGGER_PROJECT_REF and TRIGGER_SECRET_KEY (or TRIGGER_ACCESS_TOKEN) must be set in .env");

const variables = RUNTIME_VARS.map((name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is empty in .env`);
  return { name, value };
});

const res = await fetch(`https://api.trigger.dev/api/v1/projects/${projectRef}/envvars/prod/import`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ variables, override: true }),
});
if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
console.log(`Uploaded to Trigger.dev prod: ${RUNTIME_VARS.join(", ")}`);
