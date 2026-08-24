/**
 * Cursor + page-merge helpers used by the reverse-infinite-scroll Inbox /
 * Thread views. Kept dependency-free so it can run inside a worker if we
 * ever need to move history hydration off the main thread at scale.
 */
import type { MessageDTO } from "@taskboard/shared";

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
