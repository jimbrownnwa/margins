# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Margins is

Margins is a personal reading companion that the reader talks to over Telegram. The product spec is `requirement.md`; read it before you make design decisions. The success test for V1 is *did it make the reader want to return to a book or think longer about something they read?* Put conversation quality ahead of features.

Everything runs on Supabase: one Deno Edge Function (`margins`), Postgres with pgvector, and pg_cron. The spec mentions Trigger.dev, but the project moved off it because Trigger.dev refused deployments for new free organizations.

## Commands

The npm scripts read secrets from `.env` (gitignored; `.env.example` lists the names). There are no npm dependencies: Deno is fetched through `npx`, and the scripts use only Node built-ins.

| Command | What it does |
|---|---|
| `npm run check` | Typechecks the Edge Function and everything it imports, using Deno and the import map in `supabase/functions/margins/deno.json`. There are no tests yet. |
| `npm run migrate` | Applies unapplied `supabase/migrations/*.sql` through the Supabase Management API (needs `SUPABASE_ACCESS_TOKEN`) and records them in `public.schema_migrations`. Add new migrations as new files; never edit an applied one. |
| `npm run deploy` | Sets the function secrets, deploys `margins` (`--no-verify-jwt --use-api`), creates or updates the `margins-tick` cron job and its Vault secrets, and registers the Telegram webhook. Safe to re-run. |

Dependency versions are pinned in `deno.json`. Deno refuses npm versions published in the last 24 hours (its minimum dependency age). Pin to an older version rather than turning that check off.

## Architecture

```
Telegram ─▶ POST /functions/v1/margins/telegram
              checks the secret header and the allowed chat id
              upserts the message into inbox (update_id is the PK, so Telegram retries are no-ops)
              responds 200 at once; EdgeRuntime.waitUntil(drainChat(chatId))

drainChat:  loop claim_next_message(chat) ─▶ runTurn() ─▶ save messages ─▶ Telegram reply

pg_cron (every minute) ─▶ POST /functions/v1/margins/tick   (x-cron-secret header)
              fail_stale_messages() + apologize ─▶ resume chats with old pending messages
              ─▶ claim_due_follow_ups() ─▶ send ─▶ mark sent
```

- **Per-chat ordering:** `claim_next_message` (plpgsql) locks the chat's `chat_state` row. It marks the previous message done or failed and claims the next pending one, and it refuses to claim while another message is `processing`. This guarantees one worker per chat, and a message that arrives mid-turn is always picked up by the current worker or by the next tick.
- **Time limits:** Edge Functions have a wall-clock limit (150s on the free plan), and that limit covers background work too. The Anthropic client uses `timeout: 90_000, maxRetries: 1`. If a worker is killed, the message stays `processing` until the tick marks it `failed` (after 4 minutes) and sends the reader an apology.
- **Cron wiring:** the tick URL and `CRON_SECRET` are stored in Supabase Vault (`margins_tick_url`, `margins_cron_secret`), and the cron job reads them from there. `scripts/deploy.mjs` writes them, so neither appears in a migration.
- **The agent (`supabase/functions/_shared/agent/`):** `run.ts` calls `client.beta.messages.toolRunner` with `claude-opus-5-5`, adaptive thinking, effort `medium`, `max_iterations: 12`, and server-side refusal fallbacks (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta).
  - The system prompt has two blocks. `PERSONA` in `prompt.ts` is static and cached; keep it byte-stable and put anything that changes per turn in `buildContext()`. The second block is `buildContext()`'s output: current time in the reader's timezone, the books on record, the reader profile and scheduled follow-ups.
- **History:** history is plain text only (`messages` table), scoped per book via `chat_state.active_book_id`. Tool calls and thinking blocks are never stored or replayed across turns. Tools mutate a per-turn `TurnContext`. The exchange is saved only after a successful turn, filed under the book the turn ended on.
- **Tools (`_shared/agent/tools.ts`):** `betaZodTool` definitions that return JSON strings. A thrown error becomes an `is_error` tool result. `schedule_follow_up` only inserts a row; the tick delivers it. A cancel sets the status to `cancelled`, and the tick only claims rows that are still `scheduled`.
- **Imports:** Deno-style, with explicit `.ts` extensions; bare package names resolve through `deno.json`. Read settings with `Deno.env.get`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into the function automatically. The other secrets come from `npm run deploy`.

## Data model invariants

Schema: `supabase/migrations/`. RLS is enabled with no policies, so only the service role can access the tables. The security advisor's `rls_enabled_no_policy` notices are expected.

- A note keeps three voices apart: `authors_words` (verbatim from the book), `user_view` (only what the reader said) and `agent_interpretation`. Never merge them.
- `connections` reference both original notes (ON DELETE CASCADE), so every connection can be traced back to the notes it joins.
- "Forget that" deletes for real. Forgetting a book deletes its notes and its messages.
- Embeddings use OpenAI `text-embedding-3-small` (1536 dimensions); OpenAI is used for nothing else. If you change the embedding model, write a migration and re-embed all notes.

## Conventions

- Replies are plain text; Telegram shows markdown literally. The persona prompt enforces this.
- Persona rules that matter: one question at a time, leave room for the reader's own interpretation, no spoilers past the recorded reading position, and follow-ups only after an explicit yes.
- V1 scope excludes page photos and proactive resurfacing. The worker replies to photos with a fixed message.
