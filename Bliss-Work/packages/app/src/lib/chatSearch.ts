/**
 * Finding a message inside one conversation.
 *
 * The Search PAGE (routes/Search.tsx) answers "which chat, channel, person or
 * task is this?" — it never looks inside a thread, because message bodies are
 * encrypted at rest and the server has no text index to offer. What it can
 * search is what the client already holds in plaintext: the page of messages
 * this conversation has loaded, which grows every time the reader pulls in
 * older history. That is what this searches.
 *
 * `readablePrefix` rather than the raw body: an attachment message's body is
 * an envelope (see chatEnvelope), so matching it verbatim would let a search
 * for "media" hit every photo in the thread through its JSON.
 */
import { readablePrefix } from "./chatEnvelope";

export interface SearchableMessage {
  body: string;
  /** Rendered above the bubble in a channel; used so "ada" finds Ada's messages
   *  and not only messages containing the word. */
  senderName?: string;
}

/** The messages matching `query`, in their original order. An empty or
 *  whitespace-only query matches everything, so callers can pass the raw input. */
export function searchMessages<T extends SearchableMessage>(
  messages: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...messages];
  return messages.filter((m) =>
    `${readablePrefix(m.body)} ${m.senderName ?? ""}`.toLowerCase().includes(q),
  );
}
