# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Margins is

Margins is a personal reading companion that the reader talks to over Telegram. The product spec is `requirement.md`; read it before you make design decisions. The success test for V1 is *did it make the reader want to return to a book or think longer about something they read?* Put conversation quality ahead of features.

## Commands

All scripts read secrets from `.env` (gitignored; `.env.example` lists the names).

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over `src`, `scripts` and `trigger.config.ts`. There are no tests yet. |
| `npm run dev` | Runs tasks locally against the Trigger.dev dev environment. |
| `npm run migrate` | Applies any unapplied `supabase/migrations/*.sql` through the Supabase Management API and records them in `public.schema_migrations`. |
| `npm run push-env` | Uploads the runtime secrets the tasks need into Trigger.dev **prod**. |
| `npm run deploy:trigger` | Deploys the tasks to Trigger.dev prod. CI does the same on every push to `main` (`.github/workflows/deploy.yml`). |
| `npm run deploy:webhook` | Sets the webhook function's secrets and deploys `supabase/functions/telegram-webhook`. |
| `npm run set-webhook` | Points the Telegram bot at the deployed webhook function. |

## Architecture

```
Telegram ──webhook──▶ Supabase Edge Function (telegram-webhook, Deno)
                         │  checks the secret header and the allowed chat id
                         ▼  POST /api/v1/tasks/handle-telegram-message/trigger
                      Trigger.dev task handle-telegram-message (src/trigger)
                         │  runTurn(): Claude tool runner + DB-backed tools
                         ├─▶ Supabase Postgres + pgvector (memory)
                         ├─▶ OpenAI text-embedding-3-small (note embeddings only)
                         └─▶ Telegram sendMessage (reply)
schedule_follow_up tool ──▶ delayed run of deliver-follow-up ──▶ Telegram
```

- **Ordering and deduplication:** the webhook triggers with `concurrencyKey = chatId` (the task has `concurrency: { perKey: 1 }`) and `idempotencyKey = telegram update id`. Telegram retries on non-2xx responses, and the idempotency key keeps a retry from creating a second run.
- **No whole-run retries on messages:** `handle-telegram-message` has `maxAttempts: 1` because a retry after the reply was sent would message the reader twice. The Anthropic SDK retries transient API errors on its own. The user and assistant messages are saved only after a successful turn.
- **The agent (`src/agent/`):** `run.ts` calls `client.beta.messages.toolRunner` with `claude-opus-5-5`, adaptive thinking, effort `medium`, `max_iterations: 12`, and server-side refusal fallbacks (`fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta).
  - The system prompt has two blocks. `PERSONA` in `prompt.ts` is static and cached; keep it byte-stable and put anything that changes per turn in `buildContext()`. The second block is `buildContext()`'s output: current time in the reader's timezone, the books on record, the reader profile and scheduled follow-ups.
- **History:** history is plain text only (`messages` table), scoped per book via `chat_state.active_book_id`. Tool calls and thinking blocks are never stored or replayed across turns. Tools mutate a per-turn `TurnContext`. When the agent switches books, the exchange is filed under the book the turn ended on.
- **Tools (`src/agent/tools.ts`):** `betaZodTool` definitions that return JSON strings. A thrown error becomes an `is_error` tool result.
- **Follow-ups:** `schedule_follow_up` inserts a `follow_ups` row and triggers `deliver-follow-up` with `delay: Date`. Cancelling sets the status to `cancelled` and calls `runs.cancel`. The delivery task re-checks the status anyway, so a cancel that loses a race still does nothing.

## Data model invariants

Schema: `supabase/migrations/`. RLS is enabled with no policies, so only the service role can access the tables.

- A note keeps three voices apart: `authors_words` (verbatim from the book), `user_view` (only what the reader said) and `agent_interpretation`. Never merge them.
- `connections` reference both original notes (ON DELETE CASCADE), so every connection can be traced back to the notes it joins.
- "Forget that" deletes for real. Forgetting a book deletes its notes and its messages.
- Embeddings are 1536-dimensional (`text-embedding-3-small`). If you change the embedding model, write a migration and re-embed all notes.

## Conventions

- Replies are plain text; Telegram shows markdown literally. The persona prompt enforces this.
- Persona rules that matter: one question at a time, leave room for the reader's own interpretation, no spoilers past the recorded reading position, and follow-ups only after an explicit yes.
- V1 scope excludes page photos and proactive resurfacing. The task replies to photos with a fixed message.
