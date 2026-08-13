/**
 * Cursor + page-merge helpers used by the reverse-infinite-scroll Inbox /
 * Thread views. Kept dependency-free so it can run inside a worker if we
 * ever need to move history hydration off the main thread at scale.
 */
import type { InboxItemDTO, MessageDTO } from "@taskboard/shared";

/** Inbox cursor encodes (lastEventAt, refId). Decoders are server-side; the
 *  renderer just needs to derive the next cursor from a page tail. */
export function nextInboxCursor(items: InboxItemDTO[]): string | undefined {
  const last = items[items.length - 1];
  if (!last) return undefined;
  return btoa(JSON.stringify({ ts: last.lastEventAt, refId: last.refId }));
}

/** Merge a newly-fetched older page into the existing seq-asc page array,
 *  deduping by id. Older messages prepend; equal seq is dropped. */
export function mergeOlderMessages(existing: MessageDTO[], older: MessageDTO[]): MessageDTO[] {
  if (!older.length) return existing;
  const seen = new Set(existing.map((m) => m.id));
  const fresh = older.filter((m) => !seen.has(m.id));
  return [...fresh, ...existing].sort((a, b) => a.seq - b.seq);
}

/** Insert a single new message (typically arriving over WS) into a seq-asc
 *  page, deduping by id. */
export function appendMessage(existing: MessageDTO[], m: MessageDTO): MessageDTO[] {
  if (existing.some((e) => e.id === m.id)) return existing;
  const next = [...existing, m];
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

/** Replace an optimistic (temp:) message with its real server-side counterpart. */
export function reconcileOptimistic(
  existing: MessageDTO[],
  clientMsgId: string,
  real: MessageDTO,
): MessageDTO[] {
  const next = existing.filter((m) => m.id !== `temp:${clientMsgId}`);
  if (!next.some((m) => m.id === real.id)) next.push(real);
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

/** Lowest seq currently in the page — used as the next beforeSeq query. */
export function oldestSeq(messages: MessageDTO[]): number | undefined {
  return messages[0]?.seq;
}
