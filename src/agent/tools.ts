import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { runs, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { db, NOTE_COLUMNS, recentMessages, setActiveBook, unwrap, type Book, type FollowUp, type Note } from "../lib/db";
import { embed, noteEmbeddingText } from "../lib/embeddings";
import { formatInZone } from "./prompt";

/** Per-turn state the tools read and update. */
export interface TurnContext {
  chatId: number;
  activeBookId: string | null;
  timezone: string;
}

const uuid = z.string().uuid();
const MAX_FOLLOW_UP_DAYS = 365;

function json(value: unknown): string {
  return JSON.stringify(value);
}

async function bookTitles(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const rows = unwrap(await db().from("books").select("id, title").in("id", unique), "load book titles") as { id: string; title: string }[];
  return new Map(rows.map((r) => [r.id, r.title]));
}

async function connectionsFor(noteIds: string[]) {
  if (noteIds.length === 0) return [];
  const list = noteIds.join(",");
  return unwrap(
    await db()
      .from("connections")
      .select("id, from_note_id, to_note_id, relation, explanation")
      .or(`from_note_id.in.(${list}),to_note_id.in.(${list})`),
    "load connections",
  ) as { id: string; from_note_id: string; to_note_id: string; relation: string; explanation: string }[];
}

async function describeNotes(notes: Note[], extra?: Map<string, Record<string, unknown>>) {
  const titles = await bookTitles(notes.map((n) => n.book_id));
  return notes.map((n) => ({
    ...n,
    book_title: n.book_id ? titles.get(n.book_id) ?? null : null,
    ...(extra?.get(n.id) ?? {}),
  }));
}

export function makeTools(ctx: TurnContext) {
  const addBook = betaZodTool({
    name: "add_book",
    description:
      "Record a book the reader has started or wants to discuss, and make it the active book. Check the books on record first so you don't add a duplicate.",
    inputSchema: z.object({
      title: z.string().min(1),
      author: z.string().optional(),
      why_reading: z.string().optional().describe("What drew them to it, if they've said."),
      position: z.string().optional().describe("Where they are, e.g. 'chapter 3' or 'p. 112'."),
    }),
    run: async (input) => {
      const book = unwrap(
        await db()
          .from("books")
          .insert({ title: input.title, author: input.author ?? null, why_reading: input.why_reading ?? null, position: input.position ?? null })
          .select("id, title")
          .single(),
        "add book",
      ) as { id: string; title: string };
      await setActiveBook(ctx.chatId, book.id);
      ctx.activeBookId = book.id;
      return json({ added: book, active: true });
    },
  });

  const updateBook = betaZodTool({
    name: "update_book",
    description:
      "Update a book's details: reading position, what drew them to it, what interests them about it, status, title or author. Only pass fields that changed. 'interests' replaces the old value, so carry forward anything still true.",
    inputSchema: z.object({
      book_id: uuid,
      title: z.string().optional(),
      author: z.string().optional(),
      position: z.string().optional(),
      why_reading: z.string().optional(),
      interests: z.string().optional(),
      status: z.enum(["reading", "paused", "finished"]).optional(),
    }),
    run: async ({ book_id, ...fields }) => {
      const updated = unwrap(
        await db()
          .from("books")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", book_id)
          .select("id, title, position, status")
          .maybeSingle(),
        "update book",
      );
      return updated ? json({ updated }) : json({ error: "No book with that id." });
    },
  });

  const switchBook = betaZodTool({
    name: "switch_book",
    description:
      "Make a different book the active one (or pass null for general conversation not about any one book). Returns that book's recent conversation so you can pick up where you left off.",
    inputSchema: z.object({ book_id: uuid.nullable() }),
    run: async ({ book_id }) => {
      let book: Pick<Book, "id" | "title" | "position"> | null = null;
      if (book_id) {
        book = unwrap(await db().from("books").select("id, title, position").eq("id", book_id).maybeSingle(), "load book");
        if (!book) return json({ error: "No book with that id." });
      }
      await setActiveBook(ctx.chatId, book_id);
      ctx.activeBookId = book_id;
      const history = await recentMessages(ctx.chatId, book_id, 12);
      return json({ active_book: book, recent_conversation: history });
    },
  });

  const saveNote = betaZodTool({
    name: "save_note",
    description:
      "Save a reading note worth keeping: a passage, a reflection, an open question, or an experiment they chose. Keep the voices apart: authors_words is verbatim text from the book that the reader shared; user_view is only what the reader said or clearly agreed with; agent_interpretation is your reading. Leave out any field that doesn't apply.",
    inputSchema: z.object({
      book_id: uuid.nullable().describe("The book this note belongs to, or null if it isn't about a specific book."),
      kind: z.enum(["passage", "reflection", "question", "experiment"]),
      summary: z.string().min(1).describe("One sentence capturing the idea, for search and listings."),
      location: z.string().optional().describe("Where in the book, if known."),
      authors_words: z.string().optional(),
      user_view: z.string().optional(),
      agent_interpretation: z.string().optional(),
      open_question: z.string().optional(),
    }),
    run: async (input) => {
      const embedding = await embed(noteEmbeddingText(input));
      const note = unwrap(
        await db()
          .from("notes")
          .insert({
            book_id: input.book_id,
            kind: input.kind,
            summary: input.summary,
            location: input.location ?? null,
            authors_words: input.authors_words ?? null,
            user_view: input.user_view ?? null,
            agent_interpretation: input.agent_interpretation ?? null,
            open_question: input.open_question ?? null,
            embedding,
          })
          .select("id, summary")
          .single(),
        "save note",
      );
      return json({ saved: note });
    },
  });

  const updateNote = betaZodTool({
    name: "update_note",
    description:
      "Correct a saved note, for example when the reader says 'that's not what I meant'. Only pass fields that change; pass an empty string to clear a field.",
    inputSchema: z.object({
      note_id: uuid,
      summary: z.string().optional(),
      location: z.string().optional(),
      authors_words: z.string().optional(),
      user_view: z.string().optional(),
      agent_interpretation: z.string().optional(),
      open_question: z.string().optional(),
    }),
    run: async ({ note_id, ...changes }) => {
      const current = unwrap(await db().from("notes").select(NOTE_COLUMNS).eq("id", note_id).maybeSingle(), "load note") as Note | null;
      if (!current) return json({ error: "No note with that id." });
      const patch: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) patch[key] = value === "" && key !== "summary" ? null : value;
      }
      const merged = { ...current, ...patch };
      const embedding = await embed(noteEmbeddingText(merged));
      const updated = unwrap(
        await db()
          .from("notes")
          .update({ ...patch, embedding, updated_at: new Date().toISOString() })
          .eq("id", note_id)
          .select(NOTE_COLUMNS)
          .single(),
        "update note",
      );
      return json({ updated });
    },
  });

  const searchNotes = betaZodTool({
    name: "search_notes",
    description:
      "Search the reader's saved notes by meaning, across all books or within one. Use it before claiming a connection to earlier reading, and to find something they refer to. Results include similarity scores (1 is identical) and any existing connections; treat low scores as unrelated.",
    inputSchema: z.object({
      query: z.string().min(1).describe("The idea to look for, phrased as a sentence."),
      book_id: uuid.optional().describe("Limit the search to one book."),
      limit: z.number().int().min(1).max(15).optional(),
    }),
    run: async ({ query, book_id, limit }) => {
      const embedding = await embed(query);
      const matches = unwrap(
        await db().rpc("match_notes", { query_embedding: embedding, match_count: limit ?? 8, filter_book_id: book_id ?? null }),
        "search notes",
      ) as { id: string; similarity: number }[];
      if (matches.length === 0) return json({ results: [], note: "No saved notes yet." });
      const ids = matches.map((m) => m.id);
      const notes = unwrap(await db().from("notes").select(NOTE_COLUMNS).in("id", ids), "load notes") as Note[];
      const scores = new Map(matches.map((m) => [m.id, { similarity: Number(m.similarity.toFixed(3)) }]));
      const described = await describeNotes(notes, scores);
      described.sort((a, b) => (scores.get(b.id)!.similarity ?? 0) - (scores.get(a.id)!.similarity ?? 0));
      return json({ results: described, connections: await connectionsFor(ids) });
    },
  });

  const connectNotes = betaZodTool({
    name: "connect_notes",
    description:
      "Record a connection between two saved notes, after you've shared it with the reader. The explanation should say how they connect and where they differ.",
    inputSchema: z.object({
      from_note_id: uuid,
      to_note_id: uuid,
      relation: z.enum(["echoes", "extends", "contrasts", "tension", "applies"]),
      explanation: z.string().min(1),
    }),
    run: async (input) => {
      if (input.from_note_id === input.to_note_id) return json({ error: "A note can't connect to itself." });
      const { data, error } = await db()
        .from("connections")
        .upsert(input, { onConflict: "from_note_id,to_note_id" })
        .select("id")
        .single();
      if (error) return json({ error: `Could not save the connection: ${error.message}` });
      return json({ connected: data });
    },
  });

  const showMemory = betaZodTool({
    name: "show_memory",
    description:
      "Look up what you remember, for when the reader asks what you remember or wants to review. Returns books, notes (with all three voices), connections and scheduled follow-ups, for one book or everything.",
    inputSchema: z.object({ book_id: uuid.optional() }),
    run: async ({ book_id }) => {
      let booksQuery = db().from("books").select("id, title, author, position, status, why_reading, interests");
      if (book_id) booksQuery = booksQuery.eq("id", book_id);
      const books = unwrap(await booksQuery, "load books");
      let notesQuery = db().from("notes").select(NOTE_COLUMNS);
      if (book_id) notesQuery = notesQuery.eq("book_id", book_id);
      const notes = unwrap(await notesQuery.order("created_at", { ascending: false }).limit(60), "load notes") as Note[];
      const followUps = unwrap(
        await db().from("follow_ups").select("id, kind, message, due_at, book_id").eq("chat_id", ctx.chatId).eq("status", "scheduled"),
        "load follow-ups",
      ) as Pick<FollowUp, "id" | "kind" | "message" | "due_at" | "book_id">[];
      return json({
        books,
        notes: await describeNotes(notes),
        connections: await connectionsFor(notes.map((n) => n.id)),
        scheduled_follow_ups: followUps
          .filter((f) => !book_id || f.book_id === book_id)
          .map((f) => ({ ...f, due_local: formatInZone(new Date(f.due_at), ctx.timezone) })),
        truncated: notes.length === 60,
      });
    },
  });

  const forget = betaZodTool({
    name: "forget",
    description:
      "Permanently forget something when the reader asks: a note, a connection, or a whole book. Forgetting a book also deletes its notes and its conversation history, so confirm with the reader before forgetting a book. To stop a follow-up use cancel_follow_up instead.",
    inputSchema: z.object({
      target: z.enum(["note", "connection", "book"]),
      id: uuid,
    }),
    run: async ({ target, id }) => {
      if (target === "book") {
        unwrap(await db().from("messages").delete().eq("book_id", id), "delete book messages");
        const deleted = unwrap(await db().from("books").delete().eq("id", id).select("title"), "delete book") as { title: string }[];
        if (ctx.activeBookId === id) ctx.activeBookId = null;
        return json(deleted.length ? { forgotten: { book: deleted[0]!.title } } : { error: "No book with that id." });
      }
      const table = target === "note" ? "notes" : "connections";
      const columns = target === "note" ? "summary" : "explanation";
      const deleted = unwrap(await db().from(table).delete().eq("id", id).select(columns), `delete ${target}`) as unknown[];
      return json(deleted.length ? { forgotten: deleted[0] } : { error: `No ${target} with that id.` });
    },
  });

  const scheduleFollowUp = betaZodTool({
    name: "schedule_follow_up",
    description:
      "Schedule a follow-up message the reader has explicitly agreed to, at a time they chose or confirmed. Write the message exactly as it should arrive: warm, short, plain text, one question at most. due_at must be an ISO 8601 timestamp with a UTC offset, computed from the reader's local time.",
    inputSchema: z.object({
      kind: z.enum(["revisit", "experiment"]),
      message: z.string().min(1),
      due_at: z.string().describe("e.g. 2026-11-11T09:00:00-06:00"),
      book_id: uuid.nullable().optional(),
      note_id: uuid.optional().describe("The note this follows up on, if any."),
    }),
    run: async (input) => {
      const due = new Date(input.due_at);
      const now = Date.now();
      if (Number.isNaN(due.getTime())) return json({ error: "due_at is not a valid timestamp." });
      if (due.getTime() < now + 60_000) return json({ error: "due_at must be in the future." });
      if (due.getTime() > now + MAX_FOLLOW_UP_DAYS * 86_400_000) return json({ error: "due_at is too far away (max one year)." });

      const row = unwrap(
        await db()
          .from("follow_ups")
          .insert({
            chat_id: ctx.chatId,
            kind: input.kind,
            message: input.message,
            due_at: due.toISOString(),
            book_id: input.book_id ?? ctx.activeBookId,
            note_id: input.note_id ?? null,
          })
          .select("id")
          .single(),
        "save follow-up",
      ) as { id: string };

      const handle = await tasks.trigger("deliver-follow-up", { followUpId: row.id }, { delay: due });
      unwrap(await db().from("follow_ups").update({ trigger_run_id: handle.id }).eq("id", row.id), "store run id");
      return json({ scheduled: { id: row.id, due_local: formatInZone(due, ctx.timezone) } });
    },
  });

  const cancelFollowUp = betaZodTool({
    name: "cancel_follow_up",
    description: "Cancel a scheduled follow-up.",
    inputSchema: z.object({ follow_up_id: uuid }),
    run: async ({ follow_up_id }) => {
      const row = unwrap(
        await db().from("follow_ups").select("id, status, trigger_run_id").eq("id", follow_up_id).maybeSingle(),
        "load follow-up",
      ) as Pick<FollowUp, "id" | "status" | "trigger_run_id"> | null;
      if (!row) return json({ error: "No follow-up with that id." });
      if (row.status !== "scheduled") return json({ error: `That follow-up is already ${row.status}.` });
      unwrap(await db().from("follow_ups").update({ status: "cancelled" }).eq("id", follow_up_id), "cancel follow-up");
      if (row.trigger_run_id) {
        try {
          await runs.cancel(row.trigger_run_id);
        } catch {
          // The delivery task also checks status, so a run that can't be cancelled will do nothing.
        }
      }
      return json({ cancelled: follow_up_id });
    },
  });

  const updateReaderProfile = betaZodTool({
    name: "update_reader_profile",
    description:
      "Rewrite the short profile of what kinds of questions, ideas and conversation the reader enjoys or doesn't. Replaces the old profile, so carry forward what's still true. Keep it under about 120 words.",
    inputSchema: z.object({ profile: z.string().min(1) }),
    run: async ({ profile }) => {
      unwrap(await db().from("chat_state").update({ reader_profile: profile }).eq("chat_id", ctx.chatId), "update profile");
      return json({ updated: true });
    },
  });

  const setTimezone = betaZodTool({
    name: "set_timezone",
    description: "Set the reader's timezone when they tell you where they are, as an IANA name like 'America/New_York'.",
    inputSchema: z.object({ timezone: z.string() }),
    run: async ({ timezone }) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        return json({ error: "Not a valid IANA timezone name." });
      }
      unwrap(await db().from("chat_state").update({ timezone }).eq("chat_id", ctx.chatId), "set timezone");
      ctx.timezone = timezone;
      return json({ timezone, local_time_now: formatInZone(new Date(), timezone) });
    },
  });

  return [
    addBook,
    updateBook,
    switchBook,
    saveNote,
    updateNote,
    searchNotes,
    connectNotes,
    showMemory,
    forget,
    scheduleFollowUp,
    cancelFollowUp,
    updateReaderProfile,
    setTimezone,
  ];
}
