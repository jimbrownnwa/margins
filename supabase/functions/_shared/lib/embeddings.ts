import OpenAI from "openai";
import { requireEnv } from "./env.ts";

// OpenAI is used only for embeddings (finding related notes). All conversation runs on Claude.
const MODEL = "text-embedding-3-small"; // 1536 dimensions, matches notes.embedding

let client: OpenAI | undefined;

export async function embed(text: string): Promise<number[]> {
  client ??= new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  const res = await client.embeddings.create({ model: MODEL, input: text.slice(0, 8000) });
  return res.data[0]!.embedding;
}

/** The text a note is embedded from: every voice, labelled, so search can match any of them. */
export function noteEmbeddingText(note: {
  summary: string;
  authors_words?: string | null;
  user_view?: string | null;
  agent_interpretation?: string | null;
  open_question?: string | null;
}): string {
  return [
    note.summary,
    note.authors_words && `Author: ${note.authors_words}`,
    note.user_view && `Reader: ${note.user_view}`,
    note.agent_interpretation && `Interpretation: ${note.agent_interpretation}`,
    note.open_question && `Open question: ${note.open_question}`,
  ]
    .filter(Boolean)
    .join("\n");
}
