import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

let client: SupabaseClient | undefined;

export function db(): SupabaseClient {
  client ??= createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/** Throws on a Supabase error, otherwise returns the data. */
export function unwrap<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  why_reading: string | null;
  interests: string | null;
  position: string | null;
  status: "reading" | "paused" | "finished";
  created_at: string;
  updated_at: string;
}

export interface ChatState {
  chat_id: number;
  active_book_id: string | null;
  timezone: string;
  reader_profile: string | null;
}

export interface Note {
  id: string;
  book_id: string | null;
  kind: "passage" | "reflection" | "question" | "experiment";
  location: string | null;
  authors_words: string | null;
  user_view: string | null;
  agent_interpretation: string | null;
  open_question: string | null;
  summary: string;
  created_at: string;
}

export interface FollowUp {
  id: string;
  chat_id: number;
  book_id: string | null;
  note_id: string | null;
  kind: "revisit" | "experiment";
  message: string;
  due_at: string;
  trigger_run_id: string | null;
  status: "scheduled" | "sent" | "cancelled";
}

export const NOTE_COLUMNS =
  "id, book_id, kind, location, authors_words, user_view, agent_interpretation, open_question, summary, created_at";

export async function getChatState(chatId: number): Promise<ChatState> {
  const existing = unwrap(
    await db().from("chat_state").select("chat_id, active_book_id, timezone, reader_profile").eq("chat_id", chatId).maybeSingle(),
    "load chat state",
  );
  if (existing) return existing as ChatState;
  return unwrap(
    await db().from("chat_state").insert({ chat_id: chatId }).select("chat_id, active_book_id, timezone, reader_profile").single(),
    "create chat state",
  ) as ChatState;
}

export async function setActiveBook(chatId: number, bookId: string | null): Promise<void> {
  unwrap(
    await db().from("chat_state").update({ active_book_id: bookId, updated_at: new Date().toISOString() }).eq("chat_id", chatId),
    "set active book",
  );
}

export async function listBooks(): Promise<Book[]> {
  return unwrap(await db().from("books").select("*").order("updated_at", { ascending: false }), "list books") as Book[];
}

/** Recent transcript for one book (or for general chat when bookId is null), oldest first. */
export async function recentMessages(
  chatId: number,
  bookId: string | null,
  limit: number,
): Promise<{ role: "user" | "assistant"; content: string; created_at: string }[]> {
  let query = db().from("messages").select("role, content, created_at").eq("chat_id", chatId);
  query = bookId ? query.eq("book_id", bookId) : query.is("book_id", null);
  const rows = unwrap(await query.order("created_at", { ascending: false }).limit(limit), "load messages");
  return (rows as { role: "user" | "assistant"; content: string; created_at: string }[]).reverse();
}

export async function saveMessage(row: {
  chat_id: number;
  book_id: string | null;
  role: "user" | "assistant";
  content: string;
  telegram_message_id?: number | null;
}): Promise<number> {
  const inserted = unwrap(await db().from("messages").insert(row).select("id").single(), "save message") as { id: number };
  return inserted.id;
}
