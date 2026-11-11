// Applies SQL files in supabase/migrations that haven't run yet, via the Supabase Management API.
// Tracks applied files in public.schema_migrations. Usage: npm run migrate
import { readdir, readFile } from "node:fs/promises";

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_URL?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
if (!token || !ref) throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_URL (https://<ref>.supabase.co) must be set in .env");

async function query(sql: string): Promise<any[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Query failed (${res.status}): ${body}`);
  return JSON.parse(body);
}

await query(
  "create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now());" +
    "alter table public.schema_migrations enable row level security;",
);
const applied = new Set((await query("select name from public.schema_migrations")).map((r) => r.name as string));
const files = (await readdir("supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

for (const file of files) {
  if (applied.has(file)) continue;
  const sql = await readFile(`supabase/migrations/${file}`, "utf8");
  await query(`begin;\n${sql}\ninsert into public.schema_migrations (name) values ('${file.replace(/'/g, "''")}');\ncommit;`);
  console.log(`applied ${file}`);
}
console.log("migrations up to date");
