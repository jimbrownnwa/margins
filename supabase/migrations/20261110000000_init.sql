-- Margins: initial schema.
-- Only the service role (used by the Trigger.dev tasks) touches these tables,
-- so RLS is enabled with no policies: anon/authenticated clients get nothing.

create extension if not exists vector with schema extensions;

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
  trigger_run_id text,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'cancelled')),
  created_at timestamptz not null default now()
);
create index follow_ups_chat_status_idx on public.follow_ups (chat_id, status, due_at);

alter table public.books enable row level security;
alter table public.chat_state enable row level security;
alter table public.messages enable row level security;
alter table public.notes enable row level security;
alter table public.connections enable row level security;
alter table public.follow_ups enable row level security;

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
