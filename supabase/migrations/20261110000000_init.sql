-- Margins: initial schema.
-- Only the service role (used by the margins Edge Function) touches these tables,
-- so RLS is enabled with no policies: anon/authenticated clients get nothing.

create extension if not exists vector with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Books the reader has introduced.
create table public.books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  why_reading text,              -- what drew the reader to it, in their words
  interests text,                -- what keeps interesting them; evolves over time
  position text,                 -- free-form reading position ("ch 4", "p. 120")
  status text not null default 'reading' check (status in ('reading', 'paused', 'finished')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per Telegram chat (in practice, one reader).
create table public.chat_state (
  chat_id bigint primary key,
  active_book_id uuid references public.books (id) on delete set null,
  timezone text not null default 'America/Chicago',
  reader_profile text,           -- what kinds of questions and ideas interest the reader
  updated_at timestamptz not null default now()
);

-- Conversation transcript. book_id gives each book its own history.
create table public.messages (
  id bigserial primary key,
  chat_id bigint not null,
  book_id uuid references public.books (id) on delete set null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  telegram_message_id bigint,
  created_at timestamptz not null default now()
);
create index messages_chat_book_created_idx on public.messages (chat_id, book_id, created_at desc);

-- Reading notes. The three voices are kept apart on purpose.
create table public.notes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references public.books (id) on delete cascade,
  kind text not null check (kind in ('passage', 'reflection', 'question', 'experiment')),
  location text,                 -- where in the book, if known
  authors_words text,            -- verbatim text the reader shared from the book
  user_view text,                -- the reader's own view, as they expressed it
  agent_interpretation text,     -- Margins' reading, clearly marked as such
  open_question text,            -- an unresolved question worth returning to
  summary text not null,         -- one-line gist, used for search and listings
  embedding extensions.vector(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notes_book_idx on public.notes (book_id);
create index notes_embedding_idx on public.notes using hnsw (embedding extensions.vector_cosine_ops);

-- Links between notes. Both ends point at the original notes so they can be inspected.
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  from_note_id uuid not null references public.notes (id) on delete cascade,
  to_note_id uuid not null references public.notes (id) on delete cascade,
  relation text not null check (relation in ('echoes', 'extends', 'contrasts', 'tension', 'applies')),
  explanation text not null,     -- how they connect, including where they differ
  created_at timestamptz not null default now(),
  unique (from_note_id, to_note_id),
  check (from_note_id <> to_note_id)
);

-- Follow-ups the reader explicitly agreed to.
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  book_id uuid references public.books (id) on delete set null,
  note_id uuid references public.notes (id) on delete set null,
  kind text not null check (kind in ('revisit', 'experiment')),
  message text not null,         -- what Margins will send when it is due
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'cancelled')),
  created_at timestamptz not null default now()
);
create index follow_ups_chat_status_idx on public.follow_ups (chat_id, status, due_at);

alter table public.books enable row level security;
alter table public.chat_state enable row level security;
alter table public.messages enable row level security;
alter table public.notes enable row level security;
alter table public.connections enable row level security;
alter table public.follow_ups enable row level security;

-- Incoming Telegram messages. The primary key deduplicates Telegram's webhook retries,
-- and the status column lets each chat process one message at a time, in order.
create table public.inbox (
  update_id bigint primary key,
  chat_id bigint not null,
  telegram_message_id bigint,
  text text,
  has_photo boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'processing', 'done', 'failed')),
  error text,
  received_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index inbox_chat_status_idx on public.inbox (chat_id, status, update_id);
alter table public.inbox enable row level security;

-- Semantic search over notes.
create function public.match_notes(
  query_embedding extensions.vector(1536),
  match_count int default 8,
  filter_book_id uuid default null
)
returns table (id uuid, similarity double precision)
language sql
stable
set search_path = public, extensions
as $$
  select n.id, 1 - (n.embedding <=> query_embedding) as similarity
  from public.notes n
  where n.embedding is not null
    and (filter_book_id is null or n.book_id = filter_book_id)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

revoke execute on function public.match_notes(extensions.vector, int, uuid) from public, anon, authenticated;
grant execute on function public.match_notes(extensions.vector, int, uuid) to service_role;

-- Finishes the message a worker just handled (if any) and claims the chat's next pending message.
-- Locking the chat_state row serializes callers per chat, so exactly one worker owns a chat at a time
-- and a message that arrives mid-turn is always picked up by someone.
create function public.claim_next_message(
  p_chat_id bigint,
  p_completed_update_id bigint default null,
  p_error text default null
)
returns setof public.inbox
language plpgsql
set search_path = public
as $$
declare
  claimed public.inbox;
begin
  insert into public.chat_state (chat_id) values (p_chat_id) on conflict (chat_id) do nothing;
  perform 1 from public.chat_state where chat_id = p_chat_id for update;

  if p_completed_update_id is not null then
    update public.inbox
       set status = case when p_error is null then 'done' else 'failed' end,
           error = p_error,
           finished_at = now()
     where update_id = p_completed_update_id;
  end if;

  if exists (select 1 from public.inbox where chat_id = p_chat_id and status = 'processing') then
    return;
  end if;

  update public.inbox
     set status = 'processing', started_at = now()
   where update_id = (
     select update_id from public.inbox
      where chat_id = p_chat_id and status = 'pending'
      order by update_id
      limit 1
   )
  returning * into claimed;

  if found then
    return next claimed;
  end if;
end;
$$;

-- Marks messages stuck in 'processing' (the worker was killed) as failed and returns them,
-- so the caller can tell the reader. Takes the same per-chat lock as claim_next_message.
create function public.fail_stale_messages(p_older_than interval default interval '4 minutes')
returns setof public.inbox
language plpgsql
set search_path = public
as $$
declare
  stale public.inbox;
begin
  for stale in
    select * from public.inbox where status = 'processing' and started_at < now() - p_older_than
  loop
    perform 1 from public.chat_state where chat_id = stale.chat_id for update;
    update public.inbox
       set status = 'failed', error = 'timed out', finished_at = now()
     where update_id = stale.update_id and status = 'processing'
    returning * into stale;
    if found then
      return next stale;
    end if;
  end loop;
end;
$$;

-- Atomically claims follow-ups that are due, so overlapping ticks can't send one twice.
create function public.claim_due_follow_ups()
returns setof public.follow_ups
language sql
set search_path = public
as $$
  update public.follow_ups
     set status = 'sending'
   where id in (
     select id from public.follow_ups
      where status = 'scheduled' and due_at <= now()
      for update skip locked
   )
  returning *;
$$;

revoke execute on function public.claim_next_message(bigint, bigint, text) from public, anon, authenticated;
revoke execute on function public.fail_stale_messages(interval) from public, anon, authenticated;
revoke execute on function public.claim_due_follow_ups() from public, anon, authenticated;
grant execute on function public.claim_next_message(bigint, bigint, text) to service_role;
grant execute on function public.fail_stale_messages(interval) to service_role;
grant execute on function public.claim_due_follow_ups() to service_role;
