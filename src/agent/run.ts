import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@trigger.dev/sdk";
import { db, getChatState, listBooks, recentMessages, unwrap, type FollowUp } from "../lib/db";
import { buildContext, PERSONA } from "./prompt";
import { makeTools, type TurnContext } from "./tools";

const MODEL = "claude-opus-5-5";
const HISTORY_LIMIT = 40;

let client: Anthropic | undefined;

export interface TurnResult {
  reply: string;
  /** The active book after the turn; tools may have switched it. */
  bookId: string | null;
}

export async function runTurn(chatId: number, userText: string): Promise<TurnResult> {
  client ??= new Anthropic();

  const state = await getChatState(chatId);
  const [books, followUps, history] = await Promise.all([
    listBooks(),
    db()
      .from("follow_ups")
      .select("*")
      .eq("chat_id", chatId)
      .eq("status", "scheduled")
      .order("due_at")
      .then((r) => unwrap(r, "load follow-ups") as FollowUp[]),
    recentMessages(chatId, state.active_book_id, HISTORY_LIMIT),
  ]);

  // The API requires the first message to be from the user; drop any leading assistant turns
  // (for example a follow-up that opened a thread).
  while (history.length > 0 && history[0]!.role === "assistant") history.shift();

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const ctx: TurnContext = { chatId, activeBookId: state.active_book_id, timezone: state.timezone };

  const final = await client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If a safety classifier declines a turn, the API retries it on a fallback model instead of failing.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [
      { type: "text", text: PERSONA, cache_control: { type: "ephemeral" } },
      { type: "text", text: buildContext({ state, books, followUps, now: new Date() }) },
    ],
    tools: makeTools(ctx),
    messages,
    max_iterations: 12,
  });

  logger.info("turn finished", {
    stop_reason: final.stop_reason,
    usage: final.usage,
    model: final.model,
  });

  const text = final.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  let reply = text;
  if (final.stop_reason === "refusal") {
    reply = "I'm not able to continue with that one. Want to pick up somewhere else in the book?";
  } else if (!reply) {
    reply = "I lost my thread there. Could you say that again?";
  }

  return { reply, bookId: ctx.activeBookId };
}
